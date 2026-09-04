import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import type {
  ApprovedRuntimeContract,
  CodexAuthStatus,
  CreateTaskInput,
  EventRecord,
  GenerateRuntimeScenarioInput,
  RecommendVerificationPlanInput,
  StorageCleanupInput,
  StoragePolicy,
  UpdateProjectInput
} from '../../src/shared/types'
import { CodexAuthManager, resolveCodexCommand } from './codex-auth'
import { inspectProject } from './project-inspector'
import { detectProjectSetupCommand } from './project-environment'
import { iosRuntimeAdapterSchema, projectCapabilityManifestSchema } from './project-capabilities'
import { resolveProjectRuntimeConfig } from './project-runtime-config'
import { AgentRunner } from './runner'
import { RuntimeScenarioGenerator } from './runtime-scenario-generator'
import { VerificationPlanRecommender } from './verification-plan-recommender'
import { shutdownResources } from './shutdown'
import { AppStore } from './store'

const execFileAsync = promisify(execFile)
const currentDirectory = dirname(fileURLToPath(import.meta.url))

const verificationPlanSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['project-tests', 'simulator-runtime', 'both', 'manual-review']),
  testDesign: z.enum(['automatic', 'swift-testing', 'xctest', 'existing-tests', 'skip']),
  runtimeSource: z.enum(['task-scenario', 'project-default', 'off'])
}).strict()

const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  prompt: z.string().trim().min(10).max(20_000),
  maxAttempts: z.number().int().min(1).max(5),
  runtimeContract: projectCapabilityManifestSchema.nullable().optional(),
  runtimeScenarioSummary: z.string().trim().min(1).max(500).nullable().optional(),
  verificationPlan: verificationPlanSchema
}).superRefine((input, context) => {
  const usesTests = input.verificationPlan.mode === 'project-tests' || input.verificationPlan.mode === 'both'
  const usesRuntime = input.verificationPlan.mode === 'simulator-runtime' || input.verificationPlan.mode === 'both'
  if (!usesTests && input.verificationPlan.testDesign !== 'skip') {
    context.addIssue({ code: 'custom', path: ['verificationPlan', 'testDesign'], message: '프로젝트 테스트를 사용하지 않을 때 테스트 설계는 건너뛰어야 합니다.' })
  }
  if (!usesRuntime && input.verificationPlan.runtimeSource !== 'off') {
    context.addIssue({ code: 'custom', path: ['verificationPlan', 'runtimeSource'], message: 'Simulator 검증을 사용하지 않을 때 runtime 출처는 사용 안 함이어야 합니다.' })
  }
  if (usesRuntime && input.verificationPlan.runtimeSource === 'off') {
    context.addIssue({ code: 'custom', path: ['verificationPlan', 'runtimeSource'], message: 'Simulator 검증에 사용할 시나리오 출처를 선택하세요.' })
  }
  if (input.verificationPlan.runtimeSource === 'task-scenario' && !input.runtimeContract) {
    context.addIssue({ code: 'custom', path: ['runtimeContract'], message: '작업 시나리오를 생성하고 확인하세요.' })
  }
})

const updateProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  testCommand: z.string().trim().max(500),
  setupCommand: z.string().trim().max(500),
  runtimeAdapter: iosRuntimeAdapterSchema.nullable().optional()
})

const generateRuntimeScenarioSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  prompt: z.string().trim().min(10).max(20_000)
})

const recommendVerificationPlanSchema = generateRuntimeScenarioSchema

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

const storagePolicySchema = z.object({
  runtimeArtifactRetentionDays: z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
})

const storageCleanupSchema = z.object({
  removeLocalBranches: z.boolean()
})

let mainWindow: BrowserWindow | null = null
let store: AppStore | null = null
let runner: AgentRunner | null = null
let codexAuth: CodexAuthManager | null = null
let scenarioGenerator: RuntimeScenarioGenerator | null = null
let verificationPlanRecommender: VerificationPlanRecommender | null = null
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

function requireScenarioGenerator(): RuntimeScenarioGenerator {
  if (!scenarioGenerator) throw new Error('검증 시나리오 생성기가 준비되지 않았습니다.')
  return scenarioGenerator
}

function requireVerificationPlanRecommender(): VerificationPlanRecommender {
  if (!verificationPlanRecommender) throw new Error('검증 계획 추천기가 준비되지 않았습니다.')
  return verificationPlanRecommender
}

async function shutdownApplication(): Promise<void> {
  const activeRunner = runner
  const activeCodexAuth = codexAuth
  const activeStore = store
  runner = null
  codexAuth = null
  scenarioGenerator = null
  verificationPlanRecommender = null

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
    let project = requireStore().addProject(basename(projectPath), projectPath)
    if (!project.setupCommand) {
      const setupCommand = await detectProjectSetupCommand(projectPath)
      if (setupCommand) project = requireStore().setProjectSetupCommand(project.id, setupCommand)
    }
    const resolvedRuntime = await resolveProjectRuntimeConfig(projectPath)
    if (resolvedRuntime) {
      project = requireStore().setProjectRuntimeAdapter(
        project.id,
        resolvedRuntime.adapter,
        resolvedRuntime.source
      )
    }
    return project
  })

  ipcMain.handle('project:update', (_event, rawInput: UpdateProjectInput) => {
    const input = updateProjectSchema.parse(rawInput)
    return requireStore().updateProject(input)
  })

  ipcMain.handle('project:inspect', async (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    let project = requireStore().getProject(validProjectId)
    if (!project.setupCommand) {
      const setupCommand = await detectProjectSetupCommand(project.path)
      if (setupCommand) project = requireStore().setProjectSetupCommand(project.id, setupCommand)
    }
    if (!project.runtimeAdapter) {
      const resolvedRuntime = await resolveProjectRuntimeConfig(project.path)
      if (resolvedRuntime) {
        project = requireStore().setProjectRuntimeAdapter(
          project.id,
          resolvedRuntime.adapter,
          resolvedRuntime.source
        )
      }
    }
    return inspectProject(project)
  })

  ipcMain.handle('project:auto-configure-runtime', async (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    const project = requireStore().getProject(validProjectId)
    if (project.runtimeAdapter) return project
    const resolvedRuntime = await resolveProjectRuntimeConfig(project.path)
    if (!resolvedRuntime) {
      throw new Error(
        'Xcode 프로젝트 또는 Workspace를 찾지 못했습니다. Tuist 프로젝트라면 `tuist generate`를 한 번 실행한 뒤 다시 시도하거나 프로젝트 설정에서 직접 입력하세요.'
      )
    }
    return requireStore().setProjectRuntimeAdapter(
      project.id,
      resolvedRuntime.adapter,
      resolvedRuntime.source
    )
  })

  ipcMain.handle('runtime-scenario:generate', async (_event, rawInput: GenerateRuntimeScenarioInput) => {
    const input = generateRuntimeScenarioSchema.parse(rawInput)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('검증 시나리오를 만들려면 먼저 Codex에 로그인하세요.')
    const project = requireStore().getProject(input.projectId)
    if (!project.runtimeAdapter) {
      throw new Error('이 프로젝트에서 iOS 실행 설정을 찾지 못했습니다. 프로젝트 설정에서 먼저 등록하세요.')
    }
    return requireScenarioGenerator().generate({
      projectPath: project.path,
      title: input.title,
      prompt: input.prompt,
      adapter: project.runtimeAdapter
    })
  })

  ipcMain.handle('verification-plan:recommend', async (_event, rawInput: RecommendVerificationPlanInput) => {
    const input = recommendVerificationPlanSchema.parse(rawInput)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('검증 계획을 추천받으려면 먼저 Codex에 로그인하세요.')
    const project = requireStore().getProject(input.projectId)
    return requireVerificationPlanRecommender().recommend({
      projectPath: project.path,
      title: input.title,
      prompt: input.prompt,
      testCommand: project.testCommand,
      runtimeAvailable: Boolean(project.runtimeAdapter),
      runtimeConfigSource: project.runtimeConfigSource ?? null
    })
  })

  ipcMain.handle('project:remove', async (_event, projectId: string) => {
    z.string().uuid().parse(projectId)
    await requireRunner().removeProject(projectId)
  })

  ipcMain.handle('task:create', (_event, rawInput: CreateTaskInput) => {
    const input = createTaskSchema.parse(rawInput)
    const project = requireStore().getProject(input.projectId)
    const usesTests = input.verificationPlan.mode === 'project-tests' || input.verificationPlan.mode === 'both'
    const usesRuntime = input.verificationPlan.mode === 'simulator-runtime' || input.verificationPlan.mode === 'both'
    if (usesTests && !project.testCommand.trim()) {
      throw new Error('프로젝트 테스트를 사용하려면 프로젝트 검증 명령을 먼저 등록하세요.')
    }
    if (usesRuntime && !project.runtimeAdapter) {
      throw new Error('Simulator 검증을 사용하려면 iOS 실행 영역을 먼저 연결하세요.')
    }
    if (input.verificationPlan.runtimeSource === 'project-default' && project.runtimeConfigSource !== 'manifest') {
      throw new Error('프로젝트 기본 시나리오를 사용하려면 .agentmonitor/project.json이 필요합니다.')
    }
    return requireStore().createTask(
      input.projectId,
      input.title,
      input.prompt,
      input.maxAttempts,
      (input.runtimeContract as ApprovedRuntimeContract | null | undefined) ?? null,
      input.runtimeScenarioSummary ?? null,
      input.verificationPlan
    )
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

  ipcMain.handle('task:retry-verification', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('먼저 AgentMonitoring에서 Codex에 로그인하세요.')
    await requireRunner().retryVerification(taskId)
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

  ipcMain.handle('storage:overview', () => requireRunner().getStorageOverview())

  ipcMain.handle('storage:set-policy', (_event, rawPolicy: StoragePolicy) => {
    const policy = storagePolicySchema.parse(rawPolicy)
    return requireRunner().setStoragePolicy(policy)
  })

  ipcMain.handle('storage:cleanup', (_event, rawInput: StorageCleanupInput) => {
    const input = storageCleanupSchema.parse(rawInput)
    return requireRunner().cleanupStorage(input)
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
  for (const project of store.listProjects()) {
    if (project.setupCommand) continue
    const setupCommand = await detectProjectSetupCommand(project.path)
    if (setupCommand) store.setProjectSetupCommand(project.id, setupCommand)
  }
  store.recoverInterruptedTasks()
  store.recoverInterruptedRuntimeSessions()
  codexAuth = new CodexAuthManager(codexHome, publishAuth, codexCommand)
  scenarioGenerator = new RuntimeScenarioGenerator(codexCommand, codexHome)
  verificationPlanRecommender = new VerificationPlanRecommender(codexCommand, codexHome)
  runner = new AgentRunner(store, join(userDataPath, 'worktrees'), publish, codexCommand, codexHome)
  registerIpc()
  await createWindow()
  void runner.reconcileStorage().catch((error) => console.error('저장 공간 시작 정리 실패', error))

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
