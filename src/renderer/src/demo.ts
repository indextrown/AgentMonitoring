import {
  AGENT_MONITORING_BRIDGE_VERSION,
  type AgentMonitoringBridge,
  type CodexAuthStatus,
  type DashboardSnapshot,
  type EventKind,
  type EventRecord,
  type ProjectRecord,
  type ProjectRuntimeEnvironmentEntry,
  type ProjectSimulatorSession,
  type SourceControlFile,
  type SourceControlStatus,
  type TaskRecord,
  type TaskStatus
} from '../../shared/types'
import { createVerificationResult, updateVerificationStep } from '../../shared/domain'

const projectId = '11111111-1111-4111-8111-111111111111'
const secondaryProjectId = '22222222-2222-4222-8222-222222222222'
const simulatorListeners = new Set<(session: ProjectSimulatorSession) => void>()
const demoSimulatorSessions = new Map<string, ProjectSimulatorSession>()

function demoSimulatorSession(requestedProjectId: string): ProjectSimulatorSession {
  return demoSimulatorSessions.get(requestedProjectId) ?? {
    projectId: requestedProjectId,
    source: {
      kind: 'project',
      taskId: null,
      branchName: null
    },
    status: 'idle',
    destinationKind: null,
    deviceId: null,
    deviceName: null,
    bundleIdentifier: null,
    processId: null,
    message: '실행할 Simulator 또는 실기기를 선택하세요.',
    error: null,
    updatedAt: new Date().toISOString()
  }
}

function updateDemoSimulator(
  requestedProjectId: string,
  patch: Partial<ProjectSimulatorSession>
): ProjectSimulatorSession {
  const session = {
    ...demoSimulatorSession(requestedProjectId),
    ...patch,
    projectId: requestedProjectId,
    updatedAt: new Date().toISOString()
  }
  demoSimulatorSessions.set(requestedProjectId, session)
  simulatorListeners.forEach((listener) => listener(session))
  return session
}

function atOffset(days: number, hours: number, minutes = 0): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(hours, minutes, 0, 0)
  return date.toISOString()
}

function buildSnapshot(): DashboardSnapshot {
  const runtimeRunning = searchParams.get('runtime') === 'running'
  const runtimeDeviceName = searchParams.get('device') === 'iphone'
    ? 'iPhone 16 Pro'
    : 'iPad Pro 13-inch'
  const projects: ProjectRecord[] = [
    {
      id: projectId,
      name: 'ElmwoodOnline',
      path: `demo://${projectId}`,
      setupCommand: '',
      testCommand: '',
      runtimeAdapter: searchParams.get('contract') === 'ios'
        ? {
            kind: 'ios-simulator',
            container: 'ElmwoodOnline.xcodeproj',
            scheme: 'ElmwoodOnline',
            configuration: 'Debug',
            deviceFamily: searchParams.get('device') === 'ipad' ? 'ipad' : 'iphone'
          }
        : null,
      runtimeConfigSource: searchParams.get('contract') === 'ios' ? 'detected' : null,
      publishStrategy: 'pull-request' as const,
      isDemo: true,
      createdAt: atOffset(-30, 9)
    },
    {
      id: secondaryProjectId,
      name: 'AgentMonitoring',
      path: `demo://${secondaryProjectId}`,
      setupCommand: '',
      testCommand: '',
      runtimeAdapter: null,
      runtimeConfigSource: null,
      publishStrategy: 'pull-request' as const,
      isDemo: true,
      createdAt: atOffset(-10, 9)
    }
  ]
  const tasks: TaskRecord[] = Array.from({ length: 32 }, (_, index) => {
    const taskNumber = index + 1
    const createdAt = atOffset(-Math.floor((31 - index) / 2), 9 + (index % 8), (index * 7) % 60)
    return {
      id: `00000000-0000-4000-8000-${String(taskNumber).padStart(12, '0')}`,
      projectId,
      title:
        index === 31
          ? '프로필 등록 시스템 구축 + 옛 포맷 프로필 이주 — 1단계 C# 파일 변환부터'
          : ['프로필 등록 시스템 구축', '네트워크 재접속 안정화', '맵 데이터 캐시 정리', '항로 검색 결과 검증'][
              index % 4
            ],
      prompt: '요구사항을 구현하고 테스트와 검토를 통과한다.',
      status: 'completed' as const,
      provider: 'codex' as const,
      maxAttempts: 3,
      attempt: index === 31 && runtimeRunning ? 2 : 1,
      branchName: null,
      worktreePath: null,
      sourceBranch: null,
      baseCommit: null,
      verificationBaseCommit: null,
      publishStrategy: 'pull-request' as const,
      publication: null,
      runtimeContract: null,
      runtimeScenarioSummary: null,
      runtimeScenarioApprovedAt: null,
      createdAt,
      updatedAt: new Date(new Date(createdAt).getTime() + 62 * 60 * 1000).toISOString()
    }
  }).reverse()
  if (searchParams.get('environment') === 'blocked') {
    const plan = {
      version: 1 as const,
      mode: 'project-tests' as const,
      testDesign: 'existing-tests' as const,
      runtimeSource: 'off' as const
    }
    tasks[0] = {
      ...tasks[0],
      status: 'blocked_environment',
      attempt: 0,
      branchName: `agentmonitor/demo-${tasks[0].id.slice(0, 6)}`,
      worktreePath: `demo://worktrees/${tasks[0].id}`,
      verificationPlan: plan,
      verificationResult: updateVerificationStep(
        createVerificationResult(plan),
        'environment-setup',
        'failed',
        'Tuist 외부 의존성이 준비되지 않았습니다.'
      )
    }
  }
  if (searchParams.get('publication') === 'local-sync') {
    tasks[0] = {
      ...tasks[0],
      status: 'awaiting_approval',
      branchName: `agentmonitor/demo-${tasks[0].id.slice(0, 6)}`,
      worktreePath: `demo://worktrees/${tasks[0].id}`,
      sourceBranch: 'main',
      baseCommit: '1111111111111111111111111111111111111111',
      verificationBaseCommit: '1111111111111111111111111111111111111111',
      publishStrategy: 'direct',
      publication: {
        strategy: 'direct',
        status: 'awaiting_local_sync',
        remoteName: 'origin',
        baseBranch: 'main',
        remoteBranch: 'main',
        pullRequestUrl: null,
        publishedCommit: '2222222222222222222222222222222222222222',
        mergeCommit: null,
        message: '원격 origin/main 게시 완료 · 로컬 동기화 대기',
        updatedAt: new Date().toISOString()
      }
    }
  }
  const findings = Array.from({ length: 6 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    projectId,
    taskId: null,
    title: `회귀 시나리오 ${index + 1} 실패`,
    severity: (['critical', 'high', 'medium', 'low', 'medium', 'low'] as const)[index],
    resolved: true,
    createdAt: atOffset(-12 + index * 2, 11),
    resolvedAt: atOffset(-11 + index * 2, 15)
  }))
  const notes = Array.from({ length: 14 }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    projectId,
    title: `프로젝트 결정 ${14 - index}`,
    body: '작업 과정에서 확인한 기준과 후속 검토 항목을 기록했습니다.',
    createdAt: new Date(Date.now() - index * 3 * 60 * 60 * 1000).toISOString()
  }))
  const kinds: EventKind[] = [
    'note_created',
    'task_completed',
    'agent',
    'note_created',
    'agent',
    'test_passed',
    'task_completed',
    'finding_resolved',
    'agent',
    'task_started',
    'note_created',
    'test_passed',
    'task_completed',
    'agent',
    'task_started'
  ]
  const messages = [
    'unrealnetcore-index 메모 수정',
    '프로필 등록 시스템 구축 완료',
    'WORK-0032 노트 작성',
    'unrealnetcore-index 메모 수정',
    'WORK-0032 테스트 케이스 검토',
    'XCTest 회귀 시나리오 29개 통과',
    '네트워크 재접속 안정화 완료',
    '경계 조건 버그 해결',
    '비평가가 누락된 실패 경로를 확인했습니다.',
    '맵 데이터 캐시 정리 시작',
    '프로젝트 결정 14 메모 작성',
    '단위 테스트와 통합 테스트 통과',
    '항로 검색 결과 검증 완료',
    '최종 diff 검토를 마쳤습니다.',
    '프로필 변환 작업 시작'
  ]
  const events: EventRecord[] = Array.from({ length: 34 }, (_, index) => ({
    id: index + 1,
    projectId,
    taskId: index % 3 === 0 ? tasks[index % 8].id : null,
    kind: kinds[index % kinds.length],
    actor: index % 4 === 0 ? 'critic' : 'codex',
    message: messages[index % messages.length],
    severity: kinds[index % kinds.length].includes('finding') ? 'medium' : null,
    createdAt: new Date(Date.now() - index * 38 * 60 * 1000).toISOString()
  }))
  if (runtimeRunning) {
    events.unshift({
      id: 100,
      projectId,
      taskId: tasks[0].id,
      kind: 'runtime_repair_started',
      actor: 'orchestrator',
      message: 'runtime 실패 증거를 Implementer에 전달 · 다음 시도 2/3',
      severity: null,
      createdAt: atOffset(0, 8, 46)
    })
  }
  const runtimeSessions = runtimeRunning
    ? [
        {
          taskId: tasks[0].id,
          projectId,
          status: 'running' as const,
          adapterKind: 'ios-simulator' as const,
          deviceId: '00000000-0000-0000-0000-000000000001',
          deviceName: runtimeDeviceName,
          bundleIdentifier: 'com.example.ElmwoodOnline',
          processId: 43120,
          message: `${runtimeDeviceName}에서 com.example.ElmwoodOnline 실행 완료 · PID 43120`,
          startedAt: atOffset(0, 8, 30),
          updatedAt: atOffset(0, 8, 58)
        }
      ]
    : []
  const runtimeEvidence = runtimeRunning
    ? [
        {
          id: '00000000-0000-4000-8000-000000000101',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 2,
          kind: 'screen' as const,
          outcome: 'captured' as const,
          summary: '최종 Simulator 화면 캡처',
          path: 'demo://runtime/evidence/screen-latest.png',
          mimeType: 'image/png' as const,
          sizeBytes: 1_284_192,
          createdAt: atOffset(0, 8, 58)
        },
        {
          id: '00000000-0000-4000-8000-000000000102',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 2,
          kind: 'accessibility' as const,
          outcome: 'captured' as const,
          summary: '접근성 요소 42개',
          path: 'demo://runtime/evidence/accessibility-latest.json',
          mimeType: 'application/json' as const,
          sizeBytes: 42_816,
          createdAt: atOffset(0, 8, 59)
        },
        {
          id: '00000000-0000-4000-8000-000000000103',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 2,
          kind: 'ui-actions' as const,
          outcome: 'captured' as const,
          summary: 'identifier UI 조작 2단계 성공',
          path: 'demo://runtime/evidence/ui-actions-latest.json',
          mimeType: 'application/json' as const,
          sizeBytes: 3_584,
          createdAt: atOffset(0, 8, 57)
        },
        {
          id: '00000000-0000-4000-8000-000000000104',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 2,
          kind: 'debug-state' as const,
          outcome: 'captured' as const,
          summary: 'fixture signed-in-home 적용 · 최종 Debug 상태 수집',
          path: 'demo://runtime/evidence/debug-state-latest.json',
          mimeType: 'application/json' as const,
          sizeBytes: 8_192,
          createdAt: atOffset(0, 8, 56)
        },
        {
          id: '00000000-0000-4000-8000-000000000105',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 2,
          kind: 'runtime-verification' as const,
          outcome: 'passed' as const,
          summary: 'runtime acceptance 3/3 통과',
          path: 'demo://runtime/evidence/runtime-verification-latest.json',
          mimeType: 'application/json' as const,
          sizeBytes: 2_048,
          createdAt: atOffset(0, 9, 0)
        },
        {
          id: '00000000-0000-4000-8000-000000000106',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 1,
          kind: 'screen' as const,
          outcome: 'captured' as const,
          summary: '실패 시점 Simulator 화면 캡처',
          path: 'demo://runtime/evidence/screen-attempt-1.png',
          mimeType: 'image/png' as const,
          sizeBytes: 1_192_640,
          createdAt: atOffset(0, 8, 44)
        },
        {
          id: '00000000-0000-4000-8000-000000000107',
          taskId: tasks[0].id,
          projectId,
          runId: 'demo-runtime-run-1',
          attempt: 1,
          kind: 'runtime-verification' as const,
          outcome: 'failed' as const,
          summary: 'runtime acceptance 2/3 통과 · 실패: 홈 탭 유지',
          path: 'demo://runtime/evidence/runtime-verification-attempt-1.json',
          mimeType: 'application/json' as const,
          sizeBytes: 2_304,
          createdAt: atOffset(0, 8, 45)
        }
      ]
    : []

  return { projects, selectedProject: projects[0], tasks, events, findings, notes, runtimeSessions, runtimeEvidence }
}

const searchParams = new URLSearchParams(window.location.search)
let state: DashboardSnapshot = searchParams.get('workspace') === 'empty'
  ? {
      projects: [],
      selectedProject: null,
      tasks: [],
      events: [],
      findings: [],
      notes: [],
      runtimeSessions: [],
      runtimeEvidence: []
    }
  : buildSnapshot()
let runtimeArtifactRetentionDays: 0 | 7 | 30 | 90 = 30
const demoRuntimeEnvironment = new Map<string, ProjectRuntimeEnvironmentEntry[]>()
let demoSourceControlFiles: SourceControlFile[] = [
  {
    path: 'Projects/Shared/Featcher/Project.swift',
    originalPath: null,
    staged: null,
    working: 'modified',
    conflicted: false
  },
  {
    path: 'Projects/Shared/Featcher/Tests/FetcherTests.swift',
    originalPath: null,
    staged: null,
    working: 'untracked',
    conflicted: false
  }
]
let demoSourceControlIdentity = { name: '김동현', email: 'developer@example.com', complete: true }
let demoSourceControlRemote: NonNullable<SourceControlStatus['remote']> = {
  name: 'origin',
  url: 'git@github.com:example/AgentMonitoring.git',
  upstream: searchParams.get('source-remote') === 'unconnected' ? null : 'origin/main',
  ahead: ['ahead', 'diverged'].includes(searchParams.get('source-remote') ?? '') ? 2 : 0,
  behind: ['behind', 'diverged'].includes(searchParams.get('source-remote') ?? '') ? 1 : 0,
  diverged: searchParams.get('source-remote') === 'diverged'
}
const listeners = new Set<(event: EventRecord) => void>()
const authListeners = new Set<(status: CodexAuthStatus) => void>()
let demoAuth: CodexAuthStatus = searchParams.get('auth') === 'signed-out'
  ? { state: 'signed_out', authMode: null, email: null, planType: null }
  : { state: 'signed_in', authMode: 'chatgpt', email: 'demo@agentmonitoring.local', planType: 'plus' }

function updateDemoAuth(status: CodexAuthStatus): CodexAuthStatus {
  demoAuth = status
  authListeners.forEach((listener) => listener(status))
  return status
}

function sourceControlStatus(requestedProjectId: string): SourceControlStatus {
  const files = searchParams.get('source-control') === 'dirty' ? demoSourceControlFiles : []
  return {
    projectId: requestedProjectId,
    branch: 'main',
    headCommit: 'a1b2c3d',
    identity: demoSourceControlIdentity,
    files,
    stagedCount: files.filter((file) => file.staged).length,
    workingCount: files.filter((file) => file.working).length,
    conflictedCount: files.filter((file) => file.conflicted).length,
    remote: demoSourceControlRemote,
    inspectedAt: new Date().toISOString()
  }
}

function emit(task: TaskRecord | null, kind: EventKind, actor: string, message: string): void {
  const currentProjectId = task?.projectId ?? state.selectedProject?.id
  if (!currentProjectId) return
  const event: EventRecord = {
    id: Math.max(0, ...state.events.map((item) => item.id)) + 1,
    projectId: currentProjectId,
    taskId: task?.id ?? null,
    kind,
    actor,
    message,
    severity: null,
    createdAt: new Date().toISOString()
  }
  state = { ...state, events: [event, ...state.events] }
  listeners.forEach((listener) => listener(event))
}

function updateTask(
  taskId: string,
  status: TaskStatus,
  changes: Partial<Pick<
    TaskRecord,
    'branchName' | 'worktreePath' | 'sourceBranch' | 'baseCommit' | 'verificationBaseCommit'
  >> = {}
): TaskRecord {
  let updated: TaskRecord | undefined
  state = {
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id !== taskId) return task
      updated = { ...task, ...changes, status, updatedAt: new Date().toISOString() }
      return updated
    })
  }
  if (!updated) throw new Error('작업을 찾을 수 없습니다.')
  return updated
}

function updateTaskVerification(
  taskId: string,
  key: Parameters<typeof updateVerificationStep>[1],
  status: Parameters<typeof updateVerificationStep>[2],
  message: string
): void {
  state = {
    ...state,
    tasks: state.tasks.map((task) => {
      if (task.id !== taskId || !task.verificationPlan) return task
      const current = task.verificationResult ?? createVerificationResult(task.verificationPlan)
      return {
        ...task,
        verificationResult: updateVerificationStep(current, key, status, message),
        updatedAt: new Date().toISOString()
      }
    })
  }
}

export const demoBridge: AgentMonitoringBridge = {
  apiVersion: AGENT_MONITORING_BRIDGE_VERSION,
  getCodexAuth: async () => demoAuth,
  loginCodex: async () => {
    updateDemoAuth({ state: 'signing_in', authMode: null, email: null, planType: null })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450))
    return updateDemoAuth({
      state: 'signed_in',
      authMode: 'chatgpt',
      email: 'demo@agentmonitoring.local',
      planType: 'plus'
    })
  },
  cancelCodexLogin: async () => updateDemoAuth({ state: 'signed_out', authMode: null, email: null, planType: null }),
  logoutCodex: async () => updateDemoAuth({ state: 'signed_out', authMode: null, email: null, planType: null }),
  getSnapshot: async (requestedProjectId?: string) => {
    const selectedProject = state.projects.find((project) => project.id === requestedProjectId) ?? state.projects[0]
    if (!selectedProject) {
      return { ...state, selectedProject: null, tasks: [], events: [], findings: [], notes: [] }
    }
    return {
      ...state,
      selectedProject,
      tasks: state.tasks.filter((task) => task.projectId === selectedProject.id),
      events: state.events.filter((event) => event.projectId === selectedProject.id),
      findings: state.findings.filter((finding) => finding.projectId === selectedProject.id),
      notes: state.notes.filter((note) => note.projectId === selectedProject.id),
      runtimeSessions: state.runtimeSessions.filter((session) => session.projectId === selectedProject.id),
      runtimeEvidence: state.runtimeEvidence.filter((evidence) => evidence.projectId === selectedProject.id)
    }
  },
  addProject: async () => {
    const now = new Date().toISOString()
    const hasIosRuntime = searchParams.get('contract') === 'ios'
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name: 'ConnectedRepository',
      path: 'demo://connected-repository',
      setupCommand: '',
      testCommand: '',
      runtimeAdapter: hasIosRuntime
        ? {
            kind: 'ios-simulator',
            container: 'ConnectedRepository.xcodeproj',
            scheme: 'ConnectedRepository',
            configuration: 'Debug',
            deviceFamily: searchParams.get('device') === 'ipad' ? 'ipad' : 'iphone'
          }
        : null,
      runtimeConfigSource: hasIosRuntime ? 'detected' : null,
      publishStrategy: 'pull-request',
      isDemo: false,
      createdAt: now
    }
    state = { ...state, projects: [...state.projects, project], selectedProject: project }
    emit(null, 'project_created', 'human', `${project.name} 프로젝트 등록`)
    return project
  },
  updateProject: async (input) => {
    let updated: ProjectRecord | undefined
    state = {
      ...state,
      projects: state.projects.map((project) => {
        if (project.id !== input.projectId) return project
        updated = {
          ...project,
          name: input.name,
          setupCommand: input.setupCommand,
          testCommand: input.testCommand,
          runtimeAdapter: input.runtimeAdapter,
          runtimeConfigSource: input.runtimeAdapter
            ? project.runtimeConfigSource === 'manifest' &&
                JSON.stringify(project.runtimeAdapter) === JSON.stringify(input.runtimeAdapter)
              ? 'manifest'
              : 'detected'
            : null,
          publishStrategy: input.publishStrategy ?? project.publishStrategy ?? 'pull-request'
        }
        return updated
      })
    }
    if (!updated) throw new Error('프로젝트를 찾을 수 없습니다.')
    return updated
  },
  listProjectRuntimeEnvironment: async (requestedProjectId) =>
    demoRuntimeEnvironment.get(requestedProjectId) ?? [],
  upsertProjectRuntimeEnvironment: async (input) => {
    const entries = demoRuntimeEnvironment.get(input.projectId) ?? []
    const existing = entries.find((entry) => entry.id === input.id || entry.key === input.key)
    const updated: ProjectRuntimeEnvironmentEntry = {
      id: existing?.id ?? crypto.randomUUID(),
      projectId: input.projectId,
      key: input.key,
      label: input.label,
      scope: input.scope,
      buildSetting: input.scope === 'launch' ? null : input.buildSetting ?? null,
      launchVariable: input.scope === 'build' ? null : input.launchVariable ?? null,
      configured: input.value !== undefined || existing?.configured === true,
      updatedAt: new Date().toISOString()
    }
    const next = existing
      ? entries.map((entry) => entry.id === existing.id ? updated : entry)
      : [...entries, updated]
    demoRuntimeEnvironment.set(input.projectId, next)
    return next
  },
  deleteProjectRuntimeEnvironment: async (input) => {
    const next = (demoRuntimeEnvironment.get(input.projectId) ?? []).filter((entry) => entry.id !== input.id)
    demoRuntimeEnvironment.set(input.projectId, next)
    return next
  },
  autoConfigureProjectRuntime: async (projectIdToConfigure) => {
    const discoveryMode = searchParams.get('runtime-discovery')
    let updated: ProjectRecord | undefined
    const projectToConfigure = state.projects.find((project) => project.id === projectIdToConfigure)
    if (!projectToConfigure) throw new Error('프로젝트를 찾을 수 없습니다.')
    if (discoveryMode === 'missing') {
      return {
        project: projectToConfigure,
        discovery: {
          state: 'unavailable' as const,
          container: null,
          appSchemes: [],
          selectedScheme: null,
          message: 'Xcode 프로젝트 또는 Workspace를 찾지 못했습니다. 프로젝트 설정에서 직접 입력하세요.'
        }
      }
    }
    if (discoveryMode === 'multiple') {
      return {
        project: projectToConfigure,
        discovery: {
          state: 'selection-required' as const,
          container: `${projectToConfigure.name}.xcworkspace`,
          appSchemes: [
            { scheme: `${projectToConfigure.name}Dev`, targets: [`${projectToConfigure.name}Dev`] },
            { scheme: `${projectToConfigure.name}Prod`, targets: [`${projectToConfigure.name}Prod`] }
          ],
          selectedScheme: null,
          message: '실행 가능한 iOS 앱 Scheme 2개를 찾았습니다. 사용할 앱을 선택하세요.'
        }
      }
    }
    state = {
      ...state,
      projects: state.projects.map((project) => {
        if (project.id !== projectIdToConfigure) return project
        updated = {
          ...project,
          runtimeAdapter: {
            kind: 'ios-simulator',
            container: `${project.name}.xcodeproj`,
            scheme: project.name,
            configuration: 'Debug',
            deviceFamily: searchParams.get('device') === 'ipad' ? 'ipad' : 'iphone'
          },
          runtimeConfigSource: 'detected'
        }
        return updated
      })
    }
    if (!updated) throw new Error('프로젝트를 찾을 수 없습니다.')
    return {
      project: updated,
      discovery: {
        state: 'ready' as const,
        container: updated.runtimeAdapter!.container,
        appSchemes: [{ scheme: updated.runtimeAdapter!.scheme, targets: [updated.runtimeAdapter!.scheme] }],
        selectedScheme: updated.runtimeAdapter!.scheme,
        message: `${updated.runtimeAdapter!.scheme} iOS 앱 Scheme을 찾았습니다.`
      }
    }
  },
  inspectProject: async (requestedProjectId) => {
    const project = state.projects.find((item) => item.id === requestedProjectId)
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const connected = !project.isDemo
    const dirty = connected && searchParams.get('inspection') === 'dirty'
    const hasTestCommand = Boolean(project.testCommand.trim())
    const hasIosRuntime = Boolean(project.runtimeAdapter)
    const hasManifestContract = connected && searchParams.get('contract') === 'ios'
    const deviceFamilyLabel = project.runtimeAdapter?.deviceFamily === 'ipad' ? 'iPad' : 'iPhone'
    const dirtyFiles = [0, 1, 2, 3, 4].map((index) => ({
      kind: 'untracked' as const,
      path: `fastlane/screenshots/ko/${index}_APP_IPHONE_65_${index}.png`
    }))
    return {
      projectId: project.id,
      branch: connected ? 'main' : 'demo/main',
      headCommit: 'a1b2c3d',
      lastCommitAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      clean: !dirty,
      changeCount: dirty ? dirtyFiles.length : 0,
      changeSummary: {
        modified: 0,
        added: 0,
        deleted: 0,
        renamed: 0,
        untracked: dirty ? dirtyFiles.length : 0,
        conflicted: 0
      },
      changePreview: dirty ? dirtyFiles : [],
      hasRemote: true,
      primaryLanguage: connected ? 'TypeScript' : 'C++',
      languages: connected ? ['TypeScript', 'CSS'] : ['C++', 'C#'],
      tools: connected ? ['pnpm'] : ['CMake'],
      manifests: connected ? ['package.json', 'pnpm-lock.yaml'] : ['CMakeLists.txt'],
      trackedFileCount: connected ? 84 : 3_842,
      testFileCount: connected ? 9 : 126,
      suggestedTestCommands: connected ? ['pnpm test'] : [],
      capabilityManifest: hasIosRuntime
        ? {
            path: hasManifestContract ? '.agentmonitor/project.json' : 'AgentMonitoring 내부 설정',
            state: 'valid' as const,
            adapterKind: 'ios-simulator' as const,
            message: `${project.runtimeAdapter?.container} · ${project.runtimeAdapter?.scheme} · Debug · ${deviceFamilyLabel}`
          }
        : {
            path: '.agentmonitor/project.json',
            state: 'missing' as const,
            adapterKind: null,
            message: 'manifest가 없어 기존 코드 작업 모드로 동작합니다.'
          },
      capabilities: [
        {
          key: 'code' as const,
          status: 'ready' as const,
          detail: `Git 추적 파일 ${connected ? 84 : '3,842'}개에 접근 가능`
        },
        hasIosRuntime
          ? { key: 'build' as const, status: 'ready' as const, detail: `${project.runtimeAdapter?.scheme} Debug 빌드 adapter 사용 가능` }
          : { key: 'build' as const, status: 'missing' as const, detail: 'Xcode 프로젝트를 자동 연결하거나 직접 설정하세요.' },
        hasIosRuntime
          ? { key: 'run' as const, status: 'ready' as const, detail: `${deviceFamilyLabel} Simulator 실행 adapter 사용 가능` }
          : { key: 'run' as const, status: 'missing' as const, detail: 'Build 연결 시 Simulator 실행도 함께 활성화됩니다.' },
        hasIosRuntime
          ? { key: 'observe' as const, status: 'ready' as const, detail: 'Simulator 화면 캡처 · 접근성 트리 수집 사용 가능' }
          : { key: 'observe' as const, status: 'missing' as const, detail: 'Run 연결 시 화면과 접근성 관찰이 함께 활성화됩니다.' },
        hasIosRuntime
          ? { key: 'act' as const, status: 'ready' as const, detail: '작업 등록 시 identifier UI 조작 시나리오 생성 가능' }
          : { key: 'act' as const, status: 'missing' as const, detail: 'Run 연결 후 새 작업에서 UI 시나리오를 만들 수 있습니다.' },
        hasTestCommand
          ? { key: 'verify' as const, status: 'ready' as const, detail: `검증 명령: ${project.testCommand.trim()}` }
          : hasIosRuntime
            ? { key: 'verify' as const, status: 'declared' as const, detail: '검증 명령 · 실행 시나리오 계약 선언 · 실행 어댑터 연결 예정' }
            : { key: 'verify' as const, status: 'missing' as const, detail: '프로젝트 검증 명령이 설정되지 않았습니다.' }
      ],
      inspectedAt: new Date().toISOString()
    }
  },
  getSourceControlStatus: async (requestedProjectId) => sourceControlStatus(requestedProjectId),
  getSourceControlDiff: async (input) => ({
    projectId: input.projectId,
    path: input.path,
    area: input.area,
    patch: input.path.endsWith('Project.swift')
      ? 'diff --git a/Projects/Shared/Featcher/Project.swift b/Projects/Shared/Featcher/Project.swift\n@@ -34,2 +34,8 @@\n+        .target(\n+            name: "FeatcherTests"\n+        )\n'
      : 'diff --git a/Projects/Shared/Featcher/Tests/FetcherTests.swift b/Projects/Shared/Featcher/Tests/FetcherTests.swift\nnew file mode 100644\n+import Testing\n+@Test func fetchesItems() {}\n',
    available: true,
    binary: false,
    truncated: false
  }),
  stageSourceControlPaths: async (input) => {
    const selected = new Set(input.paths)
    demoSourceControlFiles = demoSourceControlFiles.map((file) => selected.has(file.path)
      ? { ...file, staged: file.working, working: null }
      : file)
    return sourceControlStatus(input.projectId)
  },
  unstageSourceControlPaths: async (input) => {
    const selected = new Set(input.paths)
    demoSourceControlFiles = demoSourceControlFiles.map((file) => selected.has(file.path)
      ? { ...file, working: file.staged, staged: null }
      : file)
    return sourceControlStatus(input.projectId)
  },
  stageAllSourceControlChanges: async (requestedProjectId) => {
    demoSourceControlFiles = demoSourceControlFiles.map((file) => ({
      ...file,
      staged: file.working ?? file.staged,
      working: null
    }))
    return sourceControlStatus(requestedProjectId)
  },
  unstageAllSourceControlChanges: async (requestedProjectId) => {
    demoSourceControlFiles = demoSourceControlFiles.map((file) => ({
      ...file,
      working: file.staged ?? file.working,
      staged: null
    }))
    return sourceControlStatus(requestedProjectId)
  },
  setSourceControlIdentity: async (input) => {
    demoSourceControlIdentity = { name: input.name, email: input.email, complete: true }
    return sourceControlStatus(input.projectId)
  },
  commitSourceControlChanges: async (input) => {
    demoSourceControlFiles = input.includeWorking
      ? []
      : demoSourceControlFiles.filter((file) => !file.staged)
    return {
      commit: 'd4e5f6a',
      summary: `[main d4e5f6a] ${input.message}`,
      status: sourceControlStatus(input.projectId)
    }
  },
  fetchSourceControlRemote: async (requestedProjectId) => sourceControlStatus(requestedProjectId),
  pushSourceControlRemote: async (requestedProjectId) => {
    demoSourceControlRemote = {
      ...demoSourceControlRemote,
      upstream: demoSourceControlRemote.upstream ?? 'origin/main',
      ahead: 0,
      diverged: false
    }
    return sourceControlStatus(requestedProjectId)
  },
  syncSourceControlRemote: async (requestedProjectId) => {
    demoSourceControlRemote = { ...demoSourceControlRemote, behind: 0, diverged: false }
    return sourceControlStatus(requestedProjectId)
  },
  getProjectSimulatorStatus: async (requestedProjectId) => demoSimulatorSession(requestedProjectId),
  listProjectRunDestinations: async (requestedProjectId) => {
    const project = state.projects.find((item) => item.id === requestedProjectId)
    const family = project?.runtimeAdapter?.deviceFamily ?? 'iphone'
    const familyLabel = family === 'iphone' ? 'iPhone' : 'iPad'
    return [
      {
        id: `simulator:DEMO-${family.toUpperCase()}-UDID`,
        name: family === 'iphone' ? 'iPhone 16 Pro' : 'iPad Pro 13-inch',
        kind: 'simulator' as const,
        deviceFamily: family,
        osVersion: 'iOS 26.4',
        available: true,
        statusLabel: '사용 가능',
        detail: 'Simulator · iOS 26.4 · 종료됨'
      },
      {
        id: `physical:DEMO-PHYSICAL-${family.toUpperCase()}-UDID`,
        name: `테스트 ${familyLabel}`,
        kind: 'physical' as const,
        deviceFamily: family,
        osVersion: 'iOS 26.3',
        available: true,
        statusLabel: '연결됨',
        detail: '실기기 · iOS 26.3 · 연결됨'
      },
      {
        id: `physical:DEMO-OFFLINE-${family.toUpperCase()}-UDID`,
        name: `오프라인 ${familyLabel}`,
        kind: 'physical' as const,
        deviceFamily: family,
        osVersion: 'iOS 26.2',
        available: false,
        statusLabel: '개발 터널 연결 필요',
        detail: '실기기 · iOS 26.2 · 개발 터널 연결 필요'
      }
    ]
  },
  launchProjectSimulator: async (requestedProjectId, destinationId) => {
    const project = state.projects.find((item) => item.id === requestedProjectId)
    const family = project?.runtimeAdapter?.deviceFamily ?? 'iphone'
    const familyLabel = family === 'iphone' ? 'iPhone' : 'iPad'
    const physical = destinationId?.startsWith('physical:') ?? false
    const deviceName = physical ? `테스트 ${familyLabel}` : family === 'iphone' ? 'iPhone 16 Pro' : 'iPad Pro 13-inch'
    return updateDemoSimulator(requestedProjectId, {
      source: {
        kind: 'project',
        taskId: null,
        branchName: null
      },
      status: 'running',
      destinationKind: physical ? 'physical' : 'simulator',
      deviceId: physical ? `DEMO-PHYSICAL-${family.toUpperCase()}-UDID` : `DEMO-${family.toUpperCase()}-UDID`,
      deviceName,
      bundleIdentifier: 'com.example.Demo',
      processId: 4242,
      message: `${deviceName}에서 앱을 실행하고 있습니다.`,
      error: null
    })
  },
  launchTaskSimulator: async (taskId, destinationId) => {
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task?.worktreePath) throw new Error('이 작업의 격리 작업공간이 없습니다.')
    const project = state.projects.find((item) => item.id === task.projectId)
    const family = project?.runtimeAdapter?.deviceFamily ?? 'iphone'
    const familyLabel = family === 'iphone' ? 'iPhone' : 'iPad'
    const physical = destinationId?.startsWith('physical:') ?? false
    const deviceName = physical ? `테스트 ${familyLabel}` : family === 'iphone' ? 'iPhone 16 Pro' : 'iPad Pro 13-inch'
    return updateDemoSimulator(task.projectId, {
      source: {
        kind: 'task-worktree',
        taskId: task.id,
        branchName: task.branchName
      },
      status: 'running',
      destinationKind: physical ? 'physical' : 'simulator',
      deviceId: physical ? `DEMO-PHYSICAL-${family.toUpperCase()}-UDID` : `DEMO-${family.toUpperCase()}-UDID`,
      deviceName,
      bundleIdentifier: 'com.example.Demo',
      processId: 4242,
      message: `작업 브랜치 앱을 ${deviceName}에서 실행하고 있습니다.`,
      error: null
    })
  },
  restartProjectSimulator: async (requestedProjectId) => updateDemoSimulator(requestedProjectId, {
    status: 'running',
    processId: 4243,
    message: `${demoSimulatorSession(requestedProjectId).deviceName ?? 'iOS 기기'}에서 앱을 다시 실행했습니다.`,
    error: null
  }),
  stopProjectSimulator: async (requestedProjectId) => updateDemoSimulator(requestedProjectId, {
    status: 'stopped',
    processId: null,
    message: `${demoSimulatorSession(requestedProjectId).deviceName ?? 'iOS 기기'}에서 앱을 종료했습니다.`,
    error: null
  }),
  generateTechSpec: async (input) => ({
    version: 1,
    revision: 1,
    summary: `${input.title} 구현 범위와 검증 기준을 정리했습니다.`,
    markdown: [
      '# 목표와 완료 조건',
      '',
      input.prompt,
      '',
      '## 구현 범위',
      '',
      '- 현재 프로젝트 구조를 유지하면서 요구된 기능을 추가합니다.',
      '- 사용자에게 보이는 결과와 실패 경로를 함께 구현합니다.',
      '',
      '## 제안 설계',
      '',
      '- 기존 모듈 경계를 확인하고 가장 가까운 기능 영역에 구현합니다.',
      '- 상태 변화와 오류 처리를 화면과 테스트에서 관찰할 수 있게 합니다.',
      '',
      '## 검증 전략',
      '',
      '- 프로젝트 테스트로 로직과 회귀를 확인합니다.',
      '- 화면 동작이 포함되면 Simulator 시나리오로 사용자 결과를 확인합니다.',
      '',
      '## 제외 범위',
      '',
      '- 요구사항과 직접 관련 없는 구조 변경은 포함하지 않습니다.'
    ].join('\n'),
    openQuestions: ['오류 상태에서 사용자에게 보여줄 문구를 기존 디자인과 동일하게 유지할까요?'],
    changeSummary: '요구사항과 현재 프로젝트를 기준으로 최초 초안을 만들었습니다.'
  }),
  refineTechSpec: async (input) => ({
    version: 1,
    revision: input.current.revision + 1,
    summary: input.current.summary,
    markdown: `${input.current.markdown}\n\n## 사용자 피드백 반영\n\n- ${input.feedback}`,
    openQuestions: [],
    changeSummary: `사용자 의견 “${input.feedback}”을 설계와 검증 범위에 반영했습니다.`
  }),
  generateRuntimeScenario: async (input) => {
    const project = state.projects.find((item) => item.id === input.projectId)
    if (!project?.runtimeAdapter) throw new Error('iOS 실행 설정이 없습니다.')
    const needsLocation = `${input.title}\n${input.prompt}`.includes('위치')
    return {
      summary: needsLocation
        ? '위치 권한을 준비한 뒤 현재 위치 버튼의 동작을 확인합니다.'
        : '입력한 항목을 추가하고 목록에 표시되는지 확인합니다.',
      contract: {
        version: 1,
        adapter: project.runtimeAdapter,
        capabilities: {
          build: true,
          run: true,
          observe: ['screen', 'accessibility'],
          act: ['ui'],
          verify: ['test-command', 'runtime-scenario']
        },
        runtimeScenario: {
          permissions: needsLocation ? [{ service: 'location', state: 'granted' }] : [],
          actions: needsLocation
            ? [{ kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }]
            : [
                { kind: 'type-text', identifier: 'item-input', text: '우유', timeoutSeconds: 10 },
                { kind: 'tap', identifier: 'add-item', timeoutSeconds: 10 }
              ],
          assertions: [
            needsLocation
              ? { kind: 'accessibility' as const, name: '현재 위치 표시', identifier: 'current-location-marker', property: 'exists' as const, expected: true }
              : { kind: 'accessibility' as const, name: '추가한 항목 표시', identifier: 'item-row', property: 'exists' as const, expected: true },
            { kind: 'evidence', name: '최종 화면 저장', target: 'screen' },
            { kind: 'evidence', name: '접근성 트리 저장', target: 'accessibility' },
            { kind: 'evidence', name: 'UI 조작 결과 저장', target: 'ui-actions' }
          ]
        }
      }
    }
  },
  recommendVerificationPlan: async (input) => {
    const project = state.projects.find((item) => item.id === input.projectId)
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const mode = project.runtimeAdapter && project.testCommand.trim()
      ? 'both' as const
      : project.runtimeAdapter
        ? 'simulator-runtime' as const
        : project.testCommand.trim()
          ? 'project-tests' as const
          : 'manual-review' as const
    return {
      summary: mode === 'both'
        ? '로직 회귀와 실제 화면 동작을 함께 확인해야 해서 두 검증을 모두 추천합니다.'
        : mode === 'simulator-runtime'
          ? '화면 동작을 Simulator에서 직접 확인하는 검증을 추천합니다.'
          : mode === 'project-tests'
            ? '프로젝트 테스트로 요구사항과 회귀를 확인하는 방식을 추천합니다.'
            : '자동 검증 연결이 없어 사람이 직접 확인하는 방식을 추천합니다.',
      plan: {
        version: 1 as const,
        mode,
        testDesign: mode === 'project-tests' || mode === 'both' ? 'automatic' as const : 'skip' as const,
        runtimeSource: mode === 'simulator-runtime' || mode === 'both' ? 'task-scenario' as const : 'off' as const
      }
    }
  },
  removeProject: async (projectIdToRemove) => {
    const projects = state.projects.filter((project) => project.id !== projectIdToRemove)
    state = {
      ...state,
      projects,
      selectedProject: projects[0] ?? null,
      tasks: state.tasks.filter((task) => task.projectId !== projectIdToRemove),
      events: state.events.filter((event) => event.projectId !== projectIdToRemove),
      findings: state.findings.filter((finding) => finding.projectId !== projectIdToRemove),
      notes: state.notes.filter((note) => note.projectId !== projectIdToRemove),
      runtimeSessions: state.runtimeSessions.filter((session) => session.projectId !== projectIdToRemove),
      runtimeEvidence: state.runtimeEvidence.filter((evidence) => evidence.projectId !== projectIdToRemove)
    }
  },
  createTask: async (input) => {
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt,
      status: 'queued',
      provider: 'codex',
      maxAttempts: input.maxAttempts,
      attempt: 0,
      branchName: null,
      worktreePath: null,
      sourceBranch: null,
      baseCommit: null,
      verificationBaseCommit: null,
      publishStrategy: input.publishStrategy,
      publication: null,
      runtimeContract: input.runtimeContract ?? null,
      runtimeScenarioSummary: input.runtimeScenarioSummary ?? null,
      runtimeScenarioApprovedAt: input.runtimeContract ? now : null,
      techSpec: input.techSpec ? { ...input.techSpec, approvedAt: now } : null,
      verificationPlan: input.verificationPlan,
      verificationResult: createVerificationResult(input.verificationPlan, now),
      createdAt: now,
      updatedAt: now
    }
    state = { ...state, tasks: [task, ...state.tasks] }
    emit(task, 'task_created', 'human', `${task.title} 작업 등록`)
    return task
  },
  regenerateTaskRuntimeScenario: async (taskId) => {
    const current = state.tasks.find((task) => task.id === taskId)
    if (!current) throw new Error('작업을 찾을 수 없습니다.')
    if (!current.runtimeContract || current.runtimeContract.version === 2) return current
    const legacy = current.runtimeContract
    const steps = [
      ...legacy.runtimeScenario.actions.map((action) => ({ kind: 'action' as const, action })),
      ...(legacy.runtimeScenario.assertions.length > 0
        ? [{ kind: 'assert' as const, assertions: legacy.runtimeScenario.assertions }]
        : [])
    ]
    const updated: TaskRecord = {
      ...current,
      runtimeContract: {
        version: 2,
        adapter: legacy.adapter,
        capabilities: legacy.capabilities,
        environmentRequirements: [],
        runtimeScenarios: {
          cases: [{
            id: 'demo-updated-scenario',
            name: '최신화된 데모 시나리오',
            preconditions: { permissions: legacy.runtimeScenario.permissions ?? [] },
            steps
          }]
        }
      },
      runtimeScenarioSummary: '독립 케이스와 단계별 체크포인트를 사용하는 최신 시나리오',
      runtimeScenarioApprovedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    state = { ...state, tasks: state.tasks.map((task) => task.id === taskId ? updated : task) }
    return updated
  },
  getTaskChanges: async (taskId) => {
    const task = state.tasks.find((item) => item.id === taskId)
    const available = Boolean(task?.worktreePath)
    return {
      taskId,
      available,
      files: available
        ? [
            { path: 'src/navigation/RouteMonitor.ts', status: 'M', additions: 28, deletions: 6 },
            { path: 'tests/RouteMonitor.test.ts', status: 'A', additions: 74, deletions: 0 }
          ]
        : [],
      stat: available ? '2 files changed, 102 insertions(+), 6 deletions(-)' : '',
      patch: available
        ? 'diff --git a/src/navigation/RouteMonitor.ts b/src/navigation/RouteMonitor.ts\n+export function detectRouteDeviation() {\n+  return true\n+}\n'
        : '',
      truncated: false
    }
  },
  runTask: async (taskId) => {
    const task = updateTask(taskId, 'running', {
      branchName: `agentmonitor/demo-${taskId.slice(0, 6)}`,
      worktreePath: `demo://worktrees/${taskId}`,
      sourceBranch: 'main',
      baseCommit: '1111111111111111111111111111111111111111',
      verificationBaseCommit: '1111111111111111111111111111111111111111'
    })
    emit(task, 'task_started', 'orchestrator', `${task.title} 실행 시작`)
    const plan = task.verificationPlan
    if (plan && plan.mode !== 'manual-review') {
      updateTaskVerification(taskId, 'environment-setup', 'running', '격리 작업공간의 의존성을 준비하고 있습니다.')
      emit(task, 'environment_started', 'environment', '격리 작업공간 환경 준비 시작')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
      updateTaskVerification(taskId, 'environment-setup', 'passed', '환경 준비를 완료했습니다.')
      emit(task, 'environment_passed', 'environment', '격리 작업공간 환경 준비 완료')
    }
    if (plan && ['project-tests', 'both'].includes(plan.mode) && !['existing-tests', 'skip'].includes(plan.testDesign)) {
      updateTaskVerification(taskId, 'test-design', 'running', '테스트 설계 중')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
      updateTaskVerification(taskId, 'test-design', 'passed', '테스트 설계와 비평이 끝났습니다.')
      emit(task, 'agent', 'test-designer', '테스트 설계 완료')
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450))
    if (!plan || ['project-tests', 'both'].includes(plan.mode)) {
      updateTaskVerification(taskId, 'project-tests', 'passed', '프로젝트 테스트가 모두 통과했습니다.')
      emit(task, 'test_passed', 'test-runner', '프로젝트 테스트가 모두 통과했습니다.')
    }
    if (plan && ['simulator-runtime', 'both'].includes(plan.mode)) {
      updateTaskVerification(taskId, 'simulator-runtime', 'passed', 'Simulator 검증이 통과했습니다.')
    }
    updateTaskVerification(taskId, 'reviewer', 'passed', 'Reviewer가 추가 문제를 찾지 못했습니다.')
    updateTask(taskId, plan?.mode === 'manual-review' ? 'awaiting_manual_validation' : 'awaiting_approval')
    emit(task, 'agent', 'reviewer', '최종 검토가 끝났습니다. 승인을 기다립니다.')
  },
  continueTask: async (input) => {
    const current = state.tasks.find((task) => task.id === input.taskId)
    if (!current) throw new Error('작업을 찾을 수 없습니다.')
    if (!['awaiting_approval', 'awaiting_manual_validation'].includes(current.status)) {
      throw new Error('승인을 기다리는 작업에만 추가 수정 요청을 보낼 수 있습니다.')
    }
    if (!current.worktreePath) throw new Error('추가 수정을 이어갈 격리 작업공간을 찾을 수 없습니다.')
    const instruction = input.instruction.trim()
    const requests = current.revisionRequests ?? []
    const nextRequests = requests.at(-1)?.instruction === instruction && !requests.at(-1)?.appliedAt
      ? requests
      : [...requests, { id: crypto.randomUUID(), instruction, createdAt: new Date().toISOString(), appliedAt: null }]
    const updated: TaskRecord = {
      ...current,
      publication: null,
      revisionRequests: nextRequests,
      updatedAt: new Date().toISOString()
    }
    state = { ...state, tasks: state.tasks.map((task) => task.id === input.taskId ? updated : task) }
    if (nextRequests.length !== requests.length) {
      emit(updated, 'task_revision_requested', 'human', `추가 수정 요청: ${instruction}`)
    }
    await demoBridge.runTask(input.taskId)
    const appliedAt = new Date().toISOString()
    state = {
      ...state,
      tasks: state.tasks.map((task) => task.id === input.taskId
        ? {
            ...task,
            revisionRequests: (task.revisionRequests ?? []).map((request) => ({ ...request, appliedAt })),
            updatedAt: appliedAt
          }
        : task)
    }
  },
  retryTaskVerification: async (taskId) => {
    const task = updateTask(taskId, 'running')
    updateTaskVerification(taskId, 'test-design', 'skipped', '기존 구현과 테스트를 유지하고 검증만 다시 실행합니다.')
    updateTaskVerification(taskId, 'environment-setup', 'running', '격리 작업공간의 의존성을 다시 준비하고 있습니다.')
    emit(task, 'environment_started', 'environment', '구현 없이 환경 준비와 검증 재실행')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    updateTaskVerification(taskId, 'environment-setup', 'passed', '환경 준비를 완료했습니다.')
    updateTaskVerification(taskId, 'project-tests', 'passed', '프로젝트 테스트가 다시 통과했습니다.')
    updateTaskVerification(taskId, 'reviewer', 'passed', 'Reviewer가 추가 문제를 찾지 못했습니다.')
    updateTask(taskId, task.verificationPlan?.mode === 'manual-review' ? 'awaiting_manual_validation' : 'awaiting_approval')
    emit(task, 'environment_passed', 'environment', '기존 구현을 수정하지 않고 검증을 완료했습니다.')
  },
  stopTask: async (taskId) => {
    const task = updateTask(taskId, 'stopped')
    emit(task, 'task_stopped', 'human', '작업을 중단했습니다.')
  },
  approveTask: async (taskId) => {
    const current = state.tasks.find((task) => task.id === taskId)
    if (!current) throw new Error('작업을 찾을 수 없습니다.')
    if ((current.publishStrategy ?? 'pull-request') === 'pull-request') {
      const publication = {
        strategy: 'pull-request' as const,
        status: 'awaiting_merge' as const,
        remoteName: 'origin',
        baseBranch: 'main',
        remoteBranch: current.branchName,
        pullRequestUrl: 'https://github.com/example/AgentMonitoring/pull/42',
        publishedCommit: 'd4e5f6a7',
        mergeCommit: null,
        message: 'PR을 만들었습니다. GitHub에서 병합한 뒤 상태를 확인하세요.',
        updatedAt: new Date().toISOString()
      }
      state = { ...state, tasks: state.tasks.map((task) => task.id === taskId ? { ...task, publication } : task) }
      const task = updateTask(taskId, 'awaiting_merge')
      emit(task, 'agent', 'git', '원격 브랜치 게시 및 PR 생성')
      return { outcome: 'pr_opened', message: '작업 브랜치를 원격에 올리고 PR을 만들었습니다.' }
    }
    const task = updateTask(taskId, 'completed', { worktreePath: null })
    emit(task, 'task_completed', 'human', `${task.title} 변경을 원격 main에 게시`)
    return { outcome: 'published', message: '원격 main에 게시하고 로컬 브랜치도 동기화했습니다.' }
  },
  refreshTaskPublication: async (taskId) => {
    const task = updateTask(taskId, 'completed', { worktreePath: null })
    state = {
      ...state,
      tasks: state.tasks.map((item) => item.id === taskId && item.publication
        ? { ...item, publication: { ...item.publication, status: 'published', message: 'PR 병합과 로컬 동기화를 완료했습니다.', updatedAt: new Date().toISOString() } }
        : item)
    }
    emit(task, 'task_completed', 'human', `${task.title} PR 병합 확인 및 로컬 동기화`)
    return { outcome: 'published', message: 'PR 병합을 확인하고 로컬 main을 동기화했습니다.' }
  },
  switchTaskPublicationToPullRequest: async (taskId) => {
    let updated: TaskRecord | undefined
    state = {
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== taskId) return task
        updated = { ...task, publishStrategy: 'pull-request', publication: null, updatedAt: new Date().toISOString() }
        return updated
      })
    }
    if (!updated) throw new Error('작업을 찾을 수 없습니다.')
    return updated
  },
  discardTask: async (taskId) => {
    const task = updateTask(taskId, 'discarded', { worktreePath: null })
    emit(task, 'task_discarded', 'human', `${task.title} 변경 폐기`)
  },
  getStorageOverview: async () => ({
    policy: { runtimeArtifactRetentionDays },
    worktreeBytes: 184 * 1_024 * 1_024,
    runtimeArtifactBytes: 426 * 1_024 * 1_024,
    totalBytes: 610 * 1_024 * 1_024,
    worktreeCount: 2,
    runtimeArtifactCount: 7,
    cleanupCandidateCount: 3,
    branchCandidateCount: 4,
    scannedAt: new Date().toISOString()
  }),
  setStoragePolicy: async (policy) => {
    runtimeArtifactRetentionDays = policy.runtimeArtifactRetentionDays
    return demoBridge.getStorageOverview()
  },
  cleanupStorage: async (input) => ({
    worktreesRemoved: 1,
    runtimeArtifactsRemoved: 2,
    branchesRemoved: input.removeLocalBranches ? 4 : 0,
    bytesReclaimed: 256 * 1_024 * 1_024,
    warnings: [],
    overview: {
      policy: { runtimeArtifactRetentionDays },
      worktreeBytes: 0,
      runtimeArtifactBytes: 354 * 1_024 * 1_024,
      totalBytes: 354 * 1_024 * 1_024,
      worktreeCount: 0,
      runtimeArtifactCount: 5,
      cleanupCandidateCount: 0,
      branchCandidateCount: input.removeLocalBranches ? 0 : 4,
      scannedAt: new Date().toISOString()
    }
  }),
  setFindingResolved: async (findingId, resolved) => {
    let updated: DashboardSnapshot['findings'][number] | undefined
    state = {
      ...state,
      findings: state.findings.map((finding) => {
        if (finding.id !== findingId) return finding
        updated = { ...finding, resolved, resolvedAt: resolved ? new Date().toISOString() : null }
        return updated
      })
    }
    if (!updated) throw new Error('버그를 찾을 수 없습니다.')
    emit(null, resolved ? 'finding_resolved' : 'finding_reopened', 'human', `${updated.title} 상태 변경`)
    return updated
  },
  addNote: async (requestedProjectId, title, body) => {
    const note = {
      id: crypto.randomUUID(),
      projectId: requestedProjectId,
      title,
      body,
      createdAt: new Date().toISOString()
    }
    state = { ...state, notes: [note, ...state.notes] }
    emit(null, 'note_created', 'human', `${title} 메모 작성`)
    return note
  },
  updateNote: async (noteId, title, body) => {
    let updated: DashboardSnapshot['notes'][number] | undefined
    state = {
      ...state,
      notes: state.notes.map((note) => {
        if (note.id !== noteId) return note
        updated = { ...note, title, body }
        return updated
      })
    }
    if (!updated) throw new Error('메모를 찾을 수 없습니다.')
    emit(null, 'note_updated', 'human', `${title} 메모 수정`)
    return updated
  },
  deleteNote: async (noteId) => {
    const note = state.notes.find((item) => item.id === noteId)
    if (!note) throw new Error('메모를 찾을 수 없습니다.')
    state = { ...state, notes: state.notes.filter((item) => item.id !== noteId) }
    emit(null, 'note_deleted', 'human', `${note.title} 메모 삭제`)
  },
  openTaskInXcode: async () => undefined,
  openPath: async () => undefined,
  openExternalUrl: async () => undefined,
  openFeedback: async () => undefined,
  onCodexAuthChanged: (listener) => {
    authListeners.add(listener)
    return () => authListeners.delete(listener)
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  onProjectSimulatorChanged: (listener) => {
    simulatorListeners.add(listener)
    return () => simulatorListeners.delete(listener)
  }
}
