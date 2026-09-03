import type {
  AgentMonitoringBridge,
  CodexAuthStatus,
  DashboardSnapshot,
  EventKind,
  EventRecord,
  ProjectRecord,
  TaskRecord,
  TaskStatus
} from '../../shared/types'

const projectId = '11111111-1111-4111-8111-111111111111'
const secondaryProjectId = '22222222-2222-4222-8222-222222222222'

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
      isDemo: true,
      createdAt: atOffset(-30, 9)
    },
    {
      id: secondaryProjectId,
      name: 'AgentMonitoring',
      path: `demo://${secondaryProjectId}`,
      testCommand: '',
      runtimeAdapter: null,
      runtimeConfigSource: null,
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
      runtimeContract: null,
      runtimeScenarioSummary: null,
      runtimeScenarioApprovedAt: null,
      createdAt,
      updatedAt: new Date(new Date(createdAt).getTime() + 62 * 60 * 1000).toISOString()
    }
  }).reverse()
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
  changes: Partial<Pick<TaskRecord, 'branchName' | 'worktreePath'>> = {}
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

export const demoBridge: AgentMonitoringBridge = {
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
          testCommand: input.testCommand,
          runtimeAdapter: input.runtimeAdapter,
          runtimeConfigSource: input.runtimeAdapter ? 'detected' : null
        }
        return updated
      })
    }
    if (!updated) throw new Error('프로젝트를 찾을 수 없습니다.')
    return updated
  },
  inspectProject: async (requestedProjectId) => {
    const project = state.projects.find((item) => item.id === requestedProjectId)
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const connected = !project.isDemo
    const dirty = connected && searchParams.get('inspection') === 'dirty'
    const hasTestCommand = Boolean(project.testCommand.trim())
    const hasIosContract = connected && searchParams.get('contract') === 'ios'
    const deviceFamilyLabel = searchParams.get('device') === 'iphone' ? 'iPhone' : 'iPad'
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
      capabilityManifest: hasIosContract
        ? {
            path: '.agentmonitor/project.json',
            state: 'valid' as const,
            adapterKind: 'ios-simulator' as const,
            message: `PopPang.xcworkspace · PopPang · Debug · ${deviceFamilyLabel}`
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
        hasIosContract
          ? { key: 'build' as const, status: 'ready' as const, detail: 'PopPang Debug 빌드 adapter 사용 가능' }
          : { key: 'build' as const, status: 'missing' as const, detail: '프로젝트 계약에 빌드 방식이 없습니다.' },
        hasIosContract
          ? { key: 'run' as const, status: 'ready' as const, detail: `${deviceFamilyLabel} Simulator 실행 adapter 사용 가능` }
          : { key: 'run' as const, status: 'missing' as const, detail: '프로젝트 계약에 앱 실행 방식이 없습니다.' },
        hasIosContract
          ? { key: 'observe' as const, status: 'ready' as const, detail: 'Simulator 화면 캡처 · XCTest 접근성 트리 수집 · Debug bridge 앱 상태 수집 사용 가능' }
          : { key: 'observe' as const, status: 'missing' as const, detail: '화면·접근성·상태 관찰이 선언되지 않았습니다.' },
        hasIosContract
          ? { key: 'act' as const, status: 'ready' as const, detail: 'accessibility identifier UI 조작 2단계 · Debug fixture signed-in-home 적용 사용 가능' }
          : { key: 'act' as const, status: 'missing' as const, detail: 'UI·fixture 조작이 선언되지 않았습니다.' },
        hasTestCommand
          ? { key: 'verify' as const, status: 'ready' as const, detail: `검증 명령: ${project.testCommand.trim()}` }
          : hasIosContract
            ? { key: 'verify' as const, status: 'declared' as const, detail: '검증 명령 · 실행 시나리오 계약 선언 · 실행 어댑터 연결 예정' }
            : { key: 'verify' as const, status: 'missing' as const, detail: '프로젝트 검증 명령이 설정되지 않았습니다.' }
      ],
      inspectedAt: new Date().toISOString()
    }
  },
  generateRuntimeScenario: async (input) => {
    const project = state.projects.find((item) => item.id === input.projectId)
    if (!project?.runtimeAdapter) throw new Error('iOS 실행 설정이 없습니다.')
    return {
      summary: '입력한 항목을 추가하고 목록에 표시되는지 확인합니다.',
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
          actions: [
            { kind: 'type-text', identifier: 'item-input', text: '우유', timeoutSeconds: 10 },
            { kind: 'tap', identifier: 'add-item', timeoutSeconds: 10 }
          ],
          assertions: [
            { kind: 'accessibility', name: '추가한 항목 표시', identifier: 'item-row', property: 'exists', expected: true },
            { kind: 'evidence', name: '최종 화면 저장', target: 'screen' },
            { kind: 'evidence', name: '접근성 트리 저장', target: 'accessibility' },
            { kind: 'evidence', name: 'UI 조작 결과 저장', target: 'ui-actions' }
          ]
        }
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
      runtimeContract: input.runtimeContract ?? null,
      runtimeScenarioSummary: input.runtimeScenarioSummary ?? null,
      runtimeScenarioApprovedAt: input.runtimeContract ? now : null,
      createdAt: now,
      updatedAt: now
    }
    state = { ...state, tasks: [task, ...state.tasks] }
    emit(task, 'task_created', 'human', `${task.title} 작업 등록`)
    return task
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
      worktreePath: `demo://worktrees/${taskId}`
    })
    emit(task, 'task_started', 'orchestrator', `${task.title} 실행 시작`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450))
    emit(task, 'agent', 'test-designer', '테스트 설계 완료')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 450))
    emit(task, 'test_passed', 'test-runner', '프로젝트 테스트가 모두 통과했습니다.')
    updateTask(taskId, 'awaiting_approval')
    emit(task, 'agent', 'reviewer', '최종 검토가 끝났습니다. 승인을 기다립니다.')
  },
  stopTask: async (taskId) => {
    const task = updateTask(taskId, 'stopped')
    emit(task, 'task_stopped', 'human', '작업을 중단했습니다.')
  },
  approveTask: async (taskId) => {
    const task = updateTask(taskId, 'completed', { worktreePath: null })
    emit(task, 'task_completed', 'human', `${task.title} 변경을 원본 브랜치에 적용`)
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
  openPath: async () => undefined,
  openFeedback: async () => undefined,
  onCodexAuthChanged: (listener) => {
    authListeners.add(listener)
    return () => authListeners.delete(listener)
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}
