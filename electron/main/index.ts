import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import type { CodexAuthStatus, CreateTaskInput, EventRecord, UpdateProjectInput } from '../../src/shared/types'
import { CodexAuthManager, resolveCodexCommand } from './codex-auth'
import { inspectProject } from './project-inspector'
import { AgentRunner } from './runner'
import { shutdownResources } from './shutdown'
import { AppStore } from './store'

const execFileAsync = promisify(execFile)
const currentDirectory = dirname(fileURLToPath(import.meta.url))

const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  prompt: z.string().trim().min(10).max(20_000),
  maxAttempts: z.number().int().min(1).max(5)
})

const updateProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  testCommand: z.string().trim().max(500)
})

const addNoteSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000)
})

const updateNoteSchema = z.object({
  noteId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000)
})

const findingStateSchema = z.object({
  findingId: z.string().uuid(),
  resolved: z.boolean()
})

let mainWindow: BrowserWindow | null = null
let store: AppStore | null = null
let runner: AgentRunner | null = null
let codexAuth: CodexAuthManager | null = null
let shutdownStarted = false
const smokeTest = process.env.AGENT_MONITORING_SMOKE_TEST === '1'

if (smokeTest && process.env.AGENT_MONITORING_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.AGENT_MONITORING_SMOKE_USER_DATA)
}

const hasSingleInstanceLock = smokeTest || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

if (hasSingleInstanceLock && !smokeTest) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function publish(event: EventRecord): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runner:event', event)
}

function publishAuth(status: CodexAuthStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('codex-auth:changed', status)
}

function requireStore(): AppStore {
  if (!store) throw new Error('데이터베이스가 준비되지 않았습니다.')
  return store
}

function requireRunner(): AgentRunner {
  if (!runner) throw new Error('실행기가 준비되지 않았습니다.')
  return runner
}

function requireCodexAuth(): CodexAuthManager {
  if (!codexAuth) throw new Error('Codex 인증 관리자가 준비되지 않았습니다.')
  return codexAuth
}

async function shutdownApplication(): Promise<void> {
  const activeRunner = runner
  const activeCodexAuth = codexAuth
  const activeStore = store
  runner = null
  codexAuth = null

  try {
    await shutdownResources({ runner: activeRunner, codexAuth: activeCodexAuth, store: activeStore })
  } finally {
    if (store === activeStore) store = null
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#0b0e10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 15, y: 14 },
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  if (smokeTest) {
    ipcMain.once('preload:ready', () => {
      console.log('PRELOAD_BRIDGE_READY')
      setImmediate(() => app.exit(0))
    })
  }

  ipcMain.handle('codex-auth:status', () => requireCodexAuth().status())

  ipcMain.handle('codex-auth:login', () =>
    requireCodexAuth().login(async (url) => {
      await shell.openExternal(url)
    })
  )

  ipcMain.handle('codex-auth:cancel', () => requireCodexAuth().cancelLogin())
  ipcMain.handle('codex-auth:logout', () => requireCodexAuth().logout())

  ipcMain.handle('dashboard:snapshot', (_event, projectId?: string) => requireStore().getSnapshot(projectId))

  ipcMain.handle('project:add', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Git 프로젝트 선택',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const projectPath = result.filePaths[0]
    try {
      await execFileAsync('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree'])
    } catch {
      throw new Error('선택한 폴더는 Git 저장소가 아닙니다.')
    }
    return requireStore().addProject(basename(projectPath), projectPath)
  })

  ipcMain.handle('project:update', (_event, rawInput: UpdateProjectInput) => {
    const input = updateProjectSchema.parse(rawInput)
    return requireStore().updateProject(input)
  })

  ipcMain.handle('project:inspect', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return inspectProject(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('project:remove', async (_event, projectId: string) => {
    z.string().uuid().parse(projectId)
    await requireRunner().removeProject(projectId)
  })

  ipcMain.handle('task:create', (_event, rawInput: CreateTaskInput) => {
    const input = createTaskSchema.parse(rawInput)
    return requireStore().createTask(input.projectId, input.title, input.prompt, input.maxAttempts)
  })

  ipcMain.handle('task:changes', (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    return requireRunner().getChanges(taskId)
  })

  ipcMain.handle('task:run', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('먼저 AgentMonitoring에서 Codex에 로그인하세요.')
    await requireRunner().run(taskId)
  })

  ipcMain.handle('task:stop', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().stop(taskId)
  })

  ipcMain.handle('task:approve', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().approve(taskId)
  })

  ipcMain.handle('task:discard', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().discard(taskId)
  })

  ipcMain.handle('finding:set-resolved', (_event, rawInput: unknown) => {
    const input = findingStateSchema.parse(rawInput)
    return requireStore().setFindingResolved(input.findingId, input.resolved)
  })

  ipcMain.handle('note:add', (_event, rawInput: unknown) => {
    const input = addNoteSchema.parse(rawInput)
    return requireStore().addNote(input.projectId, input.title, input.body)
  })

  ipcMain.handle('note:update', (_event, rawInput: unknown) => {
    const input = updateNoteSchema.parse(rawInput)
    return requireStore().updateNote(input.noteId, input.title, input.body)
  })

  ipcMain.handle('note:delete', (_event, noteId: string) => {
    z.string().uuid().parse(noteId)
    requireStore().deleteNote(noteId)
  })

  ipcMain.handle('shell:open-path', async (_event, path: string) => {
    if (!path || path.startsWith('demo://')) throw new Error('열 수 없는 경로입니다.')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })

  ipcMain.handle('shell:open-feedback', () =>
    shell.openExternal('https://github.com/indextrown/AgentMonitoring/issues/new')
  )
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData')
  const databasePath = join(userDataPath, 'agent-monitoring.sqlite')
  const codexHome = join(userDataPath, 'codex')
  const codexCommand = await resolveCodexCommand()
  store = new AppStore(databasePath)
  store.recoverInterruptedTasks()
  codexAuth = new CodexAuthManager(codexHome, publishAuth, codexCommand)
  runner = new AgentRunner(store, join(userDataPath, 'worktrees'), publish, codexCommand, codexHome)
  registerIpc()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted || (!runner && !codexAuth && !store)) return
  event.preventDefault()
  shutdownStarted = true
  void shutdownApplication()
    .catch((error) => console.error('AgentMonitoring 종료 정리 실패', error))
    .finally(() => app.quit())
})
