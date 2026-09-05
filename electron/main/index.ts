import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { z } from 'zod'
import type {
  ApprovedRuntimeContract,
  CodexAuthStatus,
  ContinueTaskInput,
  CreateTaskInput,
  EventRecord,
  GenerateTechSpecInput,
  GenerateRuntimeScenarioInput,
  DeleteProjectRuntimeEnvironmentInput,
  MoveTaskRevisionRequestInput,
  ProjectSimulatorSession,
  RecommendVerificationPlanInput,
  RefineTechSpecInput,
  SourceControlCommitInput,
  SourceControlDiffInput,
  SourceControlIdentityInput,
  SourceControlPathsInput,
  SetTaskRevisionQueuePausedInput,
  StorageCleanupInput,
  StoragePolicy,
  TaskRevisionRequestInput,
  UpsertProjectRuntimeEnvironmentInput,
  UpdateProjectInput,
  UpdateTaskRevisionRequestInput
} from '../../src/shared/types'
import { CodexAuthManager, resolveCodexCommand } from './codex-auth'
import { inspectProject } from './project-inspector'
import { detectProjectSetupCommand } from './project-environment'
import { iosRuntimeAdapterSchema } from './project-capabilities'
import { taskRuntimeContractSchema } from './runtime-contract'
import {
  discoverProjectRuntimeConfig,
  resolveProjectRuntimeConfig
} from './project-runtime-config'
import { ProjectSimulatorService } from './project-simulator'
import { AgentRunner } from './runner'
import { GitOperationCoordinator } from './git-operation-coordinator'
import { resolveGithubCommand } from './github-cli'
import { SourceControlService } from './source-control'
import { TechSpecGenerator } from './tech-spec-generator'
import { RuntimeScenarioGenerator } from './runtime-scenario-generator'
import { VerificationPlanRecommender } from './verification-plan-recommender'
import { shutdownResources } from './shutdown'
import { AppStore } from './store'
import { ProjectRuntimeEnvironmentService } from './runtime-environment'
import { openTaskInXcode } from './task-xcode'

const execFileAsync = promisify(execFile)
const currentDirectory = dirname(fileURLToPath(import.meta.url))

const verificationPlanSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['project-tests', 'simulator-runtime', 'both', 'manual-review']),
  testDesign: z.enum(['automatic', 'swift-testing', 'xctest', 'existing-tests', 'skip']),
  runtimeSource: z.enum(['task-scenario', 'project-default', 'off'])
}).strict()

const techSpecDraftSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(1).max(1_000),
  summary: z.string().trim().min(1).max(500),
  markdown: z.string().trim().min(100).max(30_000),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(12)
}).strict()

const createTaskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  prompt: z.string().trim().min(10).max(20_000),
  maxAttempts: z.number().int().min(1).max(5),
  runtimeContract: taskRuntimeContractSchema.nullable().optional(),
  runtimeScenarioSummary: z.string().trim().min(1).max(500).nullable().optional(),
  techSpec: techSpecDraftSchema.nullable().optional(),
  verificationPlan: verificationPlanSchema,
  publishStrategy: z.enum(['pull-request', 'direct'])
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

const continueTaskSchema = z.object({
  taskId: z.string().uuid(),
  instruction: z.string().trim().min(5).max(5_000)
}).strict()

const taskRevisionRequestSchema = z.object({
  taskId: z.string().uuid(),
  requestId: z.string().uuid()
}).strict()

const updateTaskRevisionRequestSchema = taskRevisionRequestSchema.extend({
  instruction: z.string().trim().min(5).max(5_000)
}).strict()

const moveTaskRevisionRequestSchema = taskRevisionRequestSchema.extend({
  direction: z.enum(['up', 'down'])
}).strict()

const setTaskRevisionQueuePausedSchema = z.object({
  taskId: z.string().uuid(),
  paused: z.boolean()
}).strict()

const updateProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  testCommand: z.string().trim().max(500),
  setupCommand: z.string().trim().max(500),
  runtimeAdapter: iosRuntimeAdapterSchema.nullable().optional(),
  publishStrategy: z.enum(['pull-request', 'direct']).optional()
})

const upsertProjectRuntimeEnvironmentSchema = z.object({
  projectId: z.string().uuid(),
  id: z.string().uuid().optional(),
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  scope: z.enum(['build', 'launch', 'both']),
  buildSetting: z.string().trim().max(128).nullable().optional(),
  launchVariable: z.string().trim().max(128).nullable().optional(),
  value: z.string().max(10_000).optional()
}).strict()

const deleteProjectRuntimeEnvironmentSchema = z.object({
  projectId: z.string().uuid(),
  id: z.string().uuid()
}).strict()

const generateRuntimeScenarioSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(120),
  prompt: z.string().trim().min(10).max(20_000),
  techSpec: techSpecDraftSchema.nullable().optional()
}).strict()

const recommendVerificationPlanSchema = generateRuntimeScenarioSchema

const generateTechSpecSchema = generateRuntimeScenarioSchema.omit({ techSpec: true })

const refineTechSpecSchema = generateTechSpecSchema.extend({
  current: techSpecDraftSchema,
  feedback: z.string().trim().min(3).max(5_000)
}).strict()

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

const sourceControlPathsSchema = z.object({
  projectId: z.string().uuid(),
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(500)
}).strict()

const sourceControlDiffSchema = z.object({
  projectId: z.string().uuid(),
  path: z.string().min(1).max(4_096),
  area: z.enum(['staged', 'working'])
}).strict()

const sourceControlCommitSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().trim().min(1).max(2_000),
  includeWorking: z.boolean()
}).strict()

const sourceControlIdentitySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320)
}).strict()

const externalUrlSchema = z.string().url().refine((url) => url.startsWith('https://github.com/'), {
  message: 'GitHub HTTPS 주소만 열 수 있습니다.'
})

let mainWindow: BrowserWindow | null = null
let store: AppStore | null = null
let runtimeEnvironment: ProjectRuntimeEnvironmentService | null = null
let runner: AgentRunner | null = null
let sourceControl: SourceControlService | null = null
let projectSimulator: ProjectSimulatorService | null = null
let codexAuth: CodexAuthManager | null = null
let scenarioGenerator: RuntimeScenarioGenerator | null = null
let verificationPlanRecommender: VerificationPlanRecommender | null = null
let techSpecGenerator: TechSpecGenerator | null = null
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

function publishProjectSimulator(session: ProjectSimulatorSession): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('project-simulator:changed', session)
  }
}

function requireStore(): AppStore {
  if (!store) throw new Error('데이터베이스가 준비되지 않았습니다.')
  return store
}

function requireRuntimeEnvironment(): ProjectRuntimeEnvironmentService {
  if (!runtimeEnvironment) throw new Error('프로젝트 실행 환경 저장소가 준비되지 않았습니다.')
  return runtimeEnvironment
}

function requireRunner(): AgentRunner {
  if (!runner) throw new Error('실행기가 준비되지 않았습니다.')
  return runner
}

function requireSourceControl(): SourceControlService {
  if (!sourceControl) throw new Error('Source Control이 준비되지 않았습니다.')
  return sourceControl
}

function requireProjectSimulator(): ProjectSimulatorService {
  if (!projectSimulator) throw new Error('프로젝트 Simulator가 준비되지 않았습니다.')
  return projectSimulator
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

function requireTechSpecGenerator(): TechSpecGenerator {
  if (!techSpecGenerator) throw new Error('테크스펙 생성기가 준비되지 않았습니다.')
  return techSpecGenerator
}

async function shutdownApplication(): Promise<void> {
  const activeRunner = runner
  const activeProjectSimulator = projectSimulator
  const activeCodexAuth = codexAuth
  const activeStore = store
  runner = null
  projectSimulator = null
  sourceControl = null
  codexAuth = null
  scenarioGenerator = null
  verificationPlanRecommender = null
  techSpecGenerator = null
  runtimeEnvironment = null

  try {
    await shutdownResources({
      projectSimulator: activeProjectSimulator,
      runner: activeRunner,
      codexAuth: activeCodexAuth,
      store: activeStore
    })
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

  ipcMain.handle('project-runtime-environment:list', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireRuntimeEnvironment().list(validProjectId)
  })

  ipcMain.handle('project-runtime-environment:upsert', (_event, rawInput: UpsertProjectRuntimeEnvironmentInput) => {
    const input = upsertProjectRuntimeEnvironmentSchema.parse(rawInput)
    return requireRuntimeEnvironment().upsert(input)
  })

  ipcMain.handle('project-runtime-environment:delete', (_event, rawInput: DeleteProjectRuntimeEnvironmentInput) => {
    const input = deleteProjectRuntimeEnvironmentSchema.parse(rawInput)
    return requireRuntimeEnvironment().delete(input.projectId, input.id)
  })

  ipcMain.handle('project:inspect', async (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    let project = requireStore().getProject(validProjectId)
    if (!project.setupCommand) {
      const setupCommand = await detectProjectSetupCommand(project.path)
      if (setupCommand) project = requireStore().setProjectSetupCommand(project.id, setupCommand)
    }
    if (!project.runtimeAdapter || project.runtimeConfigSource === 'detected') {
      const resolvedRuntime = await resolveProjectRuntimeConfig(project.path)
      if (
        resolvedRuntime &&
        (
          project.runtimeConfigSource !== resolvedRuntime.source ||
          JSON.stringify(project.runtimeAdapter) !== JSON.stringify(resolvedRuntime.adapter)
        )
      ) {
        project = requireStore().setProjectRuntimeAdapter(
          project.id,
          resolvedRuntime.adapter,
          resolvedRuntime.source
        )
      }
    }
    return inspectProject(project)
  })

  ipcMain.handle('source-control:status', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireSourceControl().getStatus(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('source-control:diff', (_event, rawInput: SourceControlDiffInput) => {
    const input = sourceControlDiffSchema.parse(rawInput)
    return requireSourceControl().getDiff(
      requireStore().getProject(input.projectId),
      input.path,
      input.area
    )
  })

  ipcMain.handle('source-control:stage', (_event, rawInput: SourceControlPathsInput) => {
    const input = sourceControlPathsSchema.parse(rawInput)
    return requireSourceControl().stage(requireStore().getProject(input.projectId), input.paths)
  })

  ipcMain.handle('source-control:unstage', (_event, rawInput: SourceControlPathsInput) => {
    const input = sourceControlPathsSchema.parse(rawInput)
    return requireSourceControl().unstage(requireStore().getProject(input.projectId), input.paths)
  })

  ipcMain.handle('source-control:stage-all', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireSourceControl().stageAll(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('source-control:unstage-all', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireSourceControl().unstageAll(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('source-control:set-identity', (_event, rawInput: SourceControlIdentityInput) => {
    const input = sourceControlIdentitySchema.parse(rawInput)
    return requireSourceControl().setIdentity(
      requireStore().getProject(input.projectId),
      input.name,
      input.email
    )
  })

  ipcMain.handle('source-control:commit', (_event, rawInput: SourceControlCommitInput) => {
    const input = sourceControlCommitSchema.parse(rawInput)
    return requireSourceControl().commit(
      requireStore().getProject(input.projectId),
      input.message,
      input.includeWorking
    )
  })

  ipcMain.handle('source-control:fetch', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireSourceControl().fetch(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('source-control:push', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireSourceControl().push(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('source-control:sync', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireSourceControl().sync(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('project-simulator:status', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireProjectSimulator().getStatus(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('project-simulator:destinations', (_event, projectId: string, refresh = false) => {
    const validProjectId = z.string().uuid().parse(projectId)
    const validRefresh = z.boolean().parse(refresh)
    return requireProjectSimulator().listDestinations(requireStore().getProject(validProjectId), validRefresh)
  })

  ipcMain.handle('project-simulator:launch', (_event, projectId: string, destinationId?: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    const validDestinationId = destinationId === undefined
      ? undefined
      : z.string().trim().min(1).max(512).parse(destinationId)
    return requireProjectSimulator().launch(
      requireStore().getProject(validProjectId),
      undefined,
      validDestinationId
    )
  })

  ipcMain.handle('project-simulator:launch-task', (_event, taskId: string, destinationId?: string) => {
    const validTaskId = z.string().uuid().parse(taskId)
    const validDestinationId = destinationId === undefined
      ? undefined
      : z.string().trim().min(1).max(512).parse(destinationId)
    const store = requireStore()
    const task = store.getTask(validTaskId)
    if (!task.worktreePath) {
      throw new Error('이 작업의 격리 작업공간이 없어 작업 브랜치 앱을 실행할 수 없습니다.')
    }
    if (['queued', 'running', 'testing'].includes(task.status)) {
      throw new Error('구현이나 검증이 진행 중인 작업은 완료된 뒤 작업 브랜치 앱을 실행하세요.')
    }
    const project = store.getProject(task.projectId)
    return requireProjectSimulator().launch(project, {
      path: task.worktreePath,
      source: {
        kind: 'task-worktree',
        taskId: task.id,
        branchName: task.branchName
      }
    }, validDestinationId)
  })

  ipcMain.handle('project-simulator:restart', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireProjectSimulator().restart(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('project-simulator:stop', (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    return requireProjectSimulator().stop(requireStore().getProject(validProjectId))
  })

  ipcMain.handle('project:auto-configure-runtime', async (_event, projectId: string) => {
    const validProjectId = z.string().uuid().parse(projectId)
    let project = requireStore().getProject(validProjectId)
    if (project.runtimeAdapter && project.runtimeConfigSource === 'manifest') {
      return {
        project,
        discovery: {
          state: 'ready',
          container: project.runtimeAdapter.container,
          appSchemes: [{ scheme: project.runtimeAdapter.scheme, targets: [] }],
          selectedScheme: project.runtimeAdapter.scheme,
          message: '.agentmonitor/project.json에 선언된 iOS 앱 실행 설정을 사용합니다.'
        }
      }
    }
    const discovery = await discoverProjectRuntimeConfig(project.path, { force: true })
    if (discovery.state === 'ready' && discovery.container && discovery.selectedScheme) {
      project = requireStore().setProjectRuntimeAdapter(
        project.id,
        {
          kind: 'ios-simulator',
          container: discovery.container,
          scheme: discovery.selectedScheme,
          configuration: 'Debug',
          deviceFamily: project.runtimeAdapter?.deviceFamily ?? 'iphone'
        },
        'detected'
      )
    }
    return { project, discovery }
  })

  ipcMain.handle('tech-spec:generate', async (_event, rawInput: GenerateTechSpecInput) => {
    const input = generateTechSpecSchema.parse(rawInput)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('테크스펙을 만들려면 먼저 Codex에 로그인하세요.')
    const project = requireStore().getProject(input.projectId)
    return requireTechSpecGenerator().generate({
      projectPath: project.path,
      title: input.title,
      prompt: input.prompt
    })
  })

  ipcMain.handle('tech-spec:refine', async (_event, rawInput: RefineTechSpecInput) => {
    const input = refineTechSpecSchema.parse(rawInput)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('테크스펙을 개선하려면 먼저 Codex에 로그인하세요.')
    const project = requireStore().getProject(input.projectId)
    return requireTechSpecGenerator().refine({
      projectPath: project.path,
      title: input.title,
      prompt: input.prompt,
      current: input.current,
      feedback: input.feedback
    })
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
      techSpec: input.techSpec ?? null,
      adapter: project.runtimeAdapter,
      availableEnvironmentKeys: requireRuntimeEnvironment().list(project.id)
        .filter((entry) => entry.configured)
        .map((entry) => entry.key)
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
      techSpec: input.techSpec ?? null,
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
      input.verificationPlan,
      input.publishStrategy,
      input.techSpec ?? null
    )
  })

  ipcMain.handle('task:changes', (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    return requireRunner().getChanges(taskId)
  })

  ipcMain.handle('task:regenerate-runtime-scenario', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('검증 시나리오를 최신화하려면 먼저 Codex에 로그인하세요.')
    const store = requireStore()
    const task = store.getTask(taskId)
    const project = store.getProject(task.projectId)
    const adapter = task.runtimeContract?.adapter ?? project.runtimeAdapter
    if (!adapter) throw new Error('이 프로젝트에서 iOS 실행 설정을 찾지 못했습니다.')
    const generated = await requireScenarioGenerator().generate({
      projectPath: task.worktreePath ?? project.path,
      title: task.title,
      prompt: task.prompt,
      techSpec: task.techSpec
        ? {
            version: task.techSpec.version,
            revision: task.techSpec.revision,
            summary: task.techSpec.summary,
            markdown: task.techSpec.markdown,
            openQuestions: task.techSpec.openQuestions
          }
        : null,
      adapter,
      previousContract: task.runtimeContract,
      availableEnvironmentKeys: requireRuntimeEnvironment().list(project.id)
        .filter((entry) => entry.configured)
        .map((entry) => entry.key)
    })
    return store.replaceTaskRuntimeContract(taskId, generated.contract, generated.summary)
  })

  ipcMain.handle('task:run', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('먼저 AgentMonitoring에서 Codex에 로그인하세요.')
    await requireRunner().run(taskId)
  })

  ipcMain.handle('task:continue', async (_event, rawInput: ContinueTaskInput) => {
    const input = continueTaskSchema.parse(rawInput)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('먼저 AgentMonitoring에서 Codex에 로그인하세요.')
    await requireRunner().continueTask(input.taskId, input.instruction)
  })

  ipcMain.handle('task:revision-update', (_event, rawInput: UpdateTaskRevisionRequestInput) => {
    const input = updateTaskRevisionRequestSchema.parse(rawInput)
    return requireRunner().updateTaskRevisionRequest(input.taskId, input.requestId, input.instruction)
  })

  ipcMain.handle('task:revision-cancel', (_event, rawInput: TaskRevisionRequestInput) => {
    const input = taskRevisionRequestSchema.parse(rawInput)
    return requireRunner().cancelTaskRevisionRequest(input.taskId, input.requestId)
  })

  ipcMain.handle('task:revision-move', (_event, rawInput: MoveTaskRevisionRequestInput) => {
    const input = moveTaskRevisionRequestSchema.parse(rawInput)
    return requireRunner().moveTaskRevisionRequest(input.taskId, input.requestId, input.direction)
  })

  ipcMain.handle('task:revision-queue-pause', (_event, rawInput: SetTaskRevisionQueuePausedInput) => {
    const input = setTaskRevisionQueuePausedSchema.parse(rawInput)
    return requireRunner().setTaskRevisionQueuePaused(input.taskId, input.paused)
  })

  ipcMain.handle('task:revision-run-next', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    const auth = await requireCodexAuth().status()
    if (auth.state !== 'signed_in') throw new Error('먼저 AgentMonitoring에서 Codex에 로그인하세요.')
    await requireRunner().runNextTaskRevision(taskId)
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
    return requireRunner().approve(taskId)
  })

  ipcMain.handle('task:refresh-publication', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    return requireRunner().refreshPublication(taskId)
  })

  ipcMain.handle('task:switch-publication-to-pr', async (_event, taskId: string) => {
    const validTaskId = z.string().uuid().parse(taskId)
    const task = requireStore().getTask(validTaskId)
    if (!['awaiting_approval', 'awaiting_manual_validation'].includes(task.status)) {
      throw new Error('승인을 기다리는 작업만 PR 방식으로 전환할 수 있습니다.')
    }
    if ((task.publishStrategy ?? 'pull-request') !== 'direct') return task
    return requireStore().setTaskPublishStrategy(validTaskId, 'pull-request')
  })

  ipcMain.handle('task:discard', async (_event, taskId: string) => {
    z.string().uuid().parse(taskId)
    await requireRunner().discard(taskId)
  })

  ipcMain.handle('task:open-in-xcode', async (_event, taskId: string) => {
    const validTaskId = z.string().uuid().parse(taskId)
    const store = requireStore()
    const task = store.getTask(validTaskId)
    await openTaskInXcode(store.getProject(task.projectId), task)
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

  ipcMain.handle('shell:open-external-url', async (_event, rawUrl: string) => {
    await shell.openExternal(externalUrlSchema.parse(rawUrl))
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
  const githubCommand = await resolveGithubCommand()
  store = new AppStore(databasePath)
  runtimeEnvironment = new ProjectRuntimeEnvironmentService(store, safeStorage)
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
  techSpecGenerator = new TechSpecGenerator(codexCommand, codexHome)
  const gitCoordinator = new GitOperationCoordinator()
  sourceControl = new SourceControlService(gitCoordinator)
  projectSimulator = new ProjectSimulatorService(
    join(userDataPath, 'project-simulator'),
    publishProjectSimulator
  )
  runner = new AgentRunner(
    store,
    join(userDataPath, 'worktrees'),
    publish,
    codexCommand,
    codexHome,
    {},
    undefined,
    gitCoordinator,
    githubCommand,
    runtimeEnvironment
  )
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
