import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import type { CreateTaskInput, EventRecord, UpdateProjectInput } from '../../src/shared/types'
import { AgentRunner } from './runner'
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

let mainWindow: BrowserWindow | null = null
let store: AppStore | null = null
let runner: AgentRunner | null = null

function publish(event: EventRecord): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runner:event', event)
}

function requireStore(): AppStore {
  if (!store) throw new Error('데이터베이스가 준비되지 않았습니다.')
  return store
}

function requireRunner(): AgentRunner {
  if (!runner) throw new Error('실행기가 준비되지 않았습니다.')
  return runner
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
      preload: join(currentDirectory, '../preload/index.mjs'),
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

  ipcMain.handle('task:create', (_event, rawInput: CreateTaskInput) => {
    const input = createTaskSchema.parse(rawInput)
    return requireStore().createTask(input.projectId, input.title, input.prompt, input.maxAttempts)
  })

  ipcMain.handle('task:run', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().run(taskId)
  })

  ipcMain.handle('task:stop', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().stop(taskId)
  })

  ipcMain.handle('task:approve', (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    requireRunner().approve(taskId)
  })

  ipcMain.handle('task:discard', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().discard(taskId)
  })

  ipcMain.handle('note:add', (_event, rawInput: unknown) => {
    const input = addNoteSchema.parse(rawInput)
    return requireStore().addNote(input.projectId, input.title, input.body)
  })

  ipcMain.handle('shell:open-path', async (_event, path: string) => {
    if (!path || path.startsWith('demo://')) throw new Error('열 수 없는 경로입니다.')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
}

app.whenReady().then(async () => {
  const databasePath = join(app.getPath('userData'), 'agent-monitoring.sqlite')
  store = new AppStore(databasePath)
  runner = new AgentRunner(store, join(app.getPath('userData'), 'worktrees'), publish)
  registerIpc()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  store?.close()
  store = null
})
