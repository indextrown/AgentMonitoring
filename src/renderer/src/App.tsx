import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Circle,
  Clock3,
  Command,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  HardDrive,
  GitCompareArrows,
  GitBranch,
  GitCommitHorizontal,
  Image as ImageIcon,
  LayoutDashboard,
  ListTodo,
  LogIn,
  LogOut,
  LoaderCircle,
  MessageSquare,
  NotebookPen,
  Octagon,
  Pencil,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  SquareTerminal,
  StepForward,
  Trash2,
  X
} from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import {
  buildDailySeries,
  buildHourlyActivity,
  buildRuntimeTaskReport,
  isActiveTask
} from '../../shared/domain'
import { normalizeRuntimeScenarioEnvironment } from '../../shared/runtime-scenario-policy'
import {
  CODEX_MODEL_ROLES,
  CODEX_MODEL_ROLE_LABELS,
  RECOMMENDED_CODEX_MODEL_PROFILE,
  codexExecutionMode
} from '../../shared/codex-models'
import { AGENT_MONITORING_BRIDGE_VERSION } from '../../shared/types'
import type {
  AgentMonitoringBridge,
  CodexAuthStatus,
  CodexModelCatalog,
  CodexModelProfile,
  CodexModelSelection,
  DashboardSnapshot,
  EventKind,
  EventRecord,
  GeneratedTechSpec,
  GeneratedRuntimeScenario,
  NoteRecord,
  ProjectCapabilityKey,
  ProjectCapabilityStatus,
  ProjectChangeKind,
  ProjectRecord,
  ProjectRunDestination,
  ProjectRuntimeEnvironmentEntry,
  ProjectRuntimeDiscovery,
  ProjectSimulatorSession,
  PublishStrategy,
  ProjectInspection,
  RuntimeEvidenceRecord,
  RuntimeAcceptanceAssertion,
  RuntimePrivacyPermission,
  RuntimeScenarioCase,
  RuntimeSessionRecord,
  RuntimeSessionStatus,
  RuntimeUiAction,
  RuntimeArtifactRetentionDays,
  StorageCleanupResult,
  StorageOverview,
  TaskChanges,
  TaskRecord,
  TaskStatus,
  TaskVerificationPlan,
  TestDesignStrategy,
  VerificationMode,
  VerificationPlanRecommendation,
  VerificationStepStatus,
  RuntimeVerificationSource,
  SourceControlArea,
  SourceControlDiff,
  SourceControlFile,
  SourceControlStatus,
  UpdateProjectInput
} from '../../shared/types'
import { demoBridge } from './demo'

type Page = 'dashboard' | 'tasks' | 'findings' | 'notes' | 'source-control' | 'projects'
type Range = 7 | 30 | 'all'
type BridgeConnectionIssue = 'missing' | 'outdated'

const electronRuntime = navigator.userAgent.toLowerCase().includes('electron')
const runtimeBridge = window.agentMonitoring as Partial<AgentMonitoringBridge> | undefined
const requiredBridgeMethods: Array<keyof AgentMonitoringBridge> = [
  'listCodexModels',
  'autoConfigureProjectRuntime',
  'listProjectRuntimeEnvironment',
  'upsertProjectRuntimeEnvironment',
  'deleteProjectRuntimeEnvironment',
  'generateTechSpec',
  'refineTechSpec',
  'recommendVerificationPlan',
  'retryTaskVerification',
  'continueTask',
  'updateTaskRevisionRequest',
  'cancelTaskRevisionRequest',
  'moveTaskRevisionRequest',
  'setTaskRevisionQueuePaused',
  'runNextTaskRevision',
  'getStorageOverview',
  'setStoragePolicy',
  'cleanupStorage',
  'getSourceControlStatus',
  'getSourceControlDiff',
  'stageSourceControlPaths',
  'commitSourceControlChanges',
  'fetchSourceControlRemote',
  'pushSourceControlRemote',
  'syncSourceControlRemote',
  'getProjectSimulatorStatus',
  'listProjectRunDestinations',
  'launchProjectSimulator',
  'launchTaskSimulator',
  'openTaskInXcode',
  'restartProjectSimulator',
  'stopProjectSimulator',
  'onProjectSimulatorChanged',
  'refreshTaskPublication',
  'switchTaskPublicationToPullRequest'
]
const bridgeConnectionIssue: BridgeConnectionIssue | null = !electronRuntime
  ? null
  : !runtimeBridge
    ? 'missing'
    : runtimeBridge.apiVersion !== AGENT_MONITORING_BRIDGE_VERSION ||
        requiredBridgeMethods.some((method) => typeof runtimeBridge[method] !== 'function')
      ? 'outdated'
      : null
const electronBridgeUnavailable = bridgeConnectionIssue !== null
const bridge: AgentMonitoringBridge = electronBridgeUnavailable
  ? demoBridge
  : (runtimeBridge as AgentMonitoringBridge | undefined) ?? demoBridge

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '대기',
  running: '구현 중',
  testing: '테스트 중',
  blocked_environment: '환경 확인 필요',
  blocked_agent: 'AI 사용 대기',
  awaiting_approval: '승인 대기',
  awaiting_manual_validation: '수동 검증 필요',
  awaiting_merge: 'PR 병합 대기',
  completed: '완료',
  failed: '실패',
  stopped: '중단',
  discarded: '폐기'
}

const VERIFICATION_MODE_LABELS: Record<VerificationMode, string> = {
  'project-tests': '프로젝트 테스트만',
  'simulator-runtime': 'Simulator 검증만',
  both: '프로젝트 테스트 + Simulator',
  'manual-review': '수동 검토만'
}

const TEST_DESIGN_LABELS: Record<TestDesignStrategy, string> = {
  automatic: '프로젝트에 맞게 자동 선택',
  'swift-testing': 'Swift Testing',
  xctest: 'XCTest',
  'existing-tests': '기존 테스트만 실행',
  skip: '테스트 설계 건너뛰기'
}

const RUNTIME_SOURCE_LABELS: Record<RuntimeVerificationSource, string> = {
  'task-scenario': '이 작업 전용 시나리오',
  'project-default': '프로젝트 기본 시나리오',
  off: '사용 안 함'
}

const PRIVACY_SERVICE_LABELS: Record<RuntimePrivacyPermission['service'], string> = {
  calendar: '캘린더',
  'contacts-limited': '제한된 연락처',
  contacts: '연락처',
  location: '앱 사용 중 위치',
  'location-always': '항상 위치',
  'photos-add': '사진 추가',
  photos: '사진',
  'media-library': '미디어 보관함',
  microphone: '마이크',
  motion: '동작 및 피트니스',
  reminders: '미리 알림',
  siri: 'Siri'
}

const PRIVACY_STATE_LABELS: Record<RuntimePrivacyPermission['state'], string> = {
  granted: '허용',
  denied: '거부',
  reset: '선택 전으로 초기화'
}

const VERIFICATION_STEP_STATUS_LABELS: Record<VerificationStepStatus, string> = {
  pending: '대기',
  running: '진행 중',
  passed: '통과',
  failed: '확인 필요',
  skipped: '건너뜀'
}

const PROJECT_CHANGE_LABELS: Record<ProjectChangeKind, string> = {
  modified: '수정된 파일',
  added: '추가된 파일',
  deleted: '삭제된 파일',
  renamed: '이름 변경',
  untracked: 'Git 미추적 새 파일',
  conflicted: '충돌 파일'
}

const PROJECT_CHANGE_PATH_LABELS: Record<ProjectChangeKind, string> = {
  modified: '수정',
  added: '추가',
  deleted: '삭제',
  renamed: '이름 변경',
  untracked: '미추적',
  conflicted: '충돌'
}

const PROJECT_CHANGE_ORDER: ProjectChangeKind[] = [
  'conflicted',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked'
]

const PROJECT_CAPABILITY_LABELS: Record<ProjectCapabilityKey, string> = {
  code: 'Code',
  build: 'Build',
  run: 'Run',
  observe: 'Observe',
  act: 'Act',
  verify: 'Verify'
}

const PROJECT_CAPABILITY_STATUS_LABELS: Record<ProjectCapabilityStatus, string> = {
  ready: '지금 사용 가능',
  declared: '프로젝트 선언 · 연결 예정',
  missing: '미설정'
}

const RUNTIME_SESSION_STATUS_LABELS: Record<RuntimeSessionStatus, string> = {
  preparing: '준비 중',
  booting: 'Simulator 부팅',
  building: '앱 빌드',
  installing: '앱 설치',
  launching: '앱 실행',
  acting: 'UI 조작',
  observing: '증거 수집',
  verifying: '인수 검증',
  running: '실행 중',
  failed: '실패',
  stopped: '종료됨'
}

const RUNTIME_EVIDENCE_LABELS: Record<RuntimeEvidenceRecord['kind'], string> = {
  screen: 'Simulator 화면 증거',
  accessibility: 'Simulator 접근성 트리',
  'ui-actions': 'Simulator UI 조작 결과',
  'debug-state': 'Simulator Debug state·fixture',
  'runtime-verification': 'Runtime 인수 검증 결과'
}

const RUNTIME_REPORT_OUTCOME_LABELS: Record<RuntimeEvidenceRecord['outcome'], string> = {
  captured: '증거 수집',
  passed: '통과',
  failed: '실패'
}

const NAV_ITEMS: Array<{ page: Page; label: string; icon: typeof LayoutDashboard }> = [
  { page: 'dashboard', label: '대시보드', icon: LayoutDashboard },
  { page: 'tasks', label: '작업', icon: ListTodo },
  { page: 'findings', label: '버그', icon: Bug },
  { page: 'notes', label: '메모', icon: NotebookPen },
  { page: 'source-control', label: '소스 제어', icon: GitCompareArrows }
]

function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return '방금 전'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

function shortDate(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}월 ${date.getDate()}일`
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`
  if (value >= 1_024 * 1_024 * 1_024) return `${(value / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
}

function duration(task: TaskRecord): string {
  const minutes = Math.max(1, Math.round((new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}분`
  const hours = Math.floor(minutes / 60)
  return `${hours}시간 ${minutes % 60}분`
}

function shortElapsed(startedAt: string | null, finishedAt: string): string | null {
  if (!startedAt) return null
  const seconds = Math.max(1, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1_000))
  if (seconds < 60) return `${seconds}초`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}

function eventIcon(kind: EventKind): typeof Activity {
  if (kind.includes('task_revision')) return MessageSquare
  if (kind.includes('finding')) return Bug
  if (kind.includes('note')) return NotebookPen
  if (kind.includes('test')) return kind === 'test_failed' ? AlertTriangle : CheckCircle2
  if (kind.includes('environment')) return kind === 'environment_failed' ? AlertTriangle : Gauge
  if (kind === 'task_timed_out') return AlertTriangle
  if (kind.includes('completed')) return CheckCircle2
  if (kind.includes('started')) return Play
  return Bot
}

function statusTone(status: TaskStatus): string {
  if (status === 'completed') return 'green'
  if (status === 'failed') return 'red'
  if (status === 'awaiting_approval') return 'violet'
  if (status === 'awaiting_manual_validation') return 'amber'
  if (status === 'awaiting_merge') return 'violet'
  if (status === 'blocked_environment') return 'amber'
  if (status === 'blocked_agent') return 'amber'
  if (status === 'running' || status === 'testing') return 'blue'
  if (status === 'stopped' || status === 'discarded') return 'muted'
  return 'amber'
}

function isAwaitingLocalPublicationSync(task: TaskRecord): boolean {
  return task.publication?.status === 'awaiting_local_sync'
}

function directPublishLabel(task: TaskRecord): string {
  return task.sourceBranch
    ? `${task.sourceBranch} 브랜치에 직접 게시`
    : '작업 시작 브랜치에 직접 게시'
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const selectedProjectRef = useRef<string | undefined>(undefined)
  const loadRequestRef = useRef(0)
  const inspectionRequestRef = useRef(0)
  const [page, setPage] = useState<Page>('dashboard')
  const [range, setRange] = useState<Range>('all')
  const [taskModal, setTaskModal] = useState(false)
  const [noteModal, setNoteModal] = useState(false)
  const [editingNote, setEditingNote] = useState<NoteRecord | null>(null)
  const [searchModal, setSearchModal] = useState(false)
  const [storageModal, setStorageModal] = useState(false)
  const [helpModal, setHelpModal] = useState(false)
  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null)
  const [taskChanges, setTaskChanges] = useState<TaskChanges | null>(null)
  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [inspectionLoading, setInspectionLoading] = useState(false)
  const [runtimeConnecting, setRuntimeConnecting] = useState(false)
  const [runtimeDiscovery, setRuntimeDiscovery] = useState<ProjectRuntimeDiscovery | null>(null)
  const [selectingProjectId, setSelectingProjectId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (projectId?: string) => {
    const requestId = ++loadRequestRef.current
    try {
      const next = await bridge.getSnapshot(projectId)
      if (requestId !== loadRequestRef.current) return false
      setSnapshot(next)
      setSelectedProjectId(next.selectedProject?.id)
      selectedProjectRef.current = next.selectedProject?.id
      setSelectedTask((current) => (current ? next.tasks.find((task) => task.id === current.id) ?? null : null))
      return true
    } catch (loadError) {
      if (requestId === loadRequestRef.current) setError(String(loadError))
      return false
    }
  }, [])

  const refreshInspection = useCallback(async (projectId: string) => {
    const requestId = ++inspectionRequestRef.current
    setInspectionLoading(true)
    setInspection(null)
    try {
      const next = await bridge.inspectProject(projectId)
      if (requestId === inspectionRequestRef.current) {
        setInspection(next)
        await load(projectId)
      }
    } catch (inspectionError) {
      if (requestId === inspectionRequestRef.current) setError(String(inspectionError))
    } finally {
      if (requestId === inspectionRequestRef.current) setInspectionLoading(false)
    }
  }, [load])

  const autoConfigureRuntime = useCallback(async (projectId: string) => {
    setRuntimeConnecting(true)
    setError(null)
    try {
      const result = await bridge.autoConfigureProjectRuntime(projectId)
      setRuntimeDiscovery(result.discovery)
      if (result.discovery.state === 'selection-required') {
        setPage('projects')
      } else if (result.discovery.state === 'unavailable') {
        setError(result.discovery.message)
      } else {
        setNotice(result.discovery.message)
      }
      await load(projectId)
      await refreshInspection(projectId)
    } catch (runtimeError) {
      setError(String(runtimeError))
    } finally {
      setRuntimeConnecting(false)
    }
  }, [load, refreshInspection])

  useEffect(() => {
    setRuntimeDiscovery(null)
  }, [selectedProjectId])

  const loadCodexAuth = useCallback(async () => {
    try {
      setCodexAuth(await bridge.getCodexAuth())
    } catch (authError) {
      setCodexAuth({
        state: 'error',
        authMode: null,
        email: null,
        planType: null,
        message: String(authError).replace(/^Error:\s*/, '')
      })
    }
  }, [])

  useEffect(() => {
    if (electronBridgeUnavailable) return undefined
    void load()
    const unsubscribe = bridge.onEvent(() => void load(selectedProjectRef.current))
    const interval = window.setInterval(() => void load(selectedProjectRef.current), 12_000)
    return () => {
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [load])

  useEffect(() => {
    if (electronBridgeUnavailable) return undefined
    void loadCodexAuth()
    return bridge.onCodexAuthChanged(setCodexAuth)
  }, [loadCodexAuth])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchModal(true)
      }
      if (event.key === 'Escape') {
        setSearchModal(false)
        setStorageModal(false)
        setHelpModal(false)
        setTaskModal(false)
        setNoteModal(false)
        setEditingNote(null)
        setSelectedTask(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!selectedTask?.worktreePath) {
      setTaskChanges(null)
      return undefined
    }
    setTaskChanges(null)
    void bridge
      .getTaskChanges(selectedTask.id)
      .then((changes) => {
        if (!cancelled) setTaskChanges(changes)
      })
      .catch((changesError) => {
        if (!cancelled) setError(String(changesError))
      })
    return () => {
      cancelled = true
    }
  }, [selectedTask?.id, selectedTask?.updatedAt, selectedTask?.worktreePath])

  useEffect(() => {
    const projectId = snapshot?.selectedProject?.id
    if (!projectId || electronBridgeUnavailable) {
      setInspection(null)
      return
    }
    void refreshInspection(projectId)
  }, [refreshInspection, snapshot?.selectedProject?.id])

  const selectProject = async (projectId: string): Promise<void> => {
    const previousProjectId = selectedProjectRef.current
    setSelectedProjectId(projectId)
    selectedProjectRef.current = projectId
    setSelectingProjectId(projectId)
    setSelectedTask(null)
    setPage('dashboard')
    const loaded = await load(projectId)
    if (!loaded && selectedProjectRef.current === projectId) {
      selectedProjectRef.current = previousProjectId
      setSelectedProjectId(previousProjectId)
    }
    setSelectingProjectId((current) => current === projectId ? null : current)
  }

  const addProject = async (): Promise<void> => {
    try {
      setBusy(true)
      const project = await bridge.addProject()
      if (project) await selectProject(project.id)
    } catch (projectError) {
      setError(String(projectError))
    } finally {
      setBusy(false)
    }
  }

  const runTask = (task: TaskRecord): void => {
    const project = snapshot?.projects.find((item) => item.id === task.projectId)
    const requiresProjectTests = !task.verificationPlan ||
      ['project-tests', 'both'].includes(task.verificationPlan.mode)
    if (requiresProjectTests && !project?.testCommand.trim()) {
      setPage('projects')
      setSelectedTask(null)
      setError('작업을 실행하기 전에 프로젝트 검증 명령을 등록하세요.')
      return
    }
    setSelectedTask(task)
    void bridge.runTask(task.id).catch((runError) => setError(String(runError)))
    void load(task.projectId)
  }

  const retryTaskVerification = (task: TaskRecord): void => {
    setSelectedTask(task)
    void bridge.retryTaskVerification(task.id)
      .then(() => load(task.projectId))
      .catch((retryError) => setError(String(retryError)))
    void load(task.projectId)
  }

  const continueTask = async (task: TaskRecord, instruction: string): Promise<void> => {
    setError(null)
    setSelectedTask(task)
    try {
      await bridge.continueTask({ taskId: task.id, instruction })
      setNotice(isActiveTask(task)
        ? '추가 수정 요청을 큐에 등록했습니다.'
        : '추가 수정 요청을 등록하고 같은 작업에서 실행을 시작했습니다.')
      await load(task.projectId)
    } catch (continueError) {
      setError(String(continueError))
      throw continueError
    }
  }

  const updateTaskRevisionRequest = async (task: TaskRecord, requestId: string, instruction: string): Promise<void> => {
    setError(null)
    try {
      await bridge.updateTaskRevisionRequest({ taskId: task.id, requestId, instruction })
      setNotice('대기 중인 추가 수정 요청을 변경했습니다.')
      await load(task.projectId)
    } catch (revisionError) {
      setError(String(revisionError))
      throw revisionError
    }
  }

  const cancelTaskRevisionRequest = async (task: TaskRecord, requestId: string): Promise<void> => {
    setError(null)
    try {
      await bridge.cancelTaskRevisionRequest({ taskId: task.id, requestId })
      setNotice('추가 수정 요청을 취소했습니다.')
      await load(task.projectId)
    } catch (revisionError) {
      setError(String(revisionError))
      throw revisionError
    }
  }

  const moveTaskRevisionRequest = async (task: TaskRecord, requestId: string, direction: 'up' | 'down'): Promise<void> => {
    setError(null)
    try {
      await bridge.moveTaskRevisionRequest({ taskId: task.id, requestId, direction })
      await load(task.projectId)
    } catch (revisionError) {
      setError(String(revisionError))
      throw revisionError
    }
  }

  const setTaskRevisionQueuePaused = async (task: TaskRecord, paused: boolean): Promise<void> => {
    setError(null)
    try {
      await bridge.setTaskRevisionQueuePaused({ taskId: task.id, paused })
      setNotice(paused ? '현재 요청이 끝나면 추가 수정 큐를 일시정지합니다.' : '추가 수정 큐 자동 실행을 재개했습니다.')
      await load(task.projectId)
    } catch (revisionError) {
      setError(String(revisionError))
      throw revisionError
    }
  }

  const runNextTaskRevision = async (task: TaskRecord): Promise<void> => {
    setError(null)
    setNotice('다음 추가 수정 요청 하나를 실행합니다.')
    try {
      await bridge.runNextTaskRevision(task.id)
      await load(task.projectId)
    } catch (revisionError) {
      setError(String(revisionError))
      throw revisionError
    }
  }

  const launchTaskSimulator = (task: TaskRecord, destinationId: string): void => {
    setError(null)
    setNotice(`${task.branchName ?? '작업 브랜치'}에서 앱을 빌드하고 있습니다.`)
    setSelectedTask(null)
    setPage('dashboard')
    void bridge.launchTaskSimulator(task.id, destinationId)
      .then((session) => {
        setNotice(`${session.source.branchName ?? '작업 브랜치'} 앱을 ${session.deviceName ?? '선택한 iOS 기기'}에서 실행했습니다.`)
      })
      .catch((launchError) => setError(String(launchError)))
  }

  const regenerateTaskRuntimeScenario = async (task: TaskRecord): Promise<void> => {
    try {
      setBusy(true)
      setSelectedTask(task)
      await bridge.regenerateTaskRuntimeScenario(task.id)
      setNotice('현재 코드와 실행 환경에서 재현 가능한 검증 시나리오로 다시 만들었습니다.')
      await load(task.projectId)
    } catch (scenarioError) {
      setError(String(scenarioError))
    } finally {
      setBusy(false)
    }
  }

  const taskAction = async (task: TaskRecord, action: 'stop' | 'approve' | 'discard' | 'refresh-publication' | 'switch-to-pr'): Promise<void> => {
    try {
      if (action === 'discard' && !window.confirm('격리 작업공간과 변경을 폐기할까요?')) return
      if (action === 'approve') {
        const sourceStatus = await bridge.getSourceControlStatus(task.projectId)
        if (sourceStatus.files.length > 0) {
          setSelectedTask(null)
          setPage('source-control')
          setError('원본에 커밋되지 않은 변경이 있습니다. 소스 제어에서 파일을 선택해 커밋한 뒤 다시 게시하세요.')
          return
        }
      }
      if (
        action === 'approve' &&
        !window.confirm(
          task.status === 'awaiting_manual_validation'
            ? '이 작업은 자동 검증을 건너뛰었습니다. 변경을 직접 확인했나요? 원격이 최신이면 선택한 방식으로 게시하고, 원격이 바뀌었다면 최신 변경을 반영한 뒤 다시 검증합니다.'
            : `원격 최신 상태를 확인한 뒤 ${(task.publishStrategy ?? 'pull-request') === 'pull-request' ? '작업 브랜치를 올리고 PR을 만듭니다' : `${task.sourceBranch ?? '작업 시작'} 브랜치에 직접 게시합니다`}. 원격이 바뀌었다면 재검증 후 다시 승인을 요청합니다. 계속할까요?`
        )
      ) return
      if (action === 'stop') await bridge.stopTask(task.id)
      if (action === 'approve') {
        const result = await bridge.approveTask(task.id)
        setNotice(result.message)
      }
      if (action === 'discard') await bridge.discardTask(task.id)
      if (action === 'refresh-publication') {
        const result = await bridge.refreshTaskPublication(task.id)
        setNotice(result.message)
      }
      if (action === 'switch-to-pr') {
        await bridge.switchTaskPublicationToPullRequest(task.id)
        setNotice('이 작업의 게시 방식을 PR로 바꿨습니다. 변경을 다시 확인하고 게시하세요.')
      }
      await load(task.projectId)
    } catch (actionError) {
      setError(String(actionError))
      await load(task.projectId)
    }
  }

  const loginCodex = async (): Promise<void> => {
    setCodexAuth({ state: 'signing_in', authMode: null, email: null, planType: null })
    try {
      setCodexAuth(await bridge.loginCodex())
    } catch (authError) {
      setCodexAuth({
        state: 'signed_out',
        authMode: null,
        email: null,
        planType: null,
        message: String(authError).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
      })
    }
  }

  const logoutCodex = async (): Promise<void> => {
    if (!window.confirm('AgentMonitoring 전용 Codex 계정에서 로그아웃할까요?')) return
    try {
      setCodexAuth(await bridge.logoutCodex())
    } catch (authError) {
      setError(String(authError))
    }
  }

  const toggleFinding = async (findingId: string, resolved: boolean): Promise<void> => {
    try {
      await bridge.setFindingResolved(findingId, resolved)
      await load(selectedProjectRef.current)
    } catch (findingError) {
      setError(String(findingError))
    }
  }

  const removeNote = async (note: NoteRecord): Promise<void> => {
    if (!window.confirm(`“${note.title}” 메모를 삭제할까요?`)) return
    try {
      await bridge.deleteNote(note.id)
      await load(note.projectId)
    } catch (noteError) {
      setError(String(noteError))
    }
  }

  const removeProject = async (project: ProjectRecord): Promise<void> => {
    if (
      !window.confirm(
        `“${project.name}” 연결과 AgentMonitoring 기록을 삭제할까요? 관리 중인 격리 작업공간은 정리되지만 원본 저장소는 삭제하지 않습니다.`
      )
    ) return
    try {
      setBusy(true)
      await bridge.removeProject(project.id)
      selectedProjectRef.current = undefined
      setSelectedProjectId(undefined)
      setPage('dashboard')
      await load()
    } catch (projectError) {
      setError(String(projectError))
    } finally {
      setBusy(false)
    }
  }

  const applySuggestedTestCommand = async (project: ProjectRecord, command: string): Promise<void> => {
    if (!window.confirm(`“${command}”을 ${project.name}의 검증 명령으로 저장할까요?`)) return
    try {
      await bridge.updateProject({
        projectId: project.id,
        name: project.name,
        setupCommand: project.setupCommand,
        testCommand: command,
        runtimeAdapter: project.runtimeAdapter,
        publishStrategy: project.publishStrategy ?? 'pull-request'
      })
      await load(project.id)
      await refreshInspection(project.id)
    } catch (commandError) {
      setError(String(commandError))
    }
  }

  if (electronBridgeUnavailable) {
    return <RuntimeErrorScreen issue={bridgeConnectionIssue ?? 'missing'} />
  }

  if (!snapshot || !codexAuth) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" size={20} />
        <span>AgentMonitoring 준비 중</span>
      </main>
    )
  }

  if (codexAuth.state !== 'signed_in') {
    return (
      <CodexLoginScreen
        status={codexAuth}
        onLogin={() => void loginCodex()}
        onRetry={() => void loadCodexAuth()}
        onCancel={() => void bridge.cancelCodexLogin().then(setCodexAuth)}
      />
    )
  }

  const unresolved = snapshot.findings.filter((finding) => !finding.resolved)
  const activeTask = snapshot.tasks.find(isActiveTask) ?? null
  const awaitingTask = snapshot.tasks.find((task) =>
    ['awaiting_approval', 'awaiting_manual_validation', 'awaiting_merge'].includes(task.status)
  ) ?? null
  const selectedProject = snapshot.selectedProject

  return (
    <div className="app-shell">
      <Sidebar
        snapshot={snapshot}
        selectedProjectId={selectedProjectId ?? selectedProject?.id}
        page={page}
        sourceControlCount={inspection?.changeCount ?? 0}
        busy={busy}
        selectingProjectId={selectingProjectId}
        onPage={setPage}
        onProject={selectProject}
        onAddProject={addProject}
        onSearch={() => setSearchModal(true)}
        onStorage={() => setStorageModal(true)}
        onHelp={() => setHelpModal(true)}
        onFeedback={() => void bridge.openFeedback().catch((feedbackError) => setError(String(feedbackError)))}
      />

      <main className="main-content">
        <header className="workspace-header" aria-busy={Boolean(selectingProjectId)}>
          <div>
            <p className="eyebrow">PROJECT CONTROL PLANE</p>
            <h1>{selectedProject?.name ?? '프로젝트 연결'}</h1>
          </div>
          <div className="workspace-actions">
            <button className="codex-account" onClick={() => void logoutCodex()} title="AgentMonitoring 전용 Codex 로그아웃">
              <ShieldCheck size={13} />
              <span>{codexAuth.email ?? 'ChatGPT 연결됨'}</span>
              {codexAuth.planType && <small>{codexAuth.planType}</small>}
              <LogOut size={12} />
            </button>
            <div className="live-indicator">
              <span className="live-dot" />
              <span>실시간</span>
              <span className="last-activity">
                마지막 활동 {snapshot.events[0] ? timeAgo(snapshot.events[0].createdAt) : '없음'}
              </span>
            </div>
          </div>
        </header>

        {selectingProjectId && <div className="project-loading-bar"><span /></div>}

        {!selectedProject && (
          <EmptyWorkspace busy={busy} onAddProject={addProject} />
        )}
        {selectedProject && page === 'dashboard' && snapshot.tasks.length === 0 && (
          <ProjectStartPage
            project={selectedProject}
            inspection={inspection}
            loading={inspectionLoading}
            onRefresh={() => void refreshInspection(selectedProject.id)}
            onAutoConnect={() => void autoConfigureRuntime(selectedProject.id)}
            autoConnecting={runtimeConnecting}
            onOpen={() => void bridge.openPath(selectedProject.path)}
            onConfigure={() => setPage('projects')}
            onSourceControl={() => setPage('source-control')}
            onApplyCommand={(command) => void applySuggestedTestCommand(selectedProject, command)}
            onNewTask={() => setTaskModal(true)}
          />
        )}
        {selectedProject && page === 'dashboard' && snapshot.tasks.length > 0 && (
          <DashboardPage
            snapshot={snapshot}
            inspection={inspection}
            inspectionLoading={inspectionLoading}
            activeTask={activeTask}
            awaitingTask={awaitingTask}
            unresolvedCount={unresolved.length}
            range={range}
            onRange={setRange}
            onRefreshInspection={() => void refreshInspection(selectedProject.id)}
            onAutoConnect={() => void autoConfigureRuntime(selectedProject.id)}
            autoConnecting={runtimeConnecting}
            onPage={setPage}
            onOpenTask={setSelectedTask}
            onNewTask={() => setTaskModal(true)}
          />
        )}
        {selectedProject && page === 'tasks' && (
          <TasksPage
            tasks={snapshot.tasks}
            onNewTask={() => setTaskModal(true)}
            onOpen={setSelectedTask}
            onRun={runTask}
            onAction={taskAction}
          />
        )}
        {selectedProject && page === 'findings' && (
          <FindingsPage findings={snapshot.findings} onToggle={(id, resolved) => void toggleFinding(id, resolved)} />
        )}
        {selectedProject && page === 'notes' && (
          <NotesPage
            notes={snapshot.notes}
            onNew={() => {
              setEditingNote(null)
              setNoteModal(true)
            }}
            onEdit={(note) => {
              setEditingNote(note)
              setNoteModal(true)
            }}
            onDelete={(note) => void removeNote(note)}
          />
        )}
        {selectedProject && page === 'source-control' && (
          <SourceControlPage
            project={selectedProject}
            onRepositoryChanged={async () => {
              await load(selectedProject.id)
              await refreshInspection(selectedProject.id)
            }}
            onError={setError}
          />
        )}
        {selectedProject && page === 'projects' && (
          <ProjectsPage
            project={selectedProject}
            runtimeDiscovery={runtimeDiscovery}
            inspection={inspection}
            inspectionLoading={inspectionLoading}
            onRefreshInspection={() => void refreshInspection(selectedProject.id)}
            onAutoConnect={() => void autoConfigureRuntime(selectedProject.id)}
            autoConnecting={runtimeConnecting}
            onSave={async (project) => {
              await bridge.updateProject(project)
              await load(project.projectId)
              await refreshInspection(project.projectId)
            }}
            onOpen={() => void bridge.openPath(selectedProject.path)}
            onRemove={() => void removeProject(selectedProject)}
          />
        )}
      </main>

      {selectedProject && taskModal && (
        <TaskModal
          project={selectedProject}
          onGenerateTechSpec={(input) => bridge.generateTechSpec(input)}
          onRefineTechSpec={(input) => bridge.refineTechSpec(input)}
          onGenerate={(input) => bridge.generateRuntimeScenario(input)}
          onRecommend={(input) => bridge.recommendVerificationPlan(input)}
          onClose={() => setTaskModal(false)}
          onCreate={async (input) => {
            const task = await bridge.createTask(input)
            setTaskModal(false)
            setPage('tasks')
            setSelectedTask(task)
            await load(input.projectId)
          }}
        />
      )}
      {selectedProject && noteModal && (
        <NoteModal
          projectId={selectedProject.id}
          note={editingNote}
          onClose={() => {
            setNoteModal(false)
            setEditingNote(null)
          }}
          onSave={async (projectId, title, body) => {
            if (editingNote) await bridge.updateNote(editingNote.id, title, body)
            else await bridge.addNote(projectId, title, body)
            setNoteModal(false)
            setEditingNote(null)
            await load(projectId)
          }}
        />
      )}
      {selectedProject && searchModal && (
        <SearchModal
          snapshot={snapshot}
          onClose={() => setSearchModal(false)}
          onTask={(task) => {
            setSelectedTask(task)
            setSearchModal(false)
          }}
          onPage={(nextPage) => {
            setPage(nextPage)
            setSearchModal(false)
          }}
        />
      )}
      {storageModal && (
        <StorageModal onClose={() => setStorageModal(false)} />
      )}
      {helpModal && (
        <UsageHelpModal onClose={() => setHelpModal(false)} />
      )}
      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          changes={taskChanges}
          runtime={snapshot.runtimeSessions.find((session) => session.taskId === selectedTask.id) ?? null}
          evidence={snapshot.runtimeEvidence.filter((item) => item.taskId === selectedTask.id)}
          events={snapshot.events.filter((event) => event.taskId === selectedTask.id)}
          onClose={() => setSelectedTask(null)}
          onRun={runTask}
          onContinue={continueTask}
          onUpdateRevision={updateTaskRevisionRequest}
          onCancelRevision={cancelTaskRevisionRequest}
          onMoveRevision={moveTaskRevisionRequest}
          onSetRevisionQueuePaused={setTaskRevisionQueuePaused}
          onRunNextRevision={runNextTaskRevision}
          onRetryVerification={retryTaskVerification}
          onRegenerateRuntimeScenario={(task) => void regenerateTaskRuntimeScenario(task)}
          canLaunchSimulator={selectedProject?.id === selectedTask.projectId && selectedProject.runtimeAdapter?.kind === 'ios-simulator'}
          onLaunchSimulator={launchTaskSimulator}
          onAction={taskAction}
          onOpenPath={() => selectedTask.worktreePath && void bridge.openPath(selectedTask.worktreePath)}
          onOpenXcode={() => void bridge.openTaskInXcode(selectedTask.id).catch((openError) => setError(String(openError)))}
          onOpenEvidence={(path) => void bridge.openPath(path).catch((openError) => setError(String(openError)))}
        />
      )}
      {error && (
        <div className="error-toast" role="alert">
          <AlertTriangle size={16} />
          <span>{error.replace(/^Error:\s*/, '')}</span>
          <button aria-label="오류 닫기" onClick={() => setError(null)}><X size={15} /></button>
        </div>
      )}
      {notice && (
        <div className="success-toast" role="status">
          <CheckCircle2 size={16} />
          <span>{notice}</span>
          <button aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={15} /></button>
        </div>
      )}
    </div>
  )
}

function RuntimeErrorScreen({ issue }: { issue: BridgeConnectionIssue }): React.JSX.Element {
  const outdated = issue === 'outdated'
  return (
    <main className="auth-shell">
      <div className="auth-titlebar">
        <div className="brand-mark"><Activity size={14} /></div>
        <span>AgentMonitoring</span>
      </div>
      <section className="auth-card" role="alert">
        <div className="auth-icon error"><Octagon size={25} /></div>
        <p className="eyebrow">RUNTIME CONNECTION</p>
        <h1>{outdated ? '앱 연결을 업데이트해야 합니다' : '앱 연결을 불러오지 못했습니다'}</h1>
        <p className="auth-description">
          {outdated
            ? '화면은 새 버전이지만 Electron preload는 이전 버전입니다. 일부 기능만 실행하면 오류가 나므로 작업을 시작하기 전에 연결을 다시 불러옵니다.'
            : 'Electron preload가 연결되지 않아 실제 프로젝트와 로컬 데이터에 접근할 수 없습니다. 안전을 위해 데모 화면으로 전환하지 않았습니다.'}
        </p>
        <button className="auth-primary" onClick={() => window.location.reload()}>
          {outdated ? '새 연결 다시 불러오기' : '다시 불러오기'}
        </button>
        <p className="auth-footnote">
          다시 불러와도 같다면 터미널에서 실행 중인 앱을 `Ctrl+C`로 완전히 종료한 뒤 `pnpm dev`를 다시 실행하세요.
        </p>
      </section>
    </main>
  )
}

function EmptyWorkspace({
  busy,
  onAddProject
}: {
  busy: boolean
  onAddProject: () => void
}): React.JSX.Element {
  return (
    <section className="workspace-empty">
      <article className="panel onboarding-card">
        <div className="onboarding-status"><span className="live-dot" /> LOCAL WORKSPACE READY</div>
        <div className="onboarding-icon"><FolderOpen size={26} /></div>
        <p className="eyebrow">START WITH REAL CODE</p>
        <h2>첫 Git 프로젝트를 연결하세요</h2>
        <p className="onboarding-copy">
          샘플 데이터 대신 선택한 로컬 저장소에서 바로 시작합니다. 소스는 로컬에 유지되고,
          AgentMonitoring은 작업마다 격리된 worktree를 만들어 Codex 실행과 테스트 결과를 추적합니다.
        </p>
        <button className="onboarding-primary" disabled={busy} onClick={onAddProject}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
          실제 Git 프로젝트 추가
        </button>

        <div className="onboarding-steps">
          <div>
            <span>01</span>
            <GitBranch size={17} />
            <strong>저장소 연결</strong>
            <p>로컬 Git 폴더를 선택합니다.</p>
          </div>
          <div>
            <span>02</span>
            <SquareTerminal size={17} />
            <strong>검증 영역 연결</strong>
            <p>필요하면 환경 준비·테스트 명령과 Simulator를 연결합니다.</p>
          </div>
          <div>
            <span>03</span>
            <ShieldCheck size={17} />
            <strong>작업 실행과 승인</strong>
            <p>격리 실행 결과를 검토하고 승인합니다.</p>
          </div>
        </div>
      </article>
    </section>
  )
}

function ProjectStartPage({
  project,
  inspection,
  loading,
  onRefresh,
  onAutoConnect,
  autoConnecting,
  onOpen,
  onConfigure,
  onSourceControl,
  onApplyCommand,
  onNewTask
}: {
  project: ProjectRecord
  inspection: ProjectInspection | null
  loading: boolean
  onRefresh: () => void
  onAutoConnect: () => void
  autoConnecting: boolean
  onOpen: () => void
  onConfigure: () => void
  onSourceControl: () => void
  onApplyCommand: (command: string) => void
  onNewTask: () => void
}): React.JSX.Element {
  const hasTestCommand = Boolean(project.testCommand.trim())
  const ready = Boolean(inspection?.clean)

  return (
    <section className="project-start-page">
      <article className="panel project-start-hero">
        <div className={`readiness-mark ${ready ? 'ready' : 'attention'}`}>
          {loading ? <LoaderCircle className="spin" size={22} /> : ready ? <CheckCircle2 size={22} /> : <Gauge size={22} />}
        </div>
        <div className="project-start-copy">
          <p className="eyebrow">PROJECT READINESS</p>
          <h2>{loading ? '저장소 상태를 확인하고 있습니다' : ready ? '첫 작업을 시작할 준비가 되었습니다' : '작업 전에 준비할 항목이 있습니다'}</h2>
          <p>
            AgentMonitoring은 원본 checkout을 직접 수정하지 않고 격리된 worktree에서 환경 준비, Codex와 검증 명령을 실행합니다.
          </p>
        </div>
        <div className="project-start-actions">
          <button className="secondary-button" disabled={project.isDemo} onClick={onOpen}><FolderOpen size={14} />저장소 열기</button>
          <button className="secondary-button" disabled={loading} onClick={onRefresh}><Activity size={14} />다시 검사</button>
        </div>
      </article>

      {inspection ? (
        <div className="readiness-grid">
          <article className="panel readiness-card">
            <GitBranch size={16} />
            <span>Git 상태</span>
            <strong>{inspection.branch ?? 'detached HEAD'}</strong>
            <small>{inspection.headCommit ? `${inspection.headCommit} · ${inspection.lastCommitAt ? timeAgo(inspection.lastCommitAt) : '최근 commit'}` : '아직 commit이 없습니다.'}</small>
          </article>
          <article className="panel readiness-card">
            <Bot size={16} />
            <span>감지된 구성</span>
            <strong>{inspection.primaryLanguage ?? '언어 미감지'}</strong>
            <small>{[...inspection.languages, ...inspection.tools].join(' · ') || '표준 프로젝트 파일을 찾지 못했습니다.'}</small>
          </article>
          <article className="panel readiness-card">
            <FileText size={16} />
            <span>추적 파일</span>
            <strong>{inspection.trackedFileCount.toLocaleString('ko-KR')}개</strong>
            <small>테스트 파일 {inspection.testFileCount.toLocaleString('ko-KR')}개 · manifest {inspection.manifests.length}개</small>
          </article>
          <article className={`panel readiness-card ${hasTestCommand ? 'ready' : 'attention'}`}>
            <ShieldCheck size={16} />
            <span>준비·검증 명령</span>
            <strong>{hasTestCommand ? '설정 완료' : '선택 사항'}</strong>
            <small>{[
              project.setupCommand ? `준비 ${project.setupCommand}` : '',
              project.testCommand ? `검증 ${project.testCommand}` : '프로젝트 테스트를 선택할 작업에서만 검증 명령이 필요합니다.'
            ].filter(Boolean).join(' · ')}</small>
          </article>
        </div>
      ) : (
        <article className="panel inspection-empty">
          {loading ? <LoaderCircle className="spin" size={18} /> : <AlertTriangle size={18} />}
          <span>{loading ? 'Git과 프로젝트 구성을 읽는 중입니다.' : '저장소 검사 결과를 불러오지 못했습니다. 다시 검사해 주세요.'}</span>
        </article>
      )}

      {inspection && (
        <ProjectCapabilityPanel
          inspection={inspection}
          autoConnecting={autoConnecting}
          onAutoConnect={onAutoConnect}
          onConfigure={onConfigure}
        />
      )}

      {project.runtimeAdapter?.kind === 'ios-simulator' && !project.isDemo && (
        <ProjectSimulatorPanel project={project} />
      )}

      {inspection && !inspection.clean && (
        <div className="readiness-warning" role="status">
          <AlertTriangle size={15} />
          <div>
            <strong>원본 저장소에 커밋되지 않은 파일이 있습니다.</strong>
            <div className="change-summary" aria-label={`변경 파일 총 ${inspection.changeCount}개`}>
              {PROJECT_CHANGE_ORDER.filter((kind) => inspection.changeSummary[kind] > 0).map((kind) => (
                <span key={kind}>{PROJECT_CHANGE_LABELS[kind]} {inspection.changeSummary[kind]}개</span>
              ))}
            </div>
            <div className="change-preview" aria-label="변경 파일 일부">
              {inspection.changePreview.map((change) => (
                <code key={`${change.kind}:${change.path}`} title={change.path}>
                  <span>{PROJECT_CHANGE_PATH_LABELS[change.kind]}</span>{change.path}
                </code>
              ))}
              {inspection.changeCount > inspection.changePreview.length && (
                <small>외 {inspection.changeCount - inspection.changePreview.length}개</small>
              )}
            </div>
            <p>격리 작업은 만들 수 있지만 원격에 게시하려면 먼저 checkout을 clean 상태로 정리해야 합니다.</p>
            <button className="secondary-button" onClick={onSourceControl}>
              <GitCompareArrows size={13} /> 소스 제어에서 커밋
            </button>
          </div>
        </div>
      )}

      {!hasTestCommand && (
        <article className="panel validation-setup">
          <div>
            <p className="eyebrow">OPTIONAL VALIDATION</p>
            <h3>프로젝트 테스트를 쓰려면 검증 명령을 연결하세요</h3>
            <p>Simulator 검증만 또는 수동 검토만 선택한 작업은 지금도 만들 수 있어요. 감지한 테스트 명령은 후보이므로 저장 전에 직접 확인하세요.</p>
          </div>
          {inspection?.suggestedTestCommands.length ? (
            <div className="command-suggestions">
              {inspection.suggestedTestCommands.map((command) => (
                <button key={command} onClick={() => onApplyCommand(command)}><code>{command}</code><span>이 명령 사용</span></button>
              ))}
            </div>
          ) : (
            <button className="secondary-button" onClick={onConfigure}><Settings2 size={14} />직접 설정</button>
          )}
        </article>
      )}

      <article className="panel first-task-card">
        <div>
          <p className="eyebrow">NEXT STEP</p>
          <h3>첫 에이전트 작업을 등록하세요</h3>
          <p>{hasTestCommand ? '목표와 완료 조건을 작성하고 작업에 맞는 검증 조합을 선택하세요.' : '목표를 작성한 뒤 Simulator 검증 또는 수동 검토를 선택할 수 있습니다.'}</p>
        </div>
        <div>
          <button className="secondary-button" onClick={onConfigure}><Settings2 size={14} />프로젝트 설정</button>
          <button className="primary-button" onClick={onNewTask}><Plus size={14} />첫 작업 만들기</button>
        </div>
      </article>
    </section>
  )
}

function capabilityManifestLabel(inspection: ProjectInspection): string {
  if (inspection.capabilityManifest.state === 'valid') return '계약 확인됨'
  if (inspection.capabilityManifest.state === 'invalid') return '계약 오류'
  return '코드 작업 모드'
}

function needsRuntimeConnection(inspection: ProjectInspection): boolean {
  if (inspection.capabilityManifest.state !== 'missing') return false
  return inspection.capabilities.some((capability) =>
    ['build', 'run', 'observe', 'act'].includes(capability.key) && capability.status === 'missing'
  )
}

function ProjectCapabilityPanel({
  inspection,
  onRefresh,
  onAutoConnect,
  onConfigure,
  autoConnecting = false
}: {
  inspection: ProjectInspection
  onRefresh?: () => void
  onAutoConnect?: () => void
  onConfigure?: () => void
  autoConnecting?: boolean
}): React.JSX.Element {
  const readyCount = inspection.capabilities.filter((capability) => capability.status === 'ready').length
  const declaredCount = inspection.capabilities.filter((capability) => capability.status === 'declared').length
  const canAutoConnect = needsRuntimeConnection(inspection) && onAutoConnect

  return (
    <article className={`panel capability-panel manifest-${inspection.capabilityManifest.state}`}>
      <header className="capability-header">
        <div>
          <p className="eyebrow">AI ACCESS CONTRACT</p>
          <h3>AI가 접근할 수 있는 영역</h3>
          <p>
            현재 {readyCount}개 사용 가능
            {declaredCount > 0 ? ` · ${declaredCount}개는 프로젝트 선언 후 연결 대기` : ''}
          </p>
        </div>
        <div className="capability-header-actions">
          <span className="manifest-state">{capabilityManifestLabel(inspection)}</span>
          {onRefresh && (
            <button className="secondary-button" type="button" onClick={onRefresh}>
              <Activity size={13} /> 다시 검사
            </button>
          )}
        </div>
      </header>
      {canAutoConnect && (
        <section className="capability-connect">
          <div className="capability-connect-icon"><Bot size={16} /></div>
          <div>
            <strong>iOS 앱 실행 영역을 한 번에 연결하세요</strong>
            <p>Xcode 프로젝트와 Scheme을 찾아 Build·Run·화면·접근성·UI 조작을 활성화합니다. 저장소 파일은 바꾸지 않습니다.</p>
          </div>
          <div className="capability-connect-actions">
            {onConfigure && <button className="text-button" type="button" onClick={onConfigure}>직접 설정</button>}
            <button className="primary-button" type="button" disabled={autoConnecting} onClick={onAutoConnect}>
              {autoConnecting ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}
              {autoConnecting ? '찾는 중' : 'iOS 자동 연결'}
            </button>
          </div>
        </section>
      )}
      <div className="capability-grid">
        {inspection.capabilities.map((capability) => (
          <div className={`capability-item ${capability.status}`} key={capability.key}>
            <span>{PROJECT_CAPABILITY_STATUS_LABELS[capability.status]}</span>
            <strong>{PROJECT_CAPABILITY_LABELS[capability.key]}</strong>
            <small>{capability.detail}</small>
          </div>
        ))}
      </div>
      <footer className="capability-manifest-note">
        <code>{inspection.capabilityManifest.path}</code>
        <span>{inspection.capabilityManifest.message}</span>
        {inspection.capabilityManifest.state === 'valid' && (
          <small>연결된 Build·Run·관찰·조작 항목은 작업별 Swift runtime에서 사용합니다. Debug state·fixture는 project.json 고급 설정입니다.</small>
        )}
      </footer>
    </article>
  )
}

function ProjectCapabilityEmpty({
  loading,
  onRefresh
}: {
  loading: boolean
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <article className="panel capability-empty" aria-live="polite">
      {loading ? <LoaderCircle className="spin" size={17} /> : <AlertTriangle size={17} />}
      <div>
        <strong>{loading ? 'AI 접근 영역을 검사하고 있습니다' : 'AI 접근 영역을 불러오지 못했습니다'}</strong>
        <span>{loading ? '저장소 구성과 프로젝트 선언을 확인하는 중입니다.' : '저장소를 다시 검사해 접근 가능한 기능을 확인하세요.'}</span>
      </div>
      {!loading && <button className="secondary-button" onClick={onRefresh}><Activity size={13} /> 다시 검사</button>}
    </article>
  )
}

function ProjectCapabilitySummary({
  inspection,
  loading,
  onRefresh,
  onDetails,
  onAutoConnect,
  autoConnecting
}: {
  inspection: ProjectInspection | null
  loading: boolean
  onRefresh: () => void
  onDetails: () => void
  onAutoConnect: () => void
  autoConnecting: boolean
}): React.JSX.Element {
  if (!inspection) return <ProjectCapabilityEmpty loading={loading} onRefresh={onRefresh} />

  const readyCount = inspection.capabilities.filter((capability) => capability.status === 'ready').length
  const canAutoConnect = needsRuntimeConnection(inspection)

  return (
    <article className={`panel capability-summary manifest-${inspection.capabilityManifest.state}`}>
      <header>
        <div>
          <p className="eyebrow">AI ACCESS</p>
          <h3>AI가 접근할 수 있는 영역</h3>
          <p>코드 작업부터 실행·관찰·조작·검증까지 현재 연결 상태입니다.</p>
        </div>
        <div className="capability-summary-actions">
          <span className="manifest-state">{capabilityManifestLabel(inspection)}</span>
          {canAutoConnect && (
            <button className="primary-button" disabled={autoConnecting} onClick={onAutoConnect}>
              {autoConnecting ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}
              {autoConnecting ? '찾는 중' : 'iOS 자동 연결'}
            </button>
          )}
          <button className="secondary-button" onClick={onDetails}><Settings2 size={13} /> 전체 보기</button>
        </div>
      </header>
      <div className="capability-summary-status" aria-label={`AI 접근 영역 ${readyCount}개 사용 가능`}>
        {inspection.capabilities.map((capability) => (
          <div className={capability.status} key={capability.key} title={capability.detail}>
            <span />
            <strong>{PROJECT_CAPABILITY_LABELS[capability.key]}</strong>
            <small>{PROJECT_CAPABILITY_STATUS_LABELS[capability.status]}</small>
          </div>
        ))}
      </div>
    </article>
  )
}

const PROJECT_SIMULATOR_STATUS_LABELS: Record<ProjectSimulatorSession['status'], string> = {
  idle: '실행 준비',
  preparing: '기기 확인 중',
  booting: '기기 준비 중',
  building: '앱 빌드 중',
  installing: '앱 설치 중',
  running: '실행 중',
  restarting: '재실행 중',
  stopping: '종료 중',
  stopped: '앱 종료됨',
  failed: '실행 실패'
}

const PROJECT_SIMULATOR_BUSY = new Set<ProjectSimulatorSession['status']>([
  'preparing',
  'booting',
  'building',
  'installing',
  'restarting',
  'stopping'
])

function sessionDestinationId(session: ProjectSimulatorSession | null): string | null {
  return session?.destinationKind && session.deviceId
    ? `${session.destinationKind}:${session.deviceId}`
    : null
}

function initialRunDestination(
  destinations: ProjectRunDestination[],
  preferredId: string | null = null
): string {
  if (preferredId && destinations.some((destination) => destination.id === preferredId && destination.available)) {
    return preferredId
  }
  return destinations.find((destination) => destination.available && destination.kind === 'simulator')?.id
    ?? destinations.find((destination) => destination.available)?.id
    ?? ''
}

function ProjectSimulatorPanel({ project }: { project: ProjectRecord }): React.JSX.Element {
  const [session, setSession] = useState<ProjectSimulatorSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [destinations, setDestinations] = useState<ProjectRunDestination[]>([])
  const [selectedDestinationId, setSelectedDestinationId] = useState('')
  const [destinationsLoading, setDestinationsLoading] = useState(true)

  useEffect(() => {
    let active = true
    setSession(null)
    setError(null)
    setDestinations([])
    setSelectedDestinationId('')
    setDestinationsLoading(true)
    void bridge.getProjectSimulatorStatus(project.id)
      .then((next) => {
        if (active) {
          setSession(next)
          const runningDestinationId = sessionDestinationId(next)
          if (runningDestinationId) setSelectedDestinationId(runningDestinationId)
        }
      })
      .catch((statusError) => {
        if (active) setError(String(statusError))
      })
    const unsubscribe = bridge.onProjectSimulatorChanged((next) => {
      if (active && next.projectId === project.id) {
        setSession(next)
        const runningDestinationId = sessionDestinationId(next)
        if (runningDestinationId) setSelectedDestinationId(runningDestinationId)
      }
    })
    void bridge.listProjectRunDestinations(project.id)
      .then((next) => {
        if (!active) return
        setDestinations(next)
        setSelectedDestinationId((current) => initialRunDestination(next, current))
      })
      .catch((destinationError) => {
        if (active) setError(String(destinationError))
      })
      .finally(() => {
        if (active) setDestinationsLoading(false)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [project.id])

  const refreshDestinations = async (): Promise<void> => {
    setDestinationsLoading(true)
    setError(null)
    try {
      const next = await bridge.listProjectRunDestinations(project.id, true)
      setDestinations(next)
      setSelectedDestinationId((current) => initialRunDestination(next, current))
    } catch (destinationError) {
      setError(String(destinationError))
    } finally {
      setDestinationsLoading(false)
    }
  }

  const run = async (operation: () => Promise<ProjectSimulatorSession>): Promise<void> => {
    setError(null)
    try {
      setSession(await operation())
    } catch (operationError) {
      setError(String(operationError))
    }
  }

  const busy = session ? PROJECT_SIMULATOR_BUSY.has(session.status) : true
  const installed = Boolean(session?.deviceId && session.bundleIdentifier)
  const canStop = installed && (session?.destinationKind !== 'physical' || Boolean(session.processId))
  const adapter = project.runtimeAdapter!
  const family = adapter.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'
  const taskSource = session?.source.kind === 'task-worktree' && session.source.taskId
    ? session.source
    : null

  return (
    <article className={`panel project-simulator status-${session?.status ?? 'idle'}`} aria-live="polite">
      <div className="project-simulator-icon">
        {busy ? <LoaderCircle className="spin" size={18} /> : <SquareTerminal size={18} />}
      </div>
      <div className="project-simulator-copy">
        <p className="eyebrow">DEVELOPMENT DEVICE</p>
        <div className="project-simulator-title">
          <h3>{family} 앱 바로 실행</h3>
          <span>{session ? PROJECT_SIMULATOR_STATUS_LABELS[session.status] : '상태 확인 중'}</span>
        </div>
        <p>{session?.message ?? `${adapter.scheme} 실행 상태를 확인하고 있습니다.`}</p>
        <div className="project-simulator-target">
          <select
            aria-label="앱 실행 기기"
            disabled={busy || destinationsLoading}
            value={selectedDestinationId}
            onChange={(event) => setSelectedDestinationId(event.target.value)}
          >
            {destinations.length === 0 && <option value="">{destinationsLoading ? '기기 찾는 중' : '사용 가능한 기기 없음'}</option>}
            {destinations.map((destination) => (
              <option disabled={!destination.available} key={destination.id} value={destination.id}>
                {destination.name} · {destination.kind === 'simulator' ? 'Simulator' : '실기기'} · {destination.statusLabel}
              </option>
            ))}
          </select>
          <button
            aria-label="실행 기기 새로고침"
            className="icon-button"
            disabled={busy || destinationsLoading}
            type="button"
            onClick={() => void refreshDestinations()}
          >
            {destinationsLoading ? <LoaderCircle className="spin" size={12} /> : <RotateCcw size={12} />}
          </button>
        </div>
        <small className="project-simulator-hint">
          기기 목록은 페어링·Developer Mode·개발 터널 상태를 표시합니다. 프로젝트 Signing은 실기기 빌드할 때 별도로 확인합니다.
        </small>
        <div className="project-simulator-meta">
          <code className={taskSource ? 'task-source' : undefined}>
            <GitBranch size={10} />
            {taskSource ? `${taskSource.branchName ?? '작업 브랜치'} · 작업본` : '원본 저장소'}
          </code>
          <code>{adapter.scheme} · {adapter.configuration}</code>
          {session?.deviceName && <code>{session.deviceName}</code>}
          {session?.bundleIdentifier && <code>{session.bundleIdentifier}</code>}
        </div>
        {(error || session?.error) && (
          <div className="project-simulator-error"><AlertTriangle size={13} />{session?.error ?? error}</div>
        )}
      </div>
      <div className="project-simulator-actions">
        <button
          className="primary-button"
          type="button"
          disabled={busy || !selectedDestinationId}
          onClick={() => void run(() => taskSource
            ? bridge.launchTaskSimulator(taskSource.taskId!, selectedDestinationId)
            : bridge.launchProjectSimulator(project.id, selectedDestinationId))}
        >
          {busy && ['preparing', 'booting', 'building', 'installing'].includes(session?.status ?? '')
            ? <LoaderCircle className="spin" size={13} />
            : <Play size={13} />}
          {session?.status === 'running' ? '다시 빌드·실행' : '빌드·실행'}
        </button>
        {taskSource && (
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !selectedDestinationId}
            onClick={() => void run(() => bridge.launchProjectSimulator(project.id, selectedDestinationId))}
          >
            <GitBranch size={13} /> 원본으로 실행
          </button>
        )}
        <button
          className="secondary-button"
          type="button"
          disabled={busy || !installed}
          onClick={() => void run(() => bridge.restartProjectSimulator(project.id))}
        >
          <RotateCcw size={13} /> 재실행
        </button>
        <button
          className="secondary-button danger"
          type="button"
          disabled={busy || !canStop || session?.status === 'stopped'}
          onClick={() => void run(() => bridge.stopProjectSimulator(project.id))}
        >
          <Square size={12} /> 종료
        </button>
      </div>
    </article>
  )
}

function CodexLoginScreen({
  status,
  onLogin,
  onRetry,
  onCancel
}: {
  status: CodexAuthStatus
  onLogin: () => void
  onRetry: () => void
  onCancel: () => void
}): React.JSX.Element {
  const signingIn = status.state === 'signing_in'
  const unavailable = status.state === 'unavailable'
  return (
    <main className="auth-shell">
      <div className="auth-titlebar">
        <div className="brand-mark"><Activity size={14} /></div>
        <span>AgentMonitoring</span>
      </div>
      <section className="auth-card" aria-live="polite">
        <div className="auth-icon"><Bot size={25} /></div>
        <p className="eyebrow">CODEX CONNECTION</p>
        <h1>{signingIn ? '브라우저에서 로그인을 완료하세요' : 'Codex 계정을 연결하세요'}</h1>
        <p className="auth-description">
          {signingIn
            ? '공식 ChatGPT 로그인 창이 열렸습니다. 승인이 끝나면 이 화면이 자동으로 전환됩니다.'
            : 'AgentMonitoring이 테스트 설계, 구현, 비평과 자가 수리를 실행할 때 사용할 ChatGPT 계정입니다.'}
        </p>

        <div className="auth-boundary">
          <span><Check size={13} /> OpenAI API 키가 필요하지 않습니다.</span>
          <span><Check size={13} /> 다른 Codex 앱과 분리된 전용 로그인입니다.</span>
          <span><Check size={13} /> 인증 정보 저장과 갱신은 공식 Codex가 담당합니다.</span>
        </div>

        {status.message && <div className="auth-message"><AlertTriangle size={14} />{status.message}</div>}
        {unavailable && (
          <div className="auth-install">
            <strong>Codex CLI 설치가 필요합니다.</strong>
            <code>codex --version</code>
          </div>
        )}

        {!signingIn && (
          <button className="auth-primary" onClick={onLogin}>
            <LogIn size={15} /> ChatGPT로 계속
          </button>
        )}
        {signingIn && (
          <>
            <button className="auth-primary" disabled>
              <LoaderCircle className="spin" size={15} /> 로그인 승인 대기 중
            </button>
            <button className="auth-secondary" onClick={onCancel}>로그인 취소</button>
          </>
        )}
        {!signingIn && status.state !== 'signed_out' && (
          <button className="auth-secondary" onClick={onRetry}>상태 다시 확인</button>
        )}
        <p className="auth-footnote">로그인하면 ChatGPT 구독의 Codex 사용 범위와 조직 정책이 적용됩니다.</p>
      </section>
    </main>
  )
}

function Sidebar({
  snapshot,
  selectedProjectId,
  page,
  sourceControlCount,
  busy,
  selectingProjectId,
  onPage,
  onProject,
  onAddProject,
  onSearch,
  onStorage,
  onHelp,
  onFeedback
}: {
  snapshot: DashboardSnapshot
  selectedProjectId?: string
  page: Page
  sourceControlCount: number
  busy: boolean
  selectingProjectId: string | null
  onPage: (page: Page) => void
  onProject: (id: string) => void
  onAddProject: () => void
  onSearch: () => void
  onStorage: () => void
  onHelp: () => void
  onFeedback: () => void
}): React.JSX.Element {
  const activeCount = snapshot.tasks.filter(isActiveTask).length
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Activity size={14} /></div>
        <span>AgentMonitoring</span>
      </div>
      <label className="project-select">
        <select
          value={selectedProjectId ?? ''}
          disabled={snapshot.projects.length === 0}
          onChange={(event) => onProject(event.target.value)}
        >
          {snapshot.projects.length === 0 && <option value="">프로젝트 없음</option>}
          {snapshot.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <span>{snapshot.projects.length === 0 ? 'Git 저장소를 연결하세요' : `${activeCount}개 실행 중`}</span>
        <ChevronDown size={13} />
      </label>

      <button className="search-trigger" disabled={snapshot.projects.length === 0} onClick={onSearch}>
        <Search size={14} />
        <span>검색</span>
        <kbd>⌘K</kbd>
      </button>

      <p className="sidebar-label">프로젝트</p>
      <nav className="main-nav">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const count = item.page === 'tasks'
            ? snapshot.tasks.length
            : item.page === 'notes'
              ? snapshot.notes.length
              : item.page === 'source-control'
                ? sourceControlCount
                : null
          return (
            <button
              key={item.page}
              className={page === item.page ? 'active' : ''}
              disabled={snapshot.projects.length === 0}
              onClick={() => onPage(item.page)}
            >
              <Icon size={14} />
              <span>{item.label}</span>
              {count !== null && <small>{count}</small>}
            </button>
          )
        })}
      </nav>

      <p className="sidebar-label folder-label">폴더</p>
      <button className={`folder-button ${page === 'projects' ? 'active' : ''}`} onClick={() => onPage('projects')}>
        <Folder size={14} />
        <span>프로젝트</span>
        <small>{snapshot.projects.length}</small>
      </button>
      <div className="project-list">
        {snapshot.projects.map((project, index) => (
          <button
            key={project.id}
            aria-busy={selectingProjectId === project.id}
            onClick={() => onProject(project.id)}
            className={selectedProjectId === project.id ? 'selected' : ''}
          >
            {selectingProjectId === project.id
              ? <LoaderCircle className="spin" size={8} />
              : <span className={`project-dot dot-${index % 3}`} />}
            <span>{project.name}</span>
          </button>
        ))}
      </div>
      <button className="add-project" disabled={busy} onClick={onAddProject}>
        {busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}
        실제 Git 프로젝트 추가
      </button>

      <button className="storage-button" onClick={onStorage}>
        <HardDrive size={14} />
        저장 공간
      </button>
      <button className="help-button" onClick={onHelp}>
        <CircleHelp size={14} />
        도움말
      </button>
      <button className="feedback-button" onClick={onFeedback}>
        <MessageSquare size={14} />
        앱 피드백
      </button>
    </aside>
  )
}

function DashboardPage({
  snapshot,
  inspection,
  inspectionLoading,
  activeTask,
  awaitingTask,
  unresolvedCount,
  range,
  onRange,
  onRefreshInspection,
  onAutoConnect,
  autoConnecting,
  onPage,
  onOpenTask,
  onNewTask
}: {
  snapshot: DashboardSnapshot
  inspection: ProjectInspection | null
  inspectionLoading: boolean
  activeTask: TaskRecord | null
  awaitingTask: TaskRecord | null
  unresolvedCount: number
  range: Range
  onRange: (range: Range) => void
  onRefreshInspection: () => void
  onAutoConnect: () => void
  autoConnecting: boolean
  onPage: (page: Page) => void
  onOpenTask: (task: TaskRecord) => void
  onNewTask: () => void
}): React.JSX.Element {
  const focusTask = activeTask ?? awaitingTask ?? snapshot.tasks[0] ?? null
  const hourly = buildHourlyActivity(snapshot.events)
  const seriesDays = range === 'all' ? 16 : range
  const daily = buildDailySeries(snapshot.tasks, snapshot.findings, seriesDays)
  const latest24 = snapshot.events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < 86_400_000)
  const rangedEvents = range === 'all'
    ? snapshot.events
    : snapshot.events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < range * 86_400_000)
  const maxHour = Math.max(1, ...hourly)

  return (
    <section className="dashboard-page">
      <div className="summary-grid">
        <article className="panel current-card">
          <div className="panel-kicker">지금 진행 중</div>
          <div className="current-content">
            <strong className="hero-number">{activeTask ? 1 : 0}</strong>
            <span>진행 중 · 전체 작업 로그 {snapshot.tasks.length}개</span>
          </div>
          {focusTask ? (
            <button className="focus-task" onClick={() => onOpenTask(focusTask)}>
              <span className={`status-dot ${statusTone(focusTask.status)}`} />
              <div>
                <strong>{focusTask.title}</strong>
                <span><Bot size={12} /> codex · WORK-{focusTask.id.slice(0, 4).toUpperCase()}</span>
              </div>
              <div className="task-duration">
                <strong>{focusTask.status === 'completed' ? `소요 ${duration(focusTask)}` : STATUS_LABELS[focusTask.status]}</strong>
                <span>{timeAgo(focusTask.updatedAt)}</span>
              </div>
            </button>
          ) : (
            <p className="empty-copy">등록된 작업이 없습니다.</p>
          )}
          <div className="current-footer">
            <span>{activeTask ? '실시간 이벤트를 수집하고 있습니다.' : '진행 중인 작업이 없습니다.'}</span>
            <button className="text-action" onClick={onNewTask}><Plus size={12} /> 새 작업</button>
          </div>
        </article>

        <article className="panel bugs-card">
          <div className="panel-kicker">미해결 버그</div>
          <div className="bugs-count">
            <strong className="hero-number">{unresolvedCount}</strong>
            <span>미해결 · 전체 등록 {snapshot.findings.length}개</span>
          </div>
          <div className="severity-row">
            {(['critical', 'high', 'medium', 'low'] as const).map((severity) => (
              <span key={severity} className={`severity ${severity}`}>
                <i /> {severity === 'critical' ? '치명적' : severity === 'high' ? '높음' : severity === 'medium' ? '보통' : '낮음'}{' '}
                {snapshot.findings.filter((finding) => finding.severity === severity && !finding.resolved).length}
              </span>
            ))}
          </div>
          <p className="bugs-empty">
            {unresolvedCount === 0 ? '여기에 등록된 버그는 모두 해결되었습니다.' : '검토가 필요한 버그가 남아 있습니다.'}
          </p>
        </article>
      </div>

      <ProjectCapabilitySummary
        inspection={inspection}
        loading={inspectionLoading}
        onRefresh={onRefreshInspection}
        onDetails={() => onPage('projects')}
        onAutoConnect={onAutoConnect}
        autoConnecting={autoConnecting}
      />

      {snapshot.selectedProject?.runtimeAdapter?.kind === 'ios-simulator' && !snapshot.selectedProject.isDemo && (
        <ProjectSimulatorPanel project={snapshot.selectedProject} />
      )}

      <article className="panel timeline-card">
        <div className="timeline-summary">
          <span>최근 24시간</span>
          <div><strong>{latest24.length}</strong><span>이벤트 기록됨</span></div>
          <small>시작 {latest24.filter((event) => event.kind === 'task_started').length} · 완료 {latest24.filter((event) => event.kind === 'task_completed').length} · 메모 {latest24.filter((event) => event.kind === 'note_created').length}</small>
        </div>
        <div className="hourly-chart" aria-label="최근 24시간 활동">
          {hourly.map((count, index) => (
            <span key={index} className="hour-column">
              <i style={{ height: `${Math.max(1, (count / maxHour) * 48)}px`, opacity: count === 0 ? 0.16 : 0.9 }} />
              {index === 0 && <small>24시간 전</small>}
              {index === 8 && <small>오후 3시</small>}
              {index === 16 && <small>오전 7시</small>}
              {index === 23 && <small>지금</small>}
            </span>
          ))}
        </div>
      </article>

      <div className="range-strip">
        <div className="range-tabs">
          {([7, 30, 'all'] as Range[]).map((value) => (
            <button key={String(value)} className={range === value ? 'active' : ''} onClick={() => onRange(value)}>
              {value === 'all' ? '전체 기간' : `${value}일`}
            </button>
          ))}
        </div>
        <p>아래 차트와 활동 기록은 선택한 기간을 기준으로 계산된다. 실행 상태와 무관하게 현재 시각을 사용한다.</p>
      </div>

      <div className="chart-grid">
        <ChartCard title="작업" subtitle="시작 대비 완료 누적 추이" action="작업 전체" onAction={() => onPage('tasks')}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily} margin={{ top: 12, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#272c31" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(value) => shortDate(value)} axisLine={false} tickLine={false} tick={{ fill: '#68717c', fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: '#68717c', fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#11161a', border: '1px solid #2b3238', borderRadius: 8, fontSize: 11 }} labelFormatter={(value) => shortDate(String(value))} />
              <Line dataKey="started" name="시작" type="monotone" stroke="#4d9cf5" strokeWidth={2} dot={false} />
              <Line dataKey="completed" name="완료" type="monotone" stroke="#55b985" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="chart-legend"><span className="blue">시작 <b>{snapshot.tasks.length}</b></span><span className="green">완료 <b>{snapshot.tasks.filter((task) => task.status === 'completed').length}</b></span><span>진행 중 <b>{snapshot.tasks.filter(isActiveTask).length}</b></span></div>
        </ChartCard>
        <ChartCard title="버그" subtitle="등록 대비 해결 누적 추이" action="버그 보드" onAction={() => onPage('findings')}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily} margin={{ top: 12, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#272c31" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(value) => shortDate(value)} axisLine={false} tickLine={false} tick={{ fill: '#68717c', fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: '#68717c', fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#11161a', border: '1px solid #2b3238', borderRadius: 8, fontSize: 11 }} labelFormatter={(value) => shortDate(String(value))} />
              <Line dataKey="findings" name="등록" type="monotone" stroke="#db8a28" strokeWidth={2} dot={false} />
              <Line dataKey="resolved" name="해결" type="monotone" stroke="#9676e5" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="chart-legend"><span className="orange">등록 <b>{snapshot.findings.length}</b></span><span className="violet">해결 <b>{snapshot.findings.filter((finding) => finding.resolved).length}</b></span><span>미해결 <b>{unresolvedCount}</b></span></div>
        </ChartCard>
      </div>

      <ActivityFeed events={rangedEvents} />
    </section>
  )
}

function ChartCard({ title, subtitle, action, onAction, children }: { title: string; subtitle: string; action: string; onAction: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <article className="panel chart-card">
      <header><div><strong>{title}</strong><span>{subtitle}</span></div><button onClick={onAction}>{action}</button></header>
      <div className="chart-body">{children}</div>
    </article>
  )
}

function ActivityFeed({ events }: { events: EventRecord[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const visibleEvents = expanded ? events : events.slice(0, 15)
  return (
    <article className="panel activity-card">
      <header className="activity-header">
        <strong>활동</strong>
        <div className="activity-key"><span className="blue">작업</span><span className="green">완료</span><span className="pink">메모</span><span className="orange">버그</span><span className="violet">해결</span></div>
        <span>이벤트 {events.length}개 · 최근 기록</span>
        <button onClick={() => setExpanded((current) => !current)}>{expanded ? '접기' : '모두 펼치기'}</button>
      </header>
      <div className="activity-day"><ChevronDown size={13} /><strong>오늘</strong><span>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(new Date())}</span></div>
      <div className="activity-list">
        {visibleEvents.map((event) => {
          const Icon = eventIcon(event.kind)
          return (
            <div className="activity-row" key={event.id}>
              <span className={`event-icon event-${event.kind}`}><Icon size={12} /></span>
              <strong>{event.actor}</strong>
              {event.taskId && <code>WORK-{event.taskId.slice(0, 4).toUpperCase()}</code>}
              <span className="event-message">{event.message}</span>
              <time>{timeAgo(event.createdAt)}</time>
            </div>
          )
        })}
      </div>
    </article>
  )
}

function TasksPage({ tasks, onNewTask, onOpen, onRun, onAction }: { tasks: TaskRecord[]; onNewTask: () => void; onOpen: (task: TaskRecord) => void; onRun: (task: TaskRecord) => void; onAction: (task: TaskRecord, action: 'stop' | 'approve' | 'discard' | 'refresh-publication' | 'switch-to-pr') => void }): React.JSX.Element {
  return (
    <section className="workspace-page">
      <PageHeading title="작업" description="계획부터 테스트와 승인까지 모든 에이전트 실행을 추적한다." action="새 작업" onAction={onNewTask} />
      <article className="panel data-panel">
        <div className="data-header"><span>작업</span><span>상태</span><span>브랜치</span><span>마지막 활동</span><span /></div>
        {tasks.map((task) => (
          <div className="data-row task-row" key={task.id}>
            <button className="task-name" onClick={() => onOpen(task)}><span className={`status-dot ${statusTone(task.status)}`} /><span><strong>{task.title}</strong><small>WORK-{task.id.slice(0, 8).toUpperCase()} · 시도 {task.attempt}/{task.maxAttempts}</small></span></button>
            <span className={`status-pill ${statusTone(task.status)}`}>{STATUS_LABELS[task.status]}</span>
            <code>{task.branchName ?? '—'}</code>
            <time>{timeAgo(task.updatedAt)}</time>
            <div className="row-actions">
              {['queued', 'failed', 'stopped', 'blocked_agent'].includes(task.status) && <button title="실행" onClick={() => onRun(task)}><Play size={13} /></button>}
              {isActiveTask(task) && <button title="중단" onClick={() => onAction(task, 'stop')}><Square size={12} /></button>}
              {['awaiting_approval', 'awaiting_manual_validation'].includes(task.status) && !isAwaitingLocalPublicationSync(task) && <button title={(task.publishStrategy ?? 'pull-request') === 'pull-request' ? '브랜치 올리고 PR 만들기' : directPublishLabel(task)} onClick={() => onAction(task, 'approve')}><Check size={13} /></button>}
              {(task.status === 'awaiting_merge' || isAwaitingLocalPublicationSync(task)) && <button title={isAwaitingLocalPublicationSync(task) ? '로컬 동기화 다시 시도' : 'PR 상태 확인'} onClick={() => onAction(task, 'refresh-publication')}><GitCompareArrows size={13} /></button>}
            </div>
          </div>
        ))}
      </article>
    </section>
  )
}

function FindingsPage({
  findings,
  onToggle
}: {
  findings: DashboardSnapshot['findings']
  onToggle: (findingId: string, resolved: boolean) => void
}): React.JSX.Element {
  return (
    <section className="workspace-page">
      <PageHeading title="버그" description="테스트 실행과 Reviewer가 근거와 함께 등록한 결함이다." />
      <div className="finding-grid">
        {findings.map((finding) => (
          <article className="panel finding-card" key={finding.id}>
            <div><span className={`severity-dot ${finding.severity}`} /><strong>{finding.title}</strong></div>
            <p>{finding.taskId ? `WORK-${finding.taskId.slice(0, 8).toUpperCase()}` : '프로젝트 전체'} · {shortDate(finding.createdAt)}</p>
            <button
              className={`status-pill finding-toggle ${finding.resolved ? 'green' : 'red'}`}
              onClick={() => onToggle(finding.id, !finding.resolved)}
            >
              {finding.resolved ? '다시 열기' : '해결 처리'}
            </button>
          </article>
        ))}
        {findings.length === 0 && <EmptyState icon={Bug} title="등록된 버그가 없습니다." />}
      </div>
    </section>
  )
}

function NotesPage({
  notes,
  onNew,
  onEdit,
  onDelete
}: {
  notes: DashboardSnapshot['notes']
  onNew: () => void
  onEdit: (note: NoteRecord) => void
  onDelete: (note: NoteRecord) => void
}): React.JSX.Element {
  return (
    <section className="workspace-page">
      <PageHeading title="메모" description="사람의 결정과 에이전트 보고를 프로젝트 문맥으로 남긴다." action="새 메모" onAction={onNew} />
      <div className="notes-grid">
        {notes.map((note) => (
          <article className="panel note-card" key={note.id}>
            <NotebookPen size={14} />
            <div>
              <strong>{note.title}</strong>
              <p>{note.body}</p>
              <time>{timeAgo(note.createdAt)}</time>
            </div>
            <div className="note-actions">
              <button aria-label={`${note.title} 수정`} onClick={() => onEdit(note)}><Pencil size={12} /></button>
              <button aria-label={`${note.title} 삭제`} onClick={() => onDelete(note)}><Trash2 size={12} /></button>
            </div>
          </article>
        ))}
        {notes.length === 0 && <EmptyState icon={NotebookPen} title="등록된 메모가 없습니다." />}
      </div>
    </section>
  )
}

function SourceControlPage({
  project,
  onRepositoryChanged,
  onError
}: {
  project: ProjectRecord
  onRepositoryChanged: () => Promise<void>
  onError: (message: string) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<SourceControlStatus | null>(null)
  const [selected, setSelected] = useState<{ path: string; area: SourceControlArea } | null>(null)
  const [diff, setDiff] = useState<SourceControlDiff | null>(null)
  const [message, setMessage] = useState('')
  const [identityName, setIdentityName] = useState('')
  const [identityEmail, setIdentityEmail] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setBusyAction('refresh')
    try {
      const next = await bridge.getSourceControlStatus(project.id)
      setStatus(next)
      setIdentityName(next.identity.name ?? '')
      setIdentityEmail(next.identity.email ?? '')
      setSelected((current) => {
        if (!current) return null
        const file = next.files.find((candidate) => candidate.path === current.path)
        if (!file || (current.area === 'staged' ? !file.staged : !file.working)) return null
        return current
      })
    } catch (sourceError) {
      onError(String(sourceError))
    } finally {
      setBusyAction(null)
    }
  }, [onError, project.id])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    let cancelled = false
    setDiff(null)
    if (!selected) return undefined
    void bridge.getSourceControlDiff({ projectId: project.id, ...selected })
      .then((next) => {
        if (!cancelled) setDiff(next)
      })
      .catch((sourceError) => {
        if (!cancelled) onError(String(sourceError))
      })
    return () => {
      cancelled = true
    }
  }, [onError, project.id, selected])

  const updateStatus = (next: SourceControlStatus): void => {
    setStatus(next)
    setSuccess(null)
    setSelected((current) => {
      if (!current) return null
      const file = next.files.find((candidate) => candidate.path === current.path)
      if (!file || (current.area === 'staged' ? !file.staged : !file.working)) return null
      return current
    })
  }

  const runStatusAction = async (
    key: string,
    operation: () => Promise<SourceControlStatus>,
    successMessage?: string
  ): Promise<void> => {
    setBusyAction(key)
    try {
      updateStatus(await operation())
      if (successMessage) setSuccess(successMessage)
    } catch (sourceError) {
      onError(String(sourceError))
    } finally {
      setBusyAction(null)
    }
  }

  const saveIdentity = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    await runStatusAction('identity', () => bridge.setSourceControlIdentity({
      projectId: project.id,
      name: identityName,
      email: identityEmail
    }))
  }

  const commit = async (includeWorking: boolean): Promise<void> => {
    if (!message.trim()) {
      onError('커밋 메시지를 입력하세요.')
      return
    }
    setBusyAction(includeWorking ? 'commit-all' : 'commit-staged')
    try {
      const result = await bridge.commitSourceControlChanges({
        projectId: project.id,
        message,
        includeWorking
      })
      setStatus(result.status)
      setSelected(null)
      setDiff(null)
      setMessage('')
      setSuccess(`${result.commit} 커밋을 만들었습니다.`)
      await onRepositoryChanged()
    } catch (sourceError) {
      onError(String(sourceError))
      await loadStatus()
    } finally {
      setBusyAction(null)
    }
  }

  const stagedFiles = status?.files.filter((file) => file.staged) ?? []
  const workingFiles = status?.files.filter((file) => file.working) ?? []
  const busy = busyAction !== null

  return (
    <section className="source-control-page">
      <PageHeading
        title="소스 제어"
        description="원본 저장소의 변경을 확인하고 파일별 또는 전체로 커밋한다."
        action={busyAction === 'refresh' ? '불러오는 중' : '다시 불러오기'}
        onAction={() => void loadStatus()}
      />

      <div className="source-control-overview panel">
        <div>
          <GitBranch size={15} />
          <span>현재 브랜치</span>
          <strong>{status?.branch ?? '확인 중'}</strong>
          {status?.headCommit && <code>{status.headCommit}</code>}
        </div>
        <div>
          <GitCompareArrows size={15} />
          <span>커밋되지 않은 파일</span>
          <strong>{status?.files.length ?? 0}개</strong>
          <small>staged {status?.stagedCount ?? 0} · working {status?.workingCount ?? 0}</small>
        </div>
        <div className={status?.conflictedCount ? 'attention' : ''}>
          <ShieldCheck size={15} />
          <span>Git 상태</span>
          <strong>{status?.conflictedCount ? `충돌 ${status.conflictedCount}개` : '커밋 가능'}</strong>
          <small>{status?.identity.complete ? `${status.identity.name} · ${status.identity.email}` : '작성자 설정 필요'}</small>
        </div>
      </div>

      <section className={`panel source-remote-status${status?.remote?.diverged ? ' attention' : ''}`}>
        <div>
          <strong>원격 저장소</strong>
          {status?.remote ? (
            <>
              <p><code>{status.remote.name}</code> · {status.remote.upstream ?? 'upstream 미설정'} · 앞섬 {status.remote.ahead} / 뒤처짐 {status.remote.behind}</p>
              {status.remote.diverged && <small>로컬과 원격에 서로 다른 커밋이 있습니다. 외부 IDE에서 merge 또는 rebase 방향을 결정하세요.</small>}
            </>
          ) : <p>origin 원격 저장소가 설정되지 않았습니다.</p>}
        </div>
        <div className="source-remote-actions">
          <button className="secondary-button" type="button" disabled={busy || !status?.remote} onClick={() => void runStatusAction('fetch', () => bridge.fetchSourceControlRemote(project.id))}>
            {busyAction === 'fetch' ? <LoaderCircle className="spin" size={13} /> : <GitCompareArrows size={13} />} 원격 상태 가져오기
          </button>
          {status?.remote && status.branch && !status.remote.diverged && !status.remote.upstream && (
            <button className="primary-button" type="button" disabled={busy} onClick={() => void runStatusAction('push', () => bridge.pushSourceControlRemote(project.id), `${status.branch} 브랜치를 origin에 연결하고 push했습니다.`)}>
              {busyAction === 'push' ? <LoaderCircle className="spin" size={13} /> : <GitCommitHorizontal size={13} />} 브랜치 연결·Push
            </button>
          )}
          {status?.remote && status.remote.ahead > 0 && status.remote.behind === 0 && !status.remote.diverged && (
            <button className="primary-button" type="button" disabled={busy} onClick={() => void runStatusAction('push', () => bridge.pushSourceControlRemote(project.id), `${status.remote!.ahead}개 로컬 커밋을 원격에 push했습니다.`)}>
              {busyAction === 'push' ? <LoaderCircle className="spin" size={13} /> : <GitCommitHorizontal size={13} />} {status.remote.ahead}개 커밋 Push
            </button>
          )}
          {status?.remote && status.remote.behind > 0 && status.remote.ahead === 0 && !status.remote.diverged && (
            <button className="primary-button" type="button" disabled={busy || status.files.length > 0} onClick={() => void runStatusAction('sync', () => bridge.syncSourceControlRemote(project.id), `${status.remote!.behind}개 원격 커밋을 로컬에 동기화했습니다.`)}>
              {busyAction === 'sync' ? <LoaderCircle className="spin" size={13} /> : <GitCompareArrows size={13} />} {status.remote.behind}개 커밋 동기화
            </button>
          )}
        </div>
      </section>

      {status && !status.identity.complete && (
        <form className="panel source-identity" onSubmit={(event) => void saveIdentity(event)}>
          <div>
            <strong>이 저장소에서 사용할 Git 작성자를 설정하세요</strong>
            <p>전역 설정은 바꾸지 않고 이 저장소의 로컬 Git 설정에만 저장해요.</p>
          </div>
          <label><span>이름</span><input value={identityName} onChange={(event) => setIdentityName(event.target.value)} /></label>
          <label><span>이메일</span><input type="email" value={identityEmail} onChange={(event) => setIdentityEmail(event.target.value)} /></label>
          <button className="primary-button" disabled={busy} type="submit">
            {busyAction === 'identity' ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} 저장
          </button>
        </form>
      )}

      <div className="source-control-layout">
        <section className="panel source-file-panel">
          <SourceControlGroup
            title="스테이징된 변경"
            files={stagedFiles}
            area="staged"
            selected={selected}
            busy={busy}
            actionLabel="모두 스테이징 해제"
            onAction={() => void runStatusAction('unstage-all', () => bridge.unstageAllSourceControlChanges(project.id))}
            onSelect={setSelected}
            onFileAction={(path) => void runStatusAction(`unstage:${path}`, () => bridge.unstageSourceControlPaths({ projectId: project.id, paths: [path] }))}
          />
          <SourceControlGroup
            title="변경 사항"
            files={workingFiles}
            area="working"
            selected={selected}
            busy={busy}
            actionLabel="모두 스테이징"
            onAction={() => void runStatusAction('stage-all', () => bridge.stageAllSourceControlChanges(project.id))}
            onSelect={setSelected}
            onFileAction={(path) => void runStatusAction(`stage:${path}`, () => bridge.stageSourceControlPaths({ projectId: project.id, paths: [path] }))}
          />
        </section>

        <section className="panel source-diff-panel">
          <header>
            <div>
              <strong>{selected?.path ?? '변경 파일을 선택하세요'}</strong>
              <small>{selected ? selected.area === 'staged' ? '스테이징된 diff' : '작업공간 diff' : '파일을 선택하면 변경 내용을 보여줘요.'}</small>
            </div>
            {diff?.truncated && <span>일부만 표시</span>}
          </header>
          {!selected && <div className="source-diff-empty"><GitCompareArrows size={24} /><p>왼쪽에서 파일을 선택하세요.</p></div>}
          {selected && !diff && <div className="source-diff-empty"><LoaderCircle className="spin" size={20} /><p>diff를 불러오고 있어요.</p></div>}
          {diff && !diff.available && <div className="source-diff-empty"><FileText size={22} /><p>텍스트로 표시할 diff가 없어요.</p></div>}
          {diff?.available && <pre className="source-diff"><code>{diff.patch}</code></pre>}
        </section>

        <form className="panel source-commit-panel" onSubmit={(event) => {
          event.preventDefault()
          void commit(false)
        }}>
          <div>
            <p className="eyebrow">CREATE COMMIT</p>
            <h3>선택한 변경을 기록하세요</h3>
            <p>스테이징된 파일만 커밋하거나 작업공간의 변경을 모두 한 번에 커밋할 수 있어요.</p>
          </div>
          <label>
            <span>커밋 메시지</span>
            <textarea
              value={message}
              maxLength={2_000}
              placeholder="예: Featcher 테스트 타깃을 추가한다"
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          {success && <div className="source-success"><CheckCircle2 size={14} />{success}</div>}
          <div className="source-commit-actions">
            <button className="secondary-button" type="submit" disabled={busy || !status?.identity.complete || stagedFiles.length === 0 || !message.trim()}>
              {busyAction === 'commit-staged' ? <LoaderCircle className="spin" size={13} /> : <GitCommitHorizontal size={13} />}
              staged {stagedFiles.length}개 커밋
            </button>
            <button className="primary-button" type="button" disabled={busy || !status?.identity.complete || !status?.files.length || !message.trim()} onClick={() => void commit(true)}>
              {busyAction === 'commit-all' ? <LoaderCircle className="spin" size={13} /> : <GitCommitHorizontal size={13} />}
              변경 사항 모두 커밋
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}

function SourceControlGroup({
  title,
  files,
  area,
  selected,
  busy,
  actionLabel,
  onAction,
  onSelect,
  onFileAction
}: {
  title: string
  files: SourceControlFile[]
  area: SourceControlArea
  selected: { path: string; area: SourceControlArea } | null
  busy: boolean
  actionLabel: string
  onAction: () => void
  onSelect: (selected: { path: string; area: SourceControlArea }) => void
  onFileAction: (path: string) => void
}): React.JSX.Element {
  return (
    <div className="source-file-group">
      <header>
        <strong>{title} <span>{files.length}</span></strong>
        <button type="button" disabled={busy || files.length === 0} onClick={onAction}>{actionLabel}</button>
      </header>
      {files.length === 0 && <p className="source-file-empty">해당하는 파일이 없습니다.</p>}
      {files.map((file) => {
        const kind = area === 'staged' ? file.staged : file.working
        const active = selected?.path === file.path && selected.area === area
        return (
          <div className={`source-file${active ? ' active' : ''}`} key={`${area}:${file.path}`}>
            <button className="source-file-main" type="button" onClick={() => onSelect({ path: file.path, area })}>
              <span className={`source-kind kind-${kind}`}>{kind ? PROJECT_CHANGE_PATH_LABELS[kind] : '변경'}</span>
              <code title={file.path}>{file.path}</code>
              {file.originalPath && <small>{file.originalPath}에서 이름 변경</small>}
            </button>
            <button
              className="source-file-action"
              type="button"
              disabled={busy}
              aria-label={`${file.path} ${area === 'staged' ? '스테이징 해제' : '스테이징'}`}
              title={area === 'staged' ? '스테이징 해제' : '스테이징'}
              onClick={() => onFileAction(file.path)}
            >
              {area === 'staged' ? '−' : '+'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function catalogDefaultSelection(catalog: CodexModelCatalog): CodexModelSelection {
  const model = catalog.models.find((candidate) => candidate.id === catalog.defaultModelId) ?? catalog.models[0]
  return { model: model.id, reasoningEffort: model.defaultReasoningEffort }
}

function cloneModelProfile(profile?: CodexModelProfile | null): CodexModelProfile {
  return profile
    ? {
        ...profile,
        executionMode: codexExecutionMode(profile),
        selection: profile.selection ? { ...profile.selection } : null,
        roleSelections: Object.fromEntries(
          Object.entries(profile.roleSelections).map(([role, selection]) => [role, { ...selection }])
        )
      }
    : { ...RECOMMENDED_CODEX_MODEL_PROFILE, roleSelections: {} }
}

function modelProfileSummary(profile: CodexModelProfile | null | undefined, catalog: CodexModelCatalog | null): string {
  const execution = codexExecutionMode(profile) === 'root-subagents' ? '루트 + 서브에이전트 · ' : ''
  if (!profile || profile.mode === 'recommended') {
    if (!catalog) return `${execution}Codex 추천 기본값`
    const selection = catalogDefaultSelection(catalog)
    return `${execution}Codex 추천 · ${selection.model} · ${selection.reasoningEffort}`
  }
  if (profile.mode === 'single') return `${execution}${profile.selection?.model ?? '모델 미선택'} · ${profile.selection?.reasoningEffort ?? '-'}`
  return `${execution}역할별 모델 · 기본 ${profile.selection?.model ?? '미선택'}`
}

function CodexModelSelectionEditor({
  catalog,
  selection,
  onChange,
  label,
  allowInherited = false
}: {
  catalog: CodexModelCatalog
  selection: CodexModelSelection | null
  onChange: (selection: CodexModelSelection | null) => void
  label: string
  allowInherited?: boolean
}): React.JSX.Element {
  const model = selection ? catalog.models.find((candidate) => candidate.id === selection.model) : null
  return (
    <div className="codex-model-selection">
      <label>
        <span>{label}</span>
        <select value={selection?.model ?? ''} onChange={(event) => {
          if (!event.target.value) {
            onChange(null)
            return
          }
          const selectedModel = catalog.models.find((candidate) => candidate.id === event.target.value)!
          onChange({ model: selectedModel.id, reasoningEffort: selectedModel.defaultReasoningEffort })
        }}>
          {allowInherited && <option value="">기본 모델 사용</option>}
          {catalog.models.map((candidate) => (
            <option value={candidate.id} key={candidate.id}>{candidate.displayName}{candidate.isDefault ? ' · 추천' : ''}</option>
          ))}
        </select>
      </label>
      <label>
        <span>추론 강도</span>
        <select
          disabled={!selection || !model}
          value={selection?.reasoningEffort ?? ''}
          onChange={(event) => selection && onChange({ ...selection, reasoningEffort: event.target.value as CodexModelSelection['reasoningEffort'] })}
        >
          {!selection && <option value="">기본값 상속</option>}
          {model?.supportedReasoningEfforts.map((effort) => (
            <option value={effort.reasoningEffort} key={effort.reasoningEffort}>{effort.reasoningEffort}</option>
          ))}
        </select>
      </label>
      {model?.description && <small>{model.description}</small>}
    </div>
  )
}

function CodexModelProfileEditor({
  catalog,
  profile,
  onChange
}: {
  catalog: CodexModelCatalog
  profile: CodexModelProfile
  onChange: (profile: CodexModelProfile) => void
}): React.JSX.Element {
  const defaultSelection = profile.selection ?? catalogDefaultSelection(catalog)
  const setMode = (mode: CodexModelProfile['mode']): void => {
    onChange({
      ...profile,
      mode,
      selection: mode === 'recommended' ? null : defaultSelection,
      roleSelections: mode === 'role-based' ? profile.roleSelections : {}
    })
  }
  return (
    <div className="codex-model-profile-editor">
      <label>
        <span>실행 구조</span>
        <select
          value={codexExecutionMode(profile)}
          onChange={(event) => onChange({
            ...profile,
            executionMode: event.target.value as NonNullable<CodexModelProfile['executionMode']>
          })}
        >
          <option value="independent">역할별 독립 실행</option>
          <option value="root-subagents">루트 + 서브에이전트</option>
        </select>
        <small>{codexExecutionMode(profile) === 'root-subagents'
          ? '테크스펙·검증 준비 모델이 루트가 되어 각 역할을 한 명씩 위임합니다. 호출량은 늘지만 루트가 결과 형식을 통제합니다.'
          : '각 역할을 선택한 모델로 바로 실행합니다. 가장 단순하고 토큰 사용량이 적습니다.'}</small>
      </label>
      <label>
        <span>모델 사용 방식</span>
        <select value={profile.mode} onChange={(event) => setMode(event.target.value as CodexModelProfile['mode'])}>
          <option value="recommended">Codex 추천 기본값</option>
          <option value="single">모든 단계 같은 모델</option>
          <option value="role-based">역할별 모델</option>
        </select>
      </label>
      {profile.mode === 'recommended' && (
        <div className="codex-model-recommended">
          <Bot size={15} />
          <div><strong>{modelProfileSummary(profile, catalog)}</strong><small>Codex가 추천 모델을 바꾸면 새 작업부터 자동으로 따라갑니다.</small></div>
        </div>
      )}
      {profile.mode !== 'recommended' && (
        <CodexModelSelectionEditor
          catalog={catalog}
          selection={defaultSelection}
          label={profile.mode === 'single' ? '모든 단계 모델' : '역할 기본 모델'}
          onChange={(selection) => onChange({ ...profile, selection })}
        />
      )}
      {profile.mode === 'role-based' && (
        <div className="codex-role-models">
          {CODEX_MODEL_ROLES.map((role) => (
            <CodexModelSelectionEditor
              allowInherited
              catalog={catalog}
              key={role}
              label={codexExecutionMode(profile) === 'root-subagents' && role === 'planning'
                ? 'Root · 계획·조정'
                : CODEX_MODEL_ROLE_LABELS[role]}
              selection={profile.roleSelections[role] ?? null}
              onChange={(selection) => {
                const roleSelections = { ...profile.roleSelections }
                if (selection) roleSelections[role] = selection
                else delete roleSelections[role]
                onChange({ ...profile, roleSelections })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectsPage({
  project,
  runtimeDiscovery,
  inspection,
  inspectionLoading,
  onRefreshInspection,
  onAutoConnect,
  autoConnecting,
  onSave,
  onOpen,
  onRemove
}: {
  project: ProjectRecord
  runtimeDiscovery: ProjectRuntimeDiscovery | null
  inspection: ProjectInspection | null
  inspectionLoading: boolean
  onRefreshInspection: () => void
  onAutoConnect: () => void
  autoConnecting: boolean
  onSave: (input: UpdateProjectInput) => Promise<void>
  onOpen: () => void
  onRemove: () => void
}): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [setupCommand, setSetupCommand] = useState(project.setupCommand)
  const [testCommand, setTestCommand] = useState(project.testCommand)
  const [runtimeAdapter, setRuntimeAdapter] = useState(project.runtimeAdapter)
  const [publishStrategy, setPublishStrategy] = useState<PublishStrategy>(project.publishStrategy ?? 'pull-request')
  const [modelProfile, setModelProfile] = useState<CodexModelProfile>(() => cloneModelProfile(project.modelProfile))
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalog | null>(null)
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null)
  const [runtimeEnvironment, setRuntimeEnvironment] = useState<ProjectRuntimeEnvironmentEntry[]>([])
  const [environmentKey, setEnvironmentKey] = useState('')
  const [environmentLabel, setEnvironmentLabel] = useState('')
  const [environmentScope, setEnvironmentScope] = useState<'build' | 'launch' | 'both'>('both')
  const [buildSetting, setBuildSetting] = useState('')
  const [launchVariable, setLaunchVariable] = useState('')
  const [environmentValue, setEnvironmentValue] = useState('')
  const [environmentBusy, setEnvironmentBusy] = useState(false)
  const [environmentError, setEnvironmentError] = useState<string | null>(null)
  useEffect(() => {
    setName(project.name)
    setSetupCommand(project.setupCommand)
    setTestCommand(project.testCommand)
    setRuntimeAdapter(project.runtimeAdapter)
    setPublishStrategy(project.publishStrategy ?? 'pull-request')
    setModelProfile(cloneModelProfile(project.modelProfile))
  }, [project])
  useEffect(() => {
    let active = true
    setModelCatalogError(null)
    void bridge.listCodexModels()
      .then((catalog) => { if (active) setModelCatalog(catalog) })
      .catch((error) => { if (active) setModelCatalogError(String(error).replace(/^Error:\s*/, '')) })
    return () => { active = false }
  }, [project.id])
  useEffect(() => {
    let active = true
    void bridge.listProjectRuntimeEnvironment(project.id)
      .then((entries) => { if (active) setRuntimeEnvironment(entries) })
      .catch((error) => { if (active) setEnvironmentError(String(error).replace(/^Error:\s*/, '')) })
    return () => { active = false }
  }, [project.id])

  const saveRuntimeEnvironment = async (): Promise<void> => {
    setEnvironmentBusy(true)
    setEnvironmentError(null)
    try {
      const entries = await bridge.upsertProjectRuntimeEnvironment({
        projectId: project.id,
        key: environmentKey,
        label: environmentLabel,
        scope: environmentScope,
        buildSetting: environmentScope === 'launch' ? null : buildSetting,
        launchVariable: environmentScope === 'build' ? null : launchVariable,
        value: environmentValue
      })
      setRuntimeEnvironment(entries)
      setEnvironmentKey('')
      setEnvironmentLabel('')
      setBuildSetting('')
      setLaunchVariable('')
      setEnvironmentValue('')
    } catch (error) {
      setEnvironmentError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setEnvironmentBusy(false)
    }
  }
  useEffect(() => {
    if (
      runtimeDiscovery?.state !== 'selection-required' ||
      !runtimeDiscovery.container ||
      runtimeDiscovery.appSchemes.length === 0
    ) return
    setRuntimeAdapter((current) => {
      const currentScheme = current && runtimeDiscovery.appSchemes.some(
        (candidate) => candidate.scheme === current.scheme
      )
        ? current.scheme
        : runtimeDiscovery.appSchemes[0].scheme
      return {
        kind: 'ios-simulator',
        container: runtimeDiscovery.container!,
        scheme: currentScheme,
        configuration: 'Debug',
        deviceFamily: current?.deviceFamily ?? 'iphone'
      }
    })
  }, [runtimeDiscovery])
  return (
    <section className="workspace-page">
      <PageHeading title="프로젝트 설정" description="에이전트가 접근할 저장소와 검증 명령을 명시한다." />
      {inspection ? (
        <ProjectCapabilityPanel
          inspection={inspection}
          autoConnecting={autoConnecting}
          onAutoConnect={onAutoConnect}
          onConfigure={() => document.getElementById('ios-runtime-settings')?.scrollIntoView({ behavior: 'smooth' })}
          onRefresh={onRefreshInspection}
        />
      ) : (
        <ProjectCapabilityEmpty loading={inspectionLoading} onRefresh={onRefreshInspection} />
      )}
      <form className="panel settings-form" onSubmit={(event) => {
        event.preventDefault()
        void onSave({ projectId: project.id, name, setupCommand, testCommand, runtimeAdapter, publishStrategy, modelProfile })
      }}>
        <div className="setting-icon"><Settings2 size={18} /></div>
        <label><span>프로젝트 이름</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>저장소 경로</span><div className="path-field"><code>{project.path}</code><button type="button" disabled={project.isDemo} onClick={onOpen}><FolderOpen size={14} /> 열기</button></div></label>
        <label><span>환경 준비 명령</span><input value={setupCommand} placeholder="예: tuist install" onChange={(event) => setSetupCommand(event.target.value)} /><small>새 격리 작업공간을 만든 직후와 의존성 설정이 바뀐 뒤, 테스트보다 먼저 실행한다.</small></label>
        <label><span>검증 명령</span><input value={testCommand} placeholder="예: pnpm check 또는 xcodebuild test ..." onChange={(event) => setTestCommand(event.target.value)} /><small>shell 연산자 없이 허용된 실행 파일과 인자만 입력한다.</small></label>
        <div className="allowed-tools"><strong>허용된 준비·테스트 실행 파일</strong><span>pnpm · npm · npx · yarn · bun · tuist · xcodebuild · swift · cargo · go · python · pytest · make · cmake · gradle</span></div>
        <label>
          <span>기본 결과 게시 방식</span>
          <select value={publishStrategy} onChange={(event) => setPublishStrategy(event.target.value as PublishStrategy)}>
            <option value="pull-request">브랜치를 올리고 PR 만들기 (권장)</option>
            <option value="direct">작업 시작 브랜치에 직접 올리기</option>
          </select>
          <small>새 작업에 기본 적용됩니다. 작업을 등록할 때마다 바꿀 수 있습니다.</small>
        </label>
        <section className="runtime-settings codex-model-settings">
          <div className="runtime-settings-heading">
            <div>
              <strong>AI 모델</strong>
              <small>새 작업의 테크스펙·테스트 설계·구현·검토 단계에 적용됩니다.</small>
            </div>
            <button className="text-button" type="button" onClick={() => {
              setModelCatalogError(null)
              void bridge.listCodexModels(true)
                .then(setModelCatalog)
                .catch((error) => setModelCatalogError(String(error).replace(/^Error:\s*/, '')))
            }}><RotateCcw size={12} />목록 새로고침</button>
          </div>
          {modelCatalog
            ? <CodexModelProfileEditor catalog={modelCatalog} profile={modelProfile} onChange={setModelProfile} />
            : <p className="empty-copy"><LoaderCircle className="spin" size={12} />Codex 모델을 확인하고 있습니다.</p>}
          {modelCatalogError && <p className="tech-spec-error" role="alert">{modelCatalogError}</p>}
        </section>
        <section className="runtime-settings" id="ios-runtime-settings">
          <div className="runtime-settings-heading">
            <div>
              <strong>iOS Simulator 실행 설정</strong>
              <small>
                {runtimeAdapter
                  ? `${project.runtimeConfigSource === 'manifest' ? 'project.json에서 읽음' : '프로젝트에서 자동 감지'} · 작업별 검증 시나리오에 사용`
                  : 'Xcode 구성을 자동으로 찾지 못했습니다.'}
              </small>
            </div>
            <div className="runtime-settings-actions">
              <button type="button" className="secondary-button" disabled={autoConnecting} onClick={onAutoConnect}>
                {autoConnecting ? <LoaderCircle className="spin" size={13} /> : <Activity size={13} />}
                {autoConnecting ? '찾는 중' : '실행 설정 다시 찾기'}
              </button>
              {runtimeAdapter ? (
                <button type="button" className="text-button" onClick={() => setRuntimeAdapter(null)}>사용 안 함</button>
              ) : (
                <button type="button" className="text-button" onClick={() => setRuntimeAdapter({
                  kind: 'ios-simulator',
                  container: '',
                  scheme: '',
                  configuration: 'Debug',
                  deviceFamily: 'iphone'
                })}>직접 설정</button>
              )}
            </div>
          </div>
          {runtimeDiscovery && (
            <div className={`runtime-discovery-message state-${runtimeDiscovery.state}`} role="status">
              {runtimeDiscovery.state === 'ready' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
              <span>{runtimeDiscovery.message}</span>
            </div>
          )}
          {runtimeAdapter && (
            <div className="runtime-settings-grid">
              <label>
                <span>Xcode 프로젝트·Workspace</span>
                <input required value={runtimeAdapter.container} onChange={(event) => setRuntimeAdapter({ ...runtimeAdapter, container: event.target.value })} placeholder="예: MyApp.xcodeproj" />
              </label>
              <label>
                <span>Scheme</span>
                {runtimeDiscovery?.container === runtimeAdapter.container && runtimeDiscovery.appSchemes.length > 0 ? (
                  <select required value={runtimeAdapter.scheme} onChange={(event) => setRuntimeAdapter({ ...runtimeAdapter, scheme: event.target.value })}>
                    {runtimeDiscovery.appSchemes.map((candidate) => (
                      <option value={candidate.scheme} key={candidate.scheme}>
                        {candidate.scheme} · iOS 앱
                      </option>
                    ))}
                  </select>
                ) : (
                  <input required value={runtimeAdapter.scheme} onChange={(event) => setRuntimeAdapter({ ...runtimeAdapter, scheme: event.target.value })} placeholder="예: MyApp" />
                )}
              </label>
              <label>
                <span>실행 기기</span>
                <select value={runtimeAdapter.deviceFamily} onChange={(event) => setRuntimeAdapter({ ...runtimeAdapter, deviceFamily: event.target.value as 'iphone' | 'ipad' })}>
                  <option value="iphone">iPhone</option>
                  <option value="ipad">iPad</option>
                </select>
              </label>
              <label>
                <span>빌드 구성</span>
                <input disabled value="Debug" />
              </label>
            </div>
          )}
        </section>
        <section className="runtime-settings runtime-environment-settings">
          <div className="runtime-settings-heading">
            <div>
              <strong>Simulator 실행 환경</strong>
              <small>토큰 같은 로컬 값을 암호화해 저장하고, 필요한 검증 케이스에만 주입합니다. 값은 다시 표시되지 않습니다.</small>
            </div>
          </div>
          {runtimeEnvironment.length > 0 && (
            <div className="runtime-environment-list">
              {runtimeEnvironment.map((entry) => (
                <div className="runtime-environment-item" key={entry.id}>
                  <div>
                    <strong>{entry.label}</strong>
                    <code>{entry.key}</code>
                    <small>
                      {entry.buildSetting ? `빌드 ${entry.buildSetting}` : ''}
                      {entry.buildSetting && entry.launchVariable ? ' · ' : ''}
                      {entry.launchVariable ? `실행 ${entry.launchVariable}` : ''}
                    </small>
                  </div>
                  <span className={entry.configured ? 'configured' : ''}>{entry.configured ? '값 저장됨' : '값 없음'}</span>
                  <button
                    className="text-button"
                    type="button"
                    disabled={environmentBusy}
                    onClick={() => void bridge.deleteProjectRuntimeEnvironment({ projectId: project.id, id: entry.id }).then(setRuntimeEnvironment)}
                  >삭제</button>
                </div>
              ))}
            </div>
          )}
          <div className="runtime-environment-form">
            <label><span>항목 key</span><input value={environmentKey} onChange={(event) => setEnvironmentKey(event.target.value)} placeholder="mapbox-public-token" /></label>
            <label><span>표시 이름</span><input value={environmentLabel} onChange={(event) => setEnvironmentLabel(event.target.value)} placeholder="Mapbox 공개 토큰" /></label>
            <label>
              <span>적용 범위</span>
              <select value={environmentScope} onChange={(event) => setEnvironmentScope(event.target.value as typeof environmentScope)}>
                <option value="both">빌드 + 앱 실행</option>
                <option value="build">Xcode 빌드만</option>
                <option value="launch">앱 실행만</option>
              </select>
            </label>
            {environmentScope !== 'launch' && <label><span>Build setting</span><input value={buildSetting} onChange={(event) => setBuildSetting(event.target.value)} placeholder="MAPBOX_ACCESS_TOKEN" /></label>}
            {environmentScope !== 'build' && <label><span>앱 환경변수</span><input value={launchVariable} onChange={(event) => setLaunchVariable(event.target.value)} placeholder="UITEST_MAPBOX_ACCESS_TOKEN" /></label>}
            <label><span>민감한 값</span><input type="password" autoComplete="off" value={environmentValue} onChange={(event) => setEnvironmentValue(event.target.value)} placeholder="저장 후 다시 표시되지 않음" /></label>
            <button className="secondary-button" type="button" disabled={environmentBusy || !environmentKey.trim() || !environmentLabel.trim() || !environmentValue} onClick={() => void saveRuntimeEnvironment()}>
              {environmentBusy ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
              환경값 저장
            </button>
          </div>
          {environmentError && <p className="tech-spec-error" role="alert">{environmentError}</p>}
        </section>
        <button className="primary-button" type="submit">설정 저장</button>
      </form>
      <section className="panel danger-zone">
        <div>
          <strong>프로젝트 연결 삭제</strong>
          <p>AgentMonitoring 기록과 관리 중인 worktree만 정리합니다. 원본 Git 저장소는 보존됩니다.</p>
        </div>
        <button className="danger-button" type="button" onClick={onRemove}><Trash2 size={13} />연결 삭제</button>
      </section>
    </section>
  )
}

function PageHeading({ title, description, action, onAction }: { title: string; description: string; action?: string; onAction?: () => void }): React.JSX.Element {
  return <header className="page-heading"><div><h2>{title}</h2><p>{description}</p></div>{action && <button className="primary-button" onClick={onAction}><Plus size={14} />{action}</button>}</header>
}

function EmptyState({ icon: Icon, title }: { icon: typeof Bug; title: string }): React.JSX.Element {
  return <div className="panel empty-state"><Icon size={20} /><span>{title}</span></div>
}

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className={`modal-card${wide ? ' modal-wide' : ''}`} role="dialog" aria-label={title} aria-modal="true">
        <header><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button aria-label="닫기" onClick={onClose}><X size={16} /></button></header>
        {children}
      </section>
    </div>
  )
}

function UsageHelpModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const startSteps = [
    ['1', '프로젝트 연결', '실제 Git 프로젝트 추가를 누르고 저장소 루트를 선택하세요.'],
    ['2', '실행 영역 연결', 'Swift 앱에서 Build·Run·Observe·Act가 회색이면 iOS 자동 연결을 누르세요.'],
    ['3', '준비·검증 명령 확인', '필요한 의존성 준비 명령과 실제로 통과하는 테스트 명령을 프로젝트 설정에서 확인하세요.'],
    ['4', '작업 만들기', '새 작업에서 목표와 확인 가능한 완료 조건을 작성하세요.'],
    ['5', '검증 계획 확인', 'AI 추천을 보고 테스트, Simulator 또는 수동 검토 중 필요한 조합을 고르세요.'],
    ['6', '실행 시작', '작업을 등록한 뒤 작업 상세에서 실행을 눌러야 개발이 시작돼요.']
  ]
  const pipeline = [
    ['검증 계획 적용', '작업을 만들 때 사람이 확인한 검증 단계만 실행합니다.'],
    ['환경 준비', '새 격리 작업공간에 필요한 의존성을 테스트 전에 준비합니다.'],
    ['선택한 테스트 설계', '필요한 작업에서만 Test Designer와 Critic이 테스트를 만들고 검토합니다.'],
    ['기능 구현', 'Implementer가 격리된 Git worktree에서 코드를 수정합니다.'],
    ['선택한 자동 검증', '의존성 설정이 바뀌면 환경을 다시 준비한 뒤 프로젝트 테스트, Simulator 또는 두 검증을 실행합니다.'],
    ['자가 수정', '실패하면 로그와 화면 증거를 전달해 남은 횟수만큼 다시 구현합니다.'],
    ['최종 검토', 'Reviewer가 diff, 테스트와 실행 증거를 읽고 문제를 보고합니다.'],
    ['사람 승인', '결과를 확인한 뒤 게시하거나 격리 변경을 폐기합니다.'],
    ['원격 게시', '작업에서 선택한 방식에 따라 브랜치와 PR을 만들거나 작업 시작 브랜치에 직접 게시합니다.'],
    ['로컬 동기화', '원격 반영이 끝나면 현재 로컬 브랜치를 fast-forward로 맞추고 완료 처리합니다.']
  ]
  const verificationModes = [
    ['프로젝트 테스트만', '로직·데이터·회귀 작업', '테스트 설계(선택) → 구현 → 검증 명령 → Reviewer'],
    ['Simulator 검증만', '화면 표시와 사용자 조작', '구현 → Simulator 실행·조작·판정 → Reviewer'],
    ['둘 다', '로직과 화면을 함께 바꾸는 기능', '프로젝트 테스트와 Simulator를 차례로 실행'],
    ['수동 검토만', '문서·설정처럼 자동 검증이 맞지 않는 작업', '구현 → Reviewer → 사람이 직접 확인']
  ]

  return (
    <Modal
      wide
      title="처음 작업 시작하기"
      description="실제 프로젝트 연결부터 Codex 실행과 원격 게시까지 한 번에 확인하세요."
      onClose={onClose}
    >
      <div className="usage-help">
        <section className="usage-help-intro">
          <Bot size={20} />
          <div>
            <strong>AgentMonitoring은 코드 편집기가 아니라 AI 개발 작업 관리자예요.</strong>
            <p>Codex가 별도 작업공간에서 구현하고 검증하는 동안 원본 저장소를 보호하고, PR 또는 직접 게시 여부는 사람이 결정해요.</p>
          </div>
        </section>

        <section className="usage-help-section">
          <header><span>START</span><h3>처음 작업은 이 순서로 시작하세요</h3></header>
          <ol className="usage-start-steps">
            {startSteps.map(([number, title, description]) => (
              <li key={number}>
                <span>{number}</span>
                <div><strong>{title}</strong><p>{description}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="usage-help-section usage-example">
          <header><span>EXAMPLE</span><h3>새 작업에는 이렇게 입력해 보세요</h3></header>
          <div className="usage-example-title"><span>작업 제목</span><code>장보기 목록 화면 구현</code></div>
          <div className="usage-example-prompt">
            <span>목표와 완료 조건</span>
            <pre>장보기 항목을 입력하고 추가하면 목록에 표시되게 해주세요.{'\n'}구매 완료를 누르면 완료 상태로 바뀌어야 합니다.{'\n'}빈 입력은 추가하지 말고 성공·실패 경로를 테스트해 주세요.</pre>
          </div>
          <p className="usage-example-note">구현 방법보다 사용자가 보게 될 결과와 실패 조건을 적는 것이 중요해요.</p>
        </section>

        <section className="usage-help-section">
          <header><span>VERIFY</span><h3>작업마다 필요한 검증만 고르세요</h3></header>
          <div className="usage-verification-modes">
            {verificationModes.map(([title, useCase, flow]) => (
              <article key={title}><strong>{title}</strong><span>{useCase}</span><p>{flow}</p></article>
            ))}
          </div>
          <p className="usage-retry-note">새 작업의 <strong>AI에게 추천받기</strong>는 초안을 만들어요. 실제 실행 계획은 사람이 확인하거나 바꾼 뒤 등록해야 해요.</p>
        </section>

        <section className="usage-help-section">
          <header><span>PIPELINE</span><h3>실행을 누르면 내부에서 이렇게 진행돼요</h3></header>
          <ol className="usage-pipeline">
            {pipeline.map(([title, description], index) => (
              <li key={title}>
                <span>{index + 1}</span>
                <div><strong>{title}</strong><p>{description}</p></div>
              </li>
            ))}
          </ol>
          <p className="usage-retry-note"><strong>최대 구현 3회</strong>는 AI 전체 호출 횟수가 아니라 Implementer가 코드를 고칠 수 있는 기회를 뜻해요. 의존성·네트워크 같은 환경 오류는 이 횟수를 소모하지 않고 멈추며, 환경을 고친 뒤 기존 코드를 유지한 채 검증만 다시 실행할 수 있어요.</p>
        </section>

        <section className="usage-boundaries" aria-label="승인 단계 구분">
          <article><ShieldCheck size={15} /><div><strong>검증 계획 확인하고 작업 등록</strong><p>실행할 단계와 합격 조건을 고정하고 작업만 만들어요. 아직 실행하지 않아요.</p></div></article>
          <article><Play size={15} /><div><strong>실행</strong><p>격리 작업공간을 만들고 Codex 파이프라인을 시작해요.</p></div></article>
          <article><GitBranch size={15} /><div><strong>원격에 게시</strong><p>PR 또는 직접 게시를 실행하고 원격 반영 뒤 로컬 브랜치를 동기화해요.</p></div></article>
        </section>

        <footer className="usage-help-footer">
          <p>작업 상세에서 각 단계의 통과·확인 필요·건너뜀을 확인할 수 있어요. 수동 검토 작업은 자동 통과로 표시하지 않아요.</p>
          <button className="primary-button" type="button" onClick={onClose}>확인했어요</button>
        </footer>
      </div>
    </Modal>
  )
}

function StorageModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [retentionDays, setRetentionDays] = useState<RuntimeArtifactRetentionDays>(30)
  const [removeLocalBranches, setRemoveLocalBranches] = useState(false)
  const [result, setResult] = useState<StorageCleanupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setStorageError(null)
    try {
      const next = await bridge.getStorageOverview()
      setOverview(next)
      setRetentionDays(next.policy.runtimeArtifactRetentionDays)
    } catch (error) {
      setStorageError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const savePolicy = async (): Promise<void> => {
    setBusy(true)
    setStorageError(null)
    setResult(null)
    try {
      setOverview(await bridge.setStoragePolicy({ runtimeArtifactRetentionDays: retentionDays }))
    } catch (error) {
      setStorageError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  const cleanup = async (): Promise<void> => {
    const warning = removeLocalBranches
      ? '완료·폐기 작업의 agentmonitor 로컬 브랜치도 삭제합니다. 폐기한 변경은 복구할 수 없습니다. 계속할까요?'
      : '현재 보관 정책이 지난 실행 증거와 사용하지 않는 격리 작업공간을 정리할까요?'
    if (!window.confirm(warning)) return
    setBusy(true)
    setStorageError(null)
    setResult(null)
    try {
      await bridge.setStoragePolicy({ runtimeArtifactRetentionDays: retentionDays })
      const cleanupResult = await bridge.cleanupStorage({ removeLocalBranches })
      setResult(cleanupResult)
      setOverview(cleanupResult.overview)
    } catch (error) {
      setStorageError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title="저장 공간 관리"
      description="격리 작업공간은 작업 상태에 맞춰 정리하고, 실행 증거는 선택한 기간 동안 보관합니다."
      onClose={onClose}
    >
      <div className="storage-manager">
        {loading && <div className="storage-loading"><LoaderCircle className="spin" size={16} />사용량 계산 중</div>}
        {!loading && overview && (
          <>
            <div className="storage-summary">
              <article>
                <span>전체 사용량</span>
                <strong>{formatBytes(overview.totalBytes)}</strong>
                <small>{timeAgo(overview.scannedAt)} 확인</small>
              </article>
              <article>
                <span>격리 작업공간</span>
                <strong>{formatBytes(overview.worktreeBytes)}</strong>
                <small>{overview.worktreeCount}개 · 승인·폐기 시 즉시 정리</small>
              </article>
              <article>
                <span>실행 증거 · 진행 중 빌드</span>
                <strong>{formatBytes(overview.runtimeArtifactBytes)}</strong>
                <small>{overview.runtimeArtifactCount}개 작업 기록 · 완료·폐기 시 빌드 정리</small>
              </article>
            </div>

            <section className="storage-policy">
              <div>
                <strong>Simulator 실행 기록 보관</strong>
                <p>화면 캡처, 접근성 트리와 UI 조작 결과를 보관합니다. DerivedData는 완료·폐기 시 바로 삭제합니다.</p>
              </div>
              <select
                aria-label="Simulator 실행 기록 보관 기간"
                value={retentionDays}
                onChange={(event) => setRetentionDays(Number(event.target.value) as RuntimeArtifactRetentionDays)}
              >
                <option value={0}>완료·폐기 후 바로 삭제</option>
                <option value={7}>7일</option>
                <option value={30}>30일 (기본값)</option>
                <option value={90}>90일</option>
              </select>
              <button className="secondary-button" disabled={busy} onClick={() => void savePolicy()}>
                {busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}정책 저장
              </button>
            </section>

            <label className="branch-cleanup-option">
              <input
                type="checkbox"
                checked={removeLocalBranches}
                onChange={(event) => setRemoveLocalBranches(event.target.checked)}
              />
              <span>
                <strong>완료·폐기된 로컬 작업 브랜치도 삭제</strong>
                <small>대상 {overview.branchCandidateCount}개 · 폐기 작업의 미병합 변경은 복구할 수 없습니다.</small>
              </span>
            </label>

            <div className="storage-cleanup-row">
              <div>
                <strong>지금 정리할 항목 {overview.cleanupCandidateCount}개</strong>
                <p>실행 중이거나 다시 실행할 수 있는 실패·중단 작업은 자동으로 삭제하지 않습니다.</p>
              </div>
              <button className="primary-button" disabled={busy} onClick={() => void cleanup()}>
                {busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}지금 정리
              </button>
            </div>
          </>
        )}
        {result && (
          <div className={`storage-result${result.warnings.length > 0 ? ' warning' : ''}`} role="status">
            <CheckCircle2 size={15} />
            <div>
              <strong>{formatBytes(result.bytesReclaimed)} 확보했습니다.</strong>
              <p>작업공간 {result.worktreesRemoved}개 · 실행 기록 {result.runtimeArtifactsRemoved}개 · 브랜치 {result.branchesRemoved}개 정리</p>
              {result.warnings.map((warning) => <small key={warning}>{warning}</small>)}
            </div>
          </div>
        )}
        {storageError && <div className="storage-error" role="alert"><AlertTriangle size={14} />{storageError}</div>}
      </div>
    </Modal>
  )
}

function TaskModal({
  project,
  onClose,
  onCreate,
  onGenerateTechSpec,
  onRefineTechSpec,
  onGenerate,
  onRecommend
}: {
  project: ProjectRecord
  onClose: () => void
  onCreate: (input: Parameters<AgentMonitoringBridge['createTask']>[0]) => Promise<void>
  onGenerateTechSpec: (input: Parameters<AgentMonitoringBridge['generateTechSpec']>[0]) => Promise<GeneratedTechSpec>
  onRefineTechSpec: (input: Parameters<AgentMonitoringBridge['refineTechSpec']>[0]) => Promise<GeneratedTechSpec>
  onGenerate: (input: Parameters<AgentMonitoringBridge['generateRuntimeScenario']>[0]) => Promise<GeneratedRuntimeScenario>
  onRecommend: (input: Parameters<AgentMonitoringBridge['recommendVerificationPlan']>[0]) => Promise<VerificationPlanRecommendation>
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [overrideModelProfile, setOverrideModelProfile] = useState(false)
  const [modelProfile, setModelProfile] = useState<CodexModelProfile>(() => cloneModelProfile(project.modelProfile))
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalog | null>(null)
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null)
  const [useTechSpec, setUseTechSpec] = useState(false)
  const [techSpec, setTechSpec] = useState<GeneratedTechSpec | null>(null)
  const [techSpecApproved, setTechSpecApproved] = useState(false)
  const [techSpecSource, setTechSpecSource] = useState<string | null>(null)
  const [techSpecFeedback, setTechSpecFeedback] = useState('')
  const [techSpecLoading, setTechSpecLoading] = useState(false)
  const [techSpecError, setTechSpecError] = useState<string | null>(null)
  const [maxAttempts, setMaxAttempts] = useState(3)
  const [publishStrategy, setPublishStrategy] = useState<PublishStrategy>(project.publishStrategy ?? 'pull-request')
  const initialMode: VerificationMode = project.testCommand.trim()
    ? project.runtimeAdapter ? 'both' : 'project-tests'
    : project.runtimeAdapter ? 'simulator-runtime' : 'manual-review'
  const [mode, setMode] = useState<VerificationMode>(initialMode)
  const [testDesign, setTestDesign] = useState<TestDesignStrategy>(
    initialMode === 'project-tests' || initialMode === 'both' ? 'automatic' : 'skip'
  )
  const [runtimeSource, setRuntimeSource] = useState<RuntimeVerificationSource>(
    initialMode === 'simulator-runtime' || initialMode === 'both' ? 'task-scenario' : 'off'
  )
  const [recommendation, setRecommendation] = useState<string | null>(null)
  const [recommending, setRecommending] = useState(false)
  const [generated, setGenerated] = useState<GeneratedRuntimeScenario | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [configuredEnvironmentKeys, setConfiguredEnvironmentKeys] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const taskModelProfile = overrideModelProfile ? modelProfile : undefined
  const usesTests = mode === 'project-tests' || mode === 'both'
  const usesRuntime = mode === 'simulator-runtime' || mode === 'both'
  const requirementsKey = `${title}\u0000${prompt}\u0000${overrideModelProfile ? JSON.stringify(modelProfile) : 'project-default'}`
  const techSpecStale = Boolean(techSpec && techSpecSource !== requirementsKey)
  const techSpecReady = Boolean(useTechSpec && techSpec && techSpecApproved && !techSpecStale)
  const approvedTechSpec = techSpecReady && techSpec
    ? {
        version: 1 as const,
        revision: techSpec.revision,
        summary: techSpec.summary,
        markdown: techSpec.markdown,
        openQuestions: techSpec.openQuestions
      }
    : null
  useEffect(() => {
    let active = true
    void bridge.listProjectRuntimeEnvironment(project.id).then((entries) => {
      if (active) setConfiguredEnvironmentKeys(new Set(entries.filter((entry) => entry.configured).map((entry) => entry.key)))
    }).catch(() => undefined)
    return () => { active = false }
  }, [project.id])
  useEffect(() => {
    let active = true
    void bridge.listCodexModels()
      .then((catalog) => { if (active) setModelCatalog(catalog) })
      .catch((error) => { if (active) setModelCatalogError(String(error).replace(/^Error:\s*/, '')) })
    return () => { active = false }
  }, [project.id])

  const invalidateDownstreamPlanning = (): void => {
    setGenerated(null)
    setRecommendation(null)
    setGenerationError(null)
  }

  const generateTechSpec = async (): Promise<void> => {
    setTechSpecLoading(true)
    setTechSpecError(null)
    try {
      const result = await onGenerateTechSpec({ projectId: project.id, title, prompt, modelProfile: taskModelProfile })
      setTechSpec(result)
      setTechSpecSource(requirementsKey)
      setTechSpecApproved(false)
      setTechSpecFeedback('')
      invalidateDownstreamPlanning()
    } catch (error) {
      setTechSpecError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setTechSpecLoading(false)
    }
  }

  const refineTechSpec = async (): Promise<void> => {
    if (!techSpec || techSpecFeedback.trim().length < 3) return
    setTechSpecLoading(true)
    setTechSpecError(null)
    try {
      const result = await onRefineTechSpec({
        projectId: project.id,
        title,
        prompt,
        current: {
          version: 1,
          revision: techSpec.revision,
          summary: techSpec.summary,
          markdown: techSpec.markdown,
          openQuestions: techSpec.openQuestions
        },
        feedback: techSpecFeedback,
        modelProfile: taskModelProfile
      })
      setTechSpec(result)
      setTechSpecSource(requirementsKey)
      setTechSpecApproved(false)
      setTechSpecFeedback('')
      invalidateDownstreamPlanning()
    } catch (error) {
      setTechSpecError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setTechSpecLoading(false)
    }
  }

  const changeMode = (nextMode: VerificationMode): void => {
    const nextUsesTests = nextMode === 'project-tests' || nextMode === 'both'
    const nextUsesRuntime = nextMode === 'simulator-runtime' || nextMode === 'both'
    setMode(nextMode)
    setTestDesign((current) => nextUsesTests ? current === 'skip' ? 'automatic' : current : 'skip')
    setRuntimeSource((current) => nextUsesRuntime
      ? current === 'off' ? 'task-scenario' : current
      : 'off')
    if (!nextUsesRuntime) setGenerated(null)
    setRecommendation(null)
    setGenerationError(null)
  }

  const recommend = async (): Promise<void> => {
    setRecommending(true)
    setGenerationError(null)
    try {
      const result = await onRecommend({
        projectId: project.id,
        title,
        prompt,
        techSpec: approvedTechSpec,
        modelProfile: taskModelProfile
      })
      setMode(result.plan.mode)
      setTestDesign(result.plan.testDesign)
      setRuntimeSource(result.plan.runtimeSource)
      setGenerated(null)
      setRecommendation(result.summary)
    } catch (error) {
      setGenerationError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setRecommending(false)
    }
  }

  const generate = async (): Promise<void> => {
    setGenerating(true)
    setGenerationError(null)
    try {
      setGenerated(await onGenerate({
        projectId: project.id,
        title,
        prompt,
        techSpec: approvedTechSpec,
        modelProfile: taskModelProfile
      }))
    } catch (error) {
      setGenerationError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setGenerating(false)
    }
  }
  const updateAction = (index: number, action: RuntimeUiAction): void => {
    if (!generated || generated.contract.version !== 1) return
    const actions = generated.contract.runtimeScenario.actions.map((current, actionIndex) => actionIndex === index ? action : current)
    setGenerated({
      ...generated,
      contract: { ...generated.contract, runtimeScenario: { ...generated.contract.runtimeScenario, actions } }
    })
  }
  const updatePermission = (index: number, permission: RuntimePrivacyPermission): void => {
    if (!generated || generated.contract.version !== 1) return
    const permissions = (generated.contract.runtimeScenario.permissions ?? []).map(
      (current, permissionIndex) => permissionIndex === index ? permission : current
    )
    setGenerated({
      ...generated,
      contract: {
        ...generated.contract,
        runtimeScenario: { ...generated.contract.runtimeScenario, permissions }
      }
    })
  }
  const updateAssertion = (index: number, assertion: RuntimeAcceptanceAssertion): void => {
    if (!generated || generated.contract.version !== 1) return
    const assertions = generated.contract.runtimeScenario.assertions.map((current, assertionIndex) => assertionIndex === index ? assertion : current)
    setGenerated({
      ...generated,
      contract: { ...generated.contract, runtimeScenario: { ...generated.contract.runtimeScenario, assertions } }
    })
  }
  const updateV2Case = (
    caseIndex: number,
    update: (scenario: RuntimeScenarioCase) => RuntimeScenarioCase
  ): void => {
    if (!generated || generated.contract.version !== 2) return
    const cases = generated.contract.runtimeScenarios.cases.map((scenario, index) => index === caseIndex ? update(scenario) : scenario)
    setGenerated({ ...generated, contract: { ...generated.contract, runtimeScenarios: { cases } } })
  }
  const missingRuntimeEnvironmentKeys = generated?.contract.version === 2
    ? [...new Set(generated.contract.runtimeScenarios.cases.flatMap((scenario) => scenario.preconditions.requiredEnvironmentKeys ?? []))]
        .filter((key) => !configuredEnvironmentKeys.has(key))
    : []
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (usesTests && !project.testCommand.trim()) {
      setGenerationError('프로젝트 테스트를 사용하려면 프로젝트 설정에서 검증 명령을 먼저 등록하세요.')
      return
    }
    if (useTechSpec && !techSpecReady) {
      setTechSpecError('테크스펙을 만들고 최종 내용을 승인한 뒤 작업을 등록하세요.')
      return
    }
    if (usesRuntime && runtimeSource === 'task-scenario' && !generated) {
      setGenerationError('작업을 등록하기 전에 검증 시나리오를 만들고 확인하세요.')
      return
    }
    if (missingRuntimeEnvironmentKeys.length > 0) {
      setGenerationError(`프로젝트 설정에서 필수 실행 환경값을 먼저 등록하세요: ${missingRuntimeEnvironmentKeys.join(', ')}`)
      return
    }
    setSubmitting(true)
    try {
      await onCreate({
        projectId: project.id,
        title,
        prompt,
        maxAttempts,
        runtimeContract: usesRuntime && runtimeSource === 'task-scenario' ? generated?.contract ?? null : null,
        runtimeScenarioSummary: usesRuntime && runtimeSource === 'task-scenario' ? generated?.summary ?? null : null,
        techSpec: approvedTechSpec,
        verificationPlan: { version: 1, mode, testDesign, runtimeSource },
        publishStrategy,
        modelProfile: taskModelProfile
      })
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal wide title="새 에이전트 작업" description={`${project.name}의 격리된 worktree에서 실행된다.`} onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <label><span>작업 제목</span><input autoFocus minLength={2} maxLength={120} required value={title} onChange={(event) => { setTitle(event.target.value); setTechSpecApproved(false); invalidateDownstreamPlanning() }} placeholder="예: 네비게이션 경로 이탈 감지 구현" /></label>
        <label><span>목표와 완료 조건</span><textarea minLength={10} maxLength={20000} required rows={6} value={prompt} onChange={(event) => { setPrompt(event.target.value); setTechSpecApproved(false); invalidateDownstreamPlanning() }} placeholder="구현할 동작, 제외 범위, 통과해야 할 테스트를 구체적으로 작성한다." /></label>
        <section className={`task-model-selector${overrideModelProfile ? ' enabled' : ''}`}>
          <label className="tech-spec-toggle">
            <input
              type="checkbox"
              checked={overrideModelProfile}
              onChange={(event) => {
                setOverrideModelProfile(event.target.checked)
                setTechSpecApproved(false)
                invalidateDownstreamPlanning()
              }}
            />
            <Bot size={15} />
            <span>
              <strong>이 작업만 AI 모델 변경</strong>
              <small>{overrideModelProfile ? modelProfileSummary(modelProfile, modelCatalog) : `프로젝트 설정 사용 · ${modelProfileSummary(project.modelProfile, modelCatalog)}`}</small>
            </span>
          </label>
          {overrideModelProfile && modelCatalog && (
            <CodexModelProfileEditor catalog={modelCatalog} profile={modelProfile} onChange={(profile) => {
              setModelProfile(profile)
              setTechSpecApproved(false)
              invalidateDownstreamPlanning()
            }} />
          )}
          {overrideModelProfile && !modelCatalog && !modelCatalogError && <p className="empty-copy"><LoaderCircle className="spin" size={12} />Codex 모델을 확인하고 있습니다.</p>}
          {modelCatalogError && <p className="tech-spec-error" role="alert">{modelCatalogError}</p>}
        </section>
        <section className={`tech-spec-builder${useTechSpec ? ' enabled' : ''}`}>
          <label className="tech-spec-toggle">
            <input
              type="checkbox"
              checked={useTechSpec}
              onChange={(event) => {
                setUseTechSpec(event.target.checked)
                setTechSpecApproved(false)
                setTechSpecError(null)
                invalidateDownstreamPlanning()
              }}
            />
            <FileText size={15} />
            <span>
              <strong>구현 전 테크스펙 만들기</strong>
              <small>선택사항 · AI가 요구사항과 현재 코드를 읽고 구현 계획 초안을 만듭니다.</small>
            </span>
          </label>
          {useTechSpec && !techSpec && (
            <div className="tech-spec-empty">
              <div>
                <strong>요구사항을 구현 가능한 설계로 구체화합니다</strong>
                <p>생성된 문서를 직접 수정하거나 개선 의견을 보낸 뒤 최종본을 승인할 수 있습니다.</p>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={techSpecLoading || title.trim().length < 2 || prompt.trim().length < 10}
                onClick={() => void generateTechSpec()}
              >
                {techSpecLoading ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}
                {techSpecLoading ? '저장소 분석 중' : '테크스펙 만들기'}
              </button>
            </div>
          )}
          {useTechSpec && techSpec && (
            <div className="tech-spec-review">
              <header>
                <div>
                  <span>테크스펙 revision {techSpec.revision}</span>
                  <strong>{techSpec.changeSummary}</strong>
                </div>
                <button className="text-button" type="button" disabled={techSpecLoading} onClick={() => void generateTechSpec()}>
                  요구사항에서 다시 생성
                </button>
              </header>
              {techSpecStale && (
                <p className="tech-spec-stale"><AlertTriangle size={13} />제목이나 요구사항이 바뀌었습니다. 다시 생성하거나 아래 피드백으로 변경사항을 반영하세요.</p>
              )}
              <label>
                <span>테크스펙 요약</span>
                <input
                  aria-label="테크스펙 요약"
                  maxLength={500}
                  value={techSpec.summary}
                  onChange={(event) => {
                    setTechSpec({ ...techSpec, summary: event.target.value })
                    setTechSpecApproved(false)
                    invalidateDownstreamPlanning()
                  }}
                />
              </label>
              <label>
                <span>테크스펙 본문</span>
                <textarea
                  aria-label="테크스펙 본문"
                  minLength={100}
                  maxLength={30000}
                  rows={15}
                  value={techSpec.markdown}
                  onChange={(event) => {
                    setTechSpec({ ...techSpec, markdown: event.target.value })
                    setTechSpecApproved(false)
                    invalidateDownstreamPlanning()
                  }}
                />
              </label>
              {techSpec.openQuestions.length > 0 && (
                <div className="tech-spec-questions">
                  <strong>확인하면 좋은 항목</strong>
                  {techSpec.openQuestions.map((question) => <p key={question}>{question}</p>)}
                </div>
              )}
              <div className="tech-spec-refine">
                <label>
                  <span>AI에게 개선 요청</span>
                  <textarea
                    aria-label="테크스펙 개선 의견"
                    rows={3}
                    maxLength={5000}
                    value={techSpecFeedback}
                    onChange={(event) => setTechSpecFeedback(event.target.value)}
                    placeholder="예: 네트워크 실패 처리와 롤백 조건을 더 구체적으로 적어줘."
                  />
                </label>
                <button className="secondary-button" type="button" disabled={techSpecLoading || techSpecFeedback.trim().length < 3} onClick={() => void refineTechSpec()}>
                  {techSpecLoading ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}
                  {techSpecLoading ? '피드백 반영 중' : '피드백 반영'}
                </button>
              </div>
              <div className={`tech-spec-approval${techSpecApproved && !techSpecStale ? ' approved' : ''}`}>
                <div>
                  <ShieldCheck size={15} />
                  <span><strong>{techSpecApproved && !techSpecStale ? '이 테크스펙을 사용합니다' : '최종 내용을 확인하세요'}</strong><small>승인된 내용은 테스트 설계·구현·Reviewer에 함께 전달됩니다.</small></span>
                </div>
                <button
                  className={techSpecApproved && !techSpecStale ? 'secondary-button' : 'primary-button'}
                  type="button"
                  disabled={techSpecLoading || techSpecStale || techSpec.summary.trim().length < 1 || techSpec.markdown.trim().length < 100}
                  onClick={() => {
                    if (techSpecApproved) invalidateDownstreamPlanning()
                    setTechSpecApproved((current) => !current)
                  }}
                >
                  <ShieldCheck size={13} />
                  {techSpecApproved && !techSpecStale ? '승인 취소' : '이 테크스펙으로 진행'}
                </button>
              </div>
            </div>
          )}
          {useTechSpec && techSpecError && <p className="tech-spec-error">{techSpecError}</p>}
        </section>
        <section className="verification-planner">
          <header>
            <div><strong>이 작업의 검증 방식</strong><p>AI 추천을 받은 뒤 실제로 필요한 단계만 선택하세요. 등록하면 이 계획이 작업에 고정됩니다.</p></div>
            <button className="secondary-button" type="button" disabled={recommending || title.trim().length < 2 || prompt.trim().length < 10 || (useTechSpec && !techSpecReady)} onClick={() => void recommend()}>
              {recommending ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}
              {recommending ? '프로젝트 분석 중' : 'AI에게 추천받기'}
            </button>
          </header>
          {recommendation && <p className="verification-recommendation"><ShieldCheck size={13} /><span><strong>AI 추천</strong>{recommendation}</span></p>}
          {useTechSpec && !techSpecReady && <p className="verification-plan-summary"><FileText size={13} />테크스펙을 승인하면 그 내용을 포함해 검증 계획을 추천합니다.</p>}
          <div className="verification-options">
            <label>
              <span>검증 조합</span>
              <select value={mode} onChange={(event) => changeMode(event.target.value as VerificationMode)}>
                <option value="project-tests" disabled={!project.testCommand.trim()}>프로젝트 테스트만{!project.testCommand.trim() ? ' · 검증 명령 필요' : ''}</option>
                <option value="simulator-runtime" disabled={!project.runtimeAdapter}>Simulator 검증만{!project.runtimeAdapter ? ' · 실행 연결 필요' : ''}</option>
                <option value="both" disabled={!project.testCommand.trim() || !project.runtimeAdapter}>프로젝트 테스트 + Simulator</option>
                <option value="manual-review">수동 검토만</option>
              </select>
            </label>
            {usesTests && (
              <label>
                <span>테스트 설계</span>
                <select value={testDesign} onChange={(event) => setTestDesign(event.target.value as TestDesignStrategy)}>
                  <option value="automatic">프로젝트에 맞게 자동 선택</option>
                  <option value="swift-testing">Swift Testing</option>
                  <option value="xctest">XCTest</option>
                  <option value="existing-tests">기존 테스트만 실행</option>
                  <option value="skip">테스트 설계 건너뛰기</option>
                </select>
              </label>
            )}
            {usesRuntime && (
              <label>
                <span>Simulator 시나리오</span>
                <select value={runtimeSource} onChange={(event) => { setRuntimeSource(event.target.value as RuntimeVerificationSource); setGenerated(null); setRecommendation(null) }}>
                  <option value="task-scenario">이 작업 전용 시나리오</option>
                  <option value="project-default" disabled={project.runtimeConfigSource !== 'manifest'}>프로젝트 기본 시나리오{project.runtimeConfigSource !== 'manifest' ? ' · project.json 필요' : ''}</option>
                </select>
              </label>
            )}
          </div>
          <p className="verification-plan-summary">
            <strong>{VERIFICATION_MODE_LABELS[mode]}</strong>
            {usesTests ? ` · ${TEST_DESIGN_LABELS[testDesign]}` : ''}
            {usesRuntime ? ` · ${RUNTIME_SOURCE_LABELS[runtimeSource]}` : ''}
          </p>
          {mode === 'manual-review' && <p className="manual-review-warning"><AlertTriangle size={13} />자동 통과로 표시하지 않습니다. 구현과 Reviewer 검토 뒤 사람이 직접 확인해야 합니다.</p>}
        </section>
        {usesRuntime && runtimeSource === 'task-scenario' && project.runtimeAdapter && (
          <section className="scenario-builder">
            <div className="scenario-toggle">
              <SquareTerminal size={14} />
              <span>
                <strong>작업 전용 Simulator 검증</strong>
                <small>{project.runtimeAdapter.scheme} · {project.runtimeAdapter.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'} · Debug</small>
              </span>
            </div>
            {!generated && (
              <div className="scenario-empty">
                <ShieldCheck size={18} />
                <div><strong>자연어 목표를 검증 단계로 바꿉니다</strong><p>Codex가 저장소를 읽고 누를 요소와 확인할 결과를 제안합니다. 확인한 뒤에만 작업에 고정됩니다.</p></div>
                <button className="secondary-button" type="button" disabled={generating || title.trim().length < 2 || prompt.trim().length < 10 || (useTechSpec && !techSpecReady)} onClick={() => void generate()}>
                  {generating ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}
                  {generating ? '시나리오 생성 중' : '검증 시나리오 만들기'}
                </button>
              </div>
            )}
            {generated && (
              <div className="scenario-review">
                <header>
                  <div><span>승인 전 검토</span><strong>{generated.summary}</strong></div>
                  <button className="text-button" type="button" disabled={generating} onClick={() => void generate()}>다시 생성</button>
                </header>
                {generated.contract.version === 1 ? <div className="scenario-list">
                  {(generated.contract.runtimeScenario.permissions?.length ?? 0) > 0 && (
                    <>
                      <p>Simulator 준비 조건</p>
                      {generated.contract.runtimeScenario.permissions!.map((permission, index) => (
                        <div className="scenario-row permission" key={`permission-${index}`}>
                          <span>{index + 1}</span>
                          <strong>개인정보 권한</strong>
                          <select
                            aria-label={`권한 ${index + 1} 서비스`}
                            value={permission.service}
                            onChange={(event) => updatePermission(index, {
                              ...permission,
                              service: event.target.value as RuntimePrivacyPermission['service']
                            })}
                          >
                            {Object.entries(PRIVACY_SERVICE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                          </select>
                          <select
                            aria-label={`권한 ${index + 1} 상태`}
                            value={permission.state}
                            onChange={(event) => updatePermission(index, {
                              ...permission,
                              state: event.target.value as RuntimePrivacyPermission['state']
                            })}
                          >
                            {Object.entries(PRIVACY_STATE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                          </select>
                        </div>
                      ))}
                    </>
                  )}
                  <p>사용자 조작 {generated.contract.runtimeScenario.actions.length}단계</p>
                  {generated.contract.runtimeScenario.actions.map((action, index) => (
                    <div className="scenario-row" key={`action-${index}`}>
                      <span>{index + 1}</span>
                      <strong>{action.kind === 'tap' ? '누르기' : '텍스트 입력'}</strong>
                      <input aria-label={`조작 ${index + 1} 식별자`} value={action.identifier} onChange={(event) => updateAction(index, { ...action, identifier: event.target.value })} />
                      {action.kind === 'type-text' && <input aria-label={`조작 ${index + 1} 입력값`} value={action.text} onChange={(event) => updateAction(index, { ...action, text: event.target.value })} />}
                    </div>
                  ))}
                  <p>합격 조건</p>
                  {generated.contract.runtimeScenario.assertions.map((assertion, index) => assertion.kind === 'evidence' ? (
                    <div className="scenario-evidence" key={`assertion-${index}`}><FileJson size={12} /><span>{assertion.name}</span></div>
                  ) : assertion.kind === 'state' ? (
                    <div className="scenario-evidence" key={`assertion-${index}`}><FileJson size={12} /><span>{assertion.name ?? assertion.path.join('.')} · {String(assertion.expected)}</span></div>
                  ) : (
                    <div className="scenario-row assertion" key={`assertion-${index}`}>
                      <Check size={12} />
                      <input aria-label={`합격 조건 ${index + 1} 이름`} value={assertion.name ?? ''} onChange={(event) => updateAssertion(index, { ...assertion, name: event.target.value })} />
                      <input aria-label={`합격 조건 ${index + 1} 식별자`} value={assertion.identifier} onChange={(event) => updateAssertion(index, { ...assertion, identifier: event.target.value })} />
                      {typeof assertion.expected === 'boolean' ? (
                        <select aria-label={`합격 조건 ${index + 1} 예상값`} value={String(assertion.expected)} onChange={(event) => updateAssertion(index, { ...assertion, expected: event.target.value === 'true' })}>
                          <option value="true">참</option><option value="false">거짓</option>
                        </select>
                      ) : (
                        <input aria-label={`합격 조건 ${index + 1} 예상값`} value={assertion.expected} onChange={(event) => updateAssertion(index, { ...assertion, expected: event.target.value })} />
                      )}
                    </div>
                  ))}
                </div> : <div className="scenario-case-list">
                  {generated.contract.environmentRequirements.length > 0 && (
                    <div className="scenario-environment-requirements">
                      <p>필수 실행 환경</p>
                      {generated.contract.environmentRequirements.map((requirement) => (
                        <span className={configuredEnvironmentKeys.has(requirement.key) ? 'ready' : 'missing'} key={requirement.key}>
                          {configuredEnvironmentKeys.has(requirement.key) ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                          {requirement.label} <code>{requirement.key}</code>
                        </span>
                      ))}
                    </div>
                  )}
                  {generated.contract.runtimeScenarios.cases.map((scenario, caseIndex) => (
                    <section className="scenario-case" key={scenario.id}>
                      <header><span>케이스 {caseIndex + 1}</span><strong>{scenario.name}</strong><code>{scenario.id}</code></header>
                      {(scenario.preconditions.permissions?.length ?? 0) > 0 && (
                        <div className="scenario-list">
                          <p>Simulator 준비 조건</p>
                          {scenario.preconditions.permissions!.map((permission, permissionIndex) => (
                            <div className="scenario-row permission" key={`${scenario.id}-permission-${permissionIndex}`}>
                              <span>{permissionIndex + 1}</span>
                              <strong>개인정보 권한</strong>
                              <select value={permission.service} onChange={(event) => updateV2Case(caseIndex, (current) => ({
                                ...current,
                                preconditions: {
                                  ...current.preconditions,
                                  permissions: (current.preconditions.permissions ?? []).map((item, index) => index === permissionIndex ? { ...item, service: event.target.value as RuntimePrivacyPermission['service'] } : item)
                                }
                              }))}>
                                {Object.entries(PRIVACY_SERVICE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                              </select>
                              <select value={permission.state} onChange={(event) => updateV2Case(caseIndex, (current) => ({
                                ...current,
                                preconditions: {
                                  ...current.preconditions,
                                  permissions: (current.preconditions.permissions ?? []).map((item, index) => index === permissionIndex ? { ...item, state: event.target.value as RuntimePrivacyPermission['state'] } : item)
                                }
                              }))}>
                                {Object.entries(PRIVACY_STATE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                              </select>
                            </div>
                          ))}
                        </div>
                      )}
                      {Object.keys(scenario.preconditions.launchVariables ?? {}).length > 0 && (
                        <div className="scenario-environment-requirements">
                          <p>자동 적용할 UI 테스트 fixture</p>
                          {Object.entries(scenario.preconditions.launchVariables ?? {}).map(([name, value]) => (
                            <span className="ready" key={`${scenario.id}-${name}`}>
                              <CheckCircle2 size={12} />
                              <code>{name}</code> = <code>{value || '(빈 값)'}</code>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="scenario-list">
                        {scenario.steps.map((step, stepIndex) => step.kind === 'action' ? (
                          <div className="scenario-row" key={`${scenario.id}-step-${stepIndex}`}>
                            <span>{stepIndex + 1}</span>
                            <strong>{step.action.kind === 'tap' ? '누르기' : '텍스트 입력'}</strong>
                            <input value={step.action.identifier} onChange={(event) => updateV2Case(caseIndex, (current) => ({
                              ...current,
                              steps: current.steps.map((item, index) => index === stepIndex && item.kind === 'action' ? { ...item, action: { ...item.action, identifier: event.target.value } } : item)
                            }))} />
                            {step.action.kind === 'type-text' && <input value={step.action.text} onChange={(event) => updateV2Case(caseIndex, (current) => ({
                              ...current,
                              steps: current.steps.map((item, index) => index === stepIndex && item.kind === 'action' && item.action.kind === 'type-text' ? { ...item, action: { ...item.action, text: event.target.value } } : item)
                            }))} />}
                          </div>
                        ) : (
                          <div className="scenario-checkpoint" key={`${scenario.id}-step-${stepIndex}`}>
                            <p>체크포인트 {stepIndex + 1}</p>
                            {step.assertions.map((assertion, assertionIndex) => assertion.kind === 'evidence' ? (
                              <div className="scenario-evidence" key={assertionIndex}><FileJson size={12} /><span>{assertion.name}</span></div>
                            ) : assertion.kind === 'state' ? (
                              <div className="scenario-evidence" key={assertionIndex}><FileJson size={12} /><span>{assertion.name ?? assertion.path.join('.')} · {String(assertion.expected)}</span></div>
                            ) : (
                              <div className="scenario-row assertion" key={assertionIndex}>
                                <Check size={12} />
                                <input value={assertion.name ?? ''} onChange={(event) => updateV2Case(caseIndex, (current) => ({
                                  ...current,
                                  steps: current.steps.map((item, index) => index === stepIndex && item.kind === 'assert' ? { ...item, assertions: item.assertions.map((value, position) => position === assertionIndex ? { ...value, name: event.target.value } : value) } : item)
                                }))} />
                                <input value={assertion.identifier} onChange={(event) => updateV2Case(caseIndex, (current) => ({
                                  ...current,
                                  steps: current.steps.map((item, index) => index === stepIndex && item.kind === 'assert' ? { ...item, assertions: item.assertions.map((value, position) => position === assertionIndex && value.kind === 'accessibility' ? { ...value, identifier: event.target.value } : value) } : item)
                                }))} />
                                <span>{String(assertion.expected)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                  {missingRuntimeEnvironmentKeys.length > 0 && <p className="scenario-error"><AlertTriangle size={13} />프로젝트 설정에서 값을 등록하세요: {missingRuntimeEnvironmentKeys.join(', ')}</p>}
                </div>}
                <p className="scenario-lock"><ShieldCheck size={12} />등록하면 이 조건이 작업에 고정됩니다. 구현 에이전트는 조건을 낮추거나 바꿀 수 없습니다.</p>
              </div>
            )}
            {generationError && <p className="scenario-error">{generationError}</p>}
          </section>
        )}
        {usesRuntime && runtimeSource === 'project-default' && <p className="scenario-unavailable"><FileJson size={13} />저장소의 `.agentmonitor/project.json`에 고정된 시나리오를 사용합니다.</p>}
        <label><span>최대 구현 시도 횟수</span><input type="number" min={1} max={5} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} /><small>최초 구현을 포함합니다. 테스트·Simulator 검증이나 Reviewer 검토에서 문제가 발견되면 남은 횟수만큼 다시 수정합니다.</small></label>
        <section className="publication-selector">
          <strong>검증이 끝난 변경을 어디에 게시할까요?</strong>
          <label><input type="radio" name="publish-strategy" checked={publishStrategy === 'pull-request'} onChange={() => setPublishStrategy('pull-request')} /><span><b>브랜치를 올리고 PR 만들기</b><small>작업 브랜치를 origin에 올리고 기준 브랜치 대상 PR을 만듭니다. 권장 방식입니다.</small></span></label>
          <label><input type="radio" name="publish-strategy" checked={publishStrategy === 'direct'} onChange={() => setPublishStrategy('direct')} /><span><b>작업 시작 브랜치에 직접 올리기</b><small>작업을 시작한 브랜치에 검증된 commit을 fast-forward push합니다. 강제 push는 하지 않습니다.</small></span></label>
        </section>
        <div className="workflow-preview">
          {useTechSpec && <><span><FileText size={13} />테크스펙 승인</span><i /></>}
          {usesTests && !['existing-tests', 'skip'].includes(testDesign) && <><span><FileText size={13} />테스트 설계</span><i /></>}
          <span><Bot size={13} />구현</span><i />
          {usesTests && <><span><CheckCircle2 size={13} />프로젝트 테스트</span><i /></>}
          {usesRuntime && <><span><SquareTerminal size={13} />Simulator</span><i /></>}
          <span><Search size={13} />Reviewer</span><i /><span><ShieldCheck size={13} />사람 확인</span><i /><span><GitBranch size={13} />{publishStrategy === 'pull-request' ? 'PR' : '원격 게시'}</span>
        </div>
        <button className="primary-button" disabled={submitting || generating || recommending || techSpecLoading || project.isDemo || missingRuntimeEnvironmentKeys.length > 0 || (useTechSpec && !techSpecReady) || (usesRuntime && runtimeSource === 'task-scenario' && !generated)} type="submit">{submitting ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}{project.isDemo ? '실제 프로젝트에서 사용 가능' : '검증 계획 확인하고 작업 등록'}</button>
      </form>
    </Modal>
  )
}

function NoteModal({
  projectId,
  note,
  onClose,
  onSave
}: {
  projectId: string
  note: NoteRecord | null
  onClose: () => void
  onSave: (projectId: string, title: string, body: string) => Promise<void>
}): React.JSX.Element {
  const [title, setTitle] = useState(note?.title ?? '')
  const [body, setBody] = useState(note?.body ?? '')
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onSave(projectId, title, body)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal title={note ? '메모 수정' : '새 메모'} onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <label><span>제목</span><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>내용</span><textarea required rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <button className="primary-button" disabled={submitting} type="submit">
          {submitting ? <LoaderCircle className="spin" size={14} /> : note ? <Pencil size={14} /> : <Plus size={14} />}
          {note ? '수정 저장' : '메모 저장'}
        </button>
      </form>
    </Modal>
  )
}

function SearchModal({
  snapshot,
  onClose,
  onTask,
  onPage
}: {
  snapshot: DashboardSnapshot
  onClose: () => void
  onTask: (task: TaskRecord) => void
  onPage: (page: Page) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const matches = (value: string): boolean => !normalized || value.toLowerCase().includes(normalized)
    return {
      tasks: snapshot.tasks.filter((task) => matches(`${task.title} ${task.prompt} ${task.techSpec?.markdown ?? ''} ${(task.revisionRequests ?? []).map((request) => request.instruction).join(' ')} ${task.status}`)).slice(0, 6),
      notes: snapshot.notes.filter((note) => matches(`${note.title} ${note.body}`)).slice(0, 5),
      events: snapshot.events.filter((event) => matches(`${event.actor} ${event.message} ${event.kind}`)).slice(0, 5)
    }
  }, [query, snapshot.events, snapshot.notes, snapshot.tasks])
  const resultCount = results.tasks.length + results.notes.length + results.events.length
  return (
    <div className="search-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="search-modal">
        <div className="search-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="작업, 메모, 이벤트 검색" /><kbd>ESC</kbd></div>
        <div className="search-results">
          {results.tasks.length > 0 && <><p>작업</p>{results.tasks.map((task) => <button key={task.id} onClick={() => onTask(task)}><ListTodo size={14} /><span><strong>{task.title}</strong><small>{STATUS_LABELS[task.status]} · {timeAgo(task.updatedAt)}</small></span><Command size={12} /></button>)}</>}
          {results.notes.length > 0 && <><p>메모</p>{results.notes.map((note) => <button key={note.id} onClick={() => onPage('notes')}><NotebookPen size={14} /><span><strong>{note.title}</strong><small>{note.body}</small></span><Command size={12} /></button>)}</>}
          {results.events.length > 0 && <><p>이벤트</p>{results.events.map((event) => {
            const Icon = eventIcon(event.kind)
            const task = event.taskId ? snapshot.tasks.find((item) => item.id === event.taskId) : undefined
            return <button key={event.id} onClick={() => task ? onTask(task) : onPage('dashboard')}><Icon size={14} /><span><strong>{event.message}</strong><small>{event.actor} · {timeAgo(event.createdAt)}</small></span><Command size={12} /></button>
          })}</>}
          {resultCount === 0 && <span className="no-result">검색 결과가 없습니다.</span>}
        </div>
      </section>
    </div>
  )
}

function TaskDrawer({
  task,
  events,
  changes,
  runtime,
  evidence,
  onClose,
  onRun,
  onContinue,
  onUpdateRevision,
  onCancelRevision,
  onMoveRevision,
  onSetRevisionQueuePaused,
  onRunNextRevision,
  onRetryVerification,
  onRegenerateRuntimeScenario,
  canLaunchSimulator,
  onLaunchSimulator,
  onAction,
  onOpenPath,
  onOpenXcode,
  onOpenEvidence
}: {
  task: TaskRecord
  events: EventRecord[]
  changes: TaskChanges | null
  runtime: RuntimeSessionRecord | null
  evidence: RuntimeEvidenceRecord[]
  onClose: () => void
  onRun: (task: TaskRecord) => void
  onContinue: (task: TaskRecord, instruction: string) => Promise<void>
  onUpdateRevision: (task: TaskRecord, requestId: string, instruction: string) => Promise<void>
  onCancelRevision: (task: TaskRecord, requestId: string) => Promise<void>
  onMoveRevision: (task: TaskRecord, requestId: string, direction: 'up' | 'down') => Promise<void>
  onSetRevisionQueuePaused: (task: TaskRecord, paused: boolean) => Promise<void>
  onRunNextRevision: (task: TaskRecord) => Promise<void>
  onRetryVerification: (task: TaskRecord) => void
  onRegenerateRuntimeScenario: (task: TaskRecord) => void
  canLaunchSimulator: boolean
  onLaunchSimulator: (task: TaskRecord, destinationId: string) => void
  onAction: (task: TaskRecord, action: 'stop' | 'approve' | 'discard' | 'refresh-publication' | 'switch-to-pr') => void
  onOpenPath: () => void
  onOpenXcode: () => void
  onOpenEvidence: (path: string) => void
}): React.JSX.Element {
  const runtimeReport = buildRuntimeTaskReport(evidence, events)
  const runtimeScenario = task.runtimeContract?.version === 1
    ? normalizeRuntimeScenarioEnvironment(task.runtimeContract.runtimeScenario)
    : null
  const runtimeCaseCount = task.runtimeContract?.version === 2
    ? task.runtimeContract.runtimeScenarios.cases.length
    : task.runtimeContract ? 1 : 0
  const runtimeActionCount = task.runtimeContract?.version === 2
    ? task.runtimeContract.runtimeScenarios.cases.reduce((count, scenario) => count + scenario.steps.filter((step) => step.kind === 'action').length, 0)
    : runtimeScenario?.actions.length ?? 0
  const runtimeAssertionCount = task.runtimeContract?.version === 2
    ? task.runtimeContract.runtimeScenarios.cases.reduce((count, scenario) => count + scenario.steps.reduce((subtotal, step) => subtotal + (step.kind === 'assert' ? step.assertions.length : 0), 0), 0)
    : task.runtimeContract?.runtimeScenario.assertions.length ?? 0
  const awaitingLocalPublicationSync = isAwaitingLocalPublicationSync(task)
  const pendingRevisionRequests = (task.revisionRequests ?? []).filter((request) => !request.appliedAt && !request.cancelledAt)
  const hasPendingRevisionRequest = pendingRevisionRequests.length > 0
  const processingRevisionRequestId = isActiveTask(task)
    ? pendingRevisionRequests.find((request) => request.startedAt)?.id ?? null
    : null
  const queuedRevisionCount = pendingRevisionRequests.filter((request) => request.id !== processingRevisionRequestId).length
  const mutableRevisionRequests = pendingRevisionRequests.filter((request) => request.id !== processingRevisionRequestId)
  const mutableRevisionRequestIds = mutableRevisionRequests.map((request) => request.id)
  const canContinueTask = (isActiveTask(task) || ['awaiting_approval', 'awaiting_manual_validation'].includes(task.status)) &&
    Boolean(task.worktreePath) &&
    !awaitingLocalPublicationSync
  const [revisionInstruction, setRevisionInstruction] = useState('')
  const [revisionSubmitting, setRevisionSubmitting] = useState(false)
  const [editingRevisionId, setEditingRevisionId] = useState<string | null>(null)
  const [editingRevisionInstruction, setEditingRevisionInstruction] = useState('')
  const [revisionActionBusy, setRevisionActionBusy] = useState<string | null>(null)
  const canLaunchTaskApp = canLaunchSimulator && Boolean(task.worktreePath) && !['queued', 'running', 'testing'].includes(task.status)
  const [taskDestinations, setTaskDestinations] = useState<ProjectRunDestination[]>([])
  const [taskDestinationId, setTaskDestinationId] = useState('')
  const [taskDestinationsLoading, setTaskDestinationsLoading] = useState(canLaunchTaskApp)
  const [taskDestinationError, setTaskDestinationError] = useState(false)
  useEffect(() => {
    let active = true
    setTaskDestinations([])
    setTaskDestinationId('')
    setTaskDestinationsLoading(canLaunchTaskApp)
    setTaskDestinationError(false)
    if (canLaunchTaskApp) {
      void bridge.listProjectRunDestinations(task.projectId)
        .then((destinations) => {
          if (!active) return
          setTaskDestinations(destinations)
          setTaskDestinationId(initialRunDestination(destinations))
        })
        .catch(() => {
          if (active) setTaskDestinationError(true)
        })
        .finally(() => {
          if (active) setTaskDestinationsLoading(false)
        })
    }
    return () => {
      active = false
    }
  }, [canLaunchTaskApp, task.id, task.projectId])
  useEffect(() => {
    setEditingRevisionId(null)
    setEditingRevisionInstruction('')
    setRevisionActionBusy(null)
  }, [task.id])
  const refreshTaskDestinations = async (): Promise<void> => {
    setTaskDestinationsLoading(true)
    setTaskDestinationError(false)
    try {
      const destinations = await bridge.listProjectRunDestinations(task.projectId, true)
      setTaskDestinations(destinations)
      setTaskDestinationId((current) => initialRunDestination(destinations, current))
    } catch {
      setTaskDestinationError(true)
    } finally {
      setTaskDestinationsLoading(false)
    }
  }
  const runtimeReportOutcome = runtimeReport?.recovered
    ? '복구 후 통과'
    : runtimeReport
      ? RUNTIME_REPORT_OUTCOME_LABELS[runtimeReport.latestOutcome]
      : null
  const submitRevisionRequest = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const instruction = revisionInstruction.trim()
    if (instruction.length < 5 || revisionSubmitting) return
    setRevisionSubmitting(true)
    try {
      await onContinue(task, instruction)
      setRevisionInstruction('')
    } catch {
      // 상위 컴포넌트가 사용자에게 오류를 표시하며 입력은 재시도를 위해 유지합니다.
    } finally {
      setRevisionSubmitting(false)
    }
  }
  const updateRevisionRequest = async (requestId: string): Promise<void> => {
    const instruction = editingRevisionInstruction.trim()
    if (instruction.length < 5 || revisionActionBusy) return
    setRevisionActionBusy(`update:${requestId}`)
    try {
      await onUpdateRevision(task, requestId, instruction)
      setEditingRevisionId(null)
      setEditingRevisionInstruction('')
    } finally {
      setRevisionActionBusy(null)
    }
  }
  const cancelRevisionRequest = async (requestId: string, instruction: string): Promise<void> => {
    if (revisionActionBusy || !window.confirm(`다음 추가 수정 요청을 취소할까요?\n\n${instruction}`)) return
    setRevisionActionBusy(`cancel:${requestId}`)
    try {
      await onCancelRevision(task, requestId)
      if (editingRevisionId === requestId) {
        setEditingRevisionId(null)
        setEditingRevisionInstruction('')
      }
    } finally {
      setRevisionActionBusy(null)
    }
  }
  const moveRevisionRequest = async (requestId: string, direction: 'up' | 'down'): Promise<void> => {
    if (revisionActionBusy) return
    setRevisionActionBusy(`move:${requestId}`)
    try {
      await onMoveRevision(task, requestId, direction)
    } finally {
      setRevisionActionBusy(null)
    }
  }
  const setRevisionQueuePaused = async (paused: boolean): Promise<void> => {
    if (revisionActionBusy) return
    setRevisionActionBusy('pause')
    try {
      await onSetRevisionQueuePaused(task, paused)
    } finally {
      setRevisionActionBusy(null)
    }
  }
  const runNextRevisionRequest = async (): Promise<void> => {
    if (revisionActionBusy) return
    setRevisionActionBusy('run-next')
    try {
      await onRunNextRevision(task)
    } finally {
      setRevisionActionBusy(null)
    }
  }
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <aside className="task-drawer">
        <header><div><span className={`status-pill ${statusTone(task.status)}`}>{STATUS_LABELS[task.status]}</span><h2>{task.title}</h2><p>WORK-{task.id.slice(0, 8).toUpperCase()} · codex</p></div><button aria-label="닫기" onClick={onClose}><X size={16} /></button></header>
        <div className="task-drawer-scroll">
        <section className="task-contract"><strong>작업 계약</strong><p>{task.prompt}</p><div><span><Clock3 size={12} />최대 구현 {task.maxAttempts}회</span><span><GitBranch size={12} />{task.branchName ?? '실행 전'}</span></div></section>
        <section className="task-model-plan">
          <div className="drawer-section-title"><strong>AI 모델</strong><span>{task.modelPlan ? '등록 시 고정됨' : 'Codex 추천 기본값'}</span></div>
          {task.modelPlan ? (
            <>
            <div className={`task-model-execution ${codexExecutionMode(task.modelPlan)}`}>
              <Bot size={14} />
              <div>
                <strong>{codexExecutionMode(task.modelPlan) === 'root-subagents' ? '루트 + 서브에이전트' : '역할별 독립 실행'}</strong>
                <small>{codexExecutionMode(task.modelPlan) === 'root-subagents'
                  ? `${task.modelPlan.roles.planning.model} 루트가 각 역할을 한 명씩 위임합니다.`
                  : '각 역할 모델이 해당 단계를 직접 실행합니다.'}</small>
              </div>
            </div>
            <div className="task-model-plan-grid">
              {CODEX_MODEL_ROLES.map((role) => (
                <div key={role}><span>{codexExecutionMode(task.modelPlan) === 'root-subagents' && role === 'planning' ? 'Root · 계획·조정' : CODEX_MODEL_ROLE_LABELS[role]}</span><code>{task.modelPlan!.roles[role].model}</code><small>{task.modelPlan!.roles[role].reasoningEffort}</small></div>
              ))}
            </div>
            </>
          ) : <p>이 작업은 모델 고정 기능이 추가되기 전에 만들어져 실행 시점의 Codex 추천 모델을 사용합니다.</p>}
        </section>
        {(canContinueTask || (task.revisionRequests?.length ?? 0) > 0) && (
          <section className="task-revision-request">
            <div className="drawer-section-title">
              <strong>추가 수정 큐</strong>
              <span>
                {task.revisionQueuePaused && hasPendingRevisionRequest ? '자동 실행 일시정지 · ' : ''}
                {processingRevisionRequestId ? '반영 중 1 · ' : ''}
                {queuedRevisionCount > 0 ? `대기 ${queuedRevisionCount}` : processingRevisionRequestId ? '다음 요청 없음' : '같은 작업에서 계속'}
              </span>
            </div>
            <p>{isActiveTask(task)
              ? '현재 단계는 그대로 실행합니다. 지금 추가한 요청은 큐에서 기다렸다가 같은 worktree와 브랜치의 다음 실행에서 순서대로 반영합니다.'
              : canContinueTask
                ? '실행 결과에서 새 문제를 발견했다면 현재 worktree와 브랜치를 유지한 채 수정·검증을 다시 진행할 수 있습니다.'
                : hasPendingRevisionRequest
                  ? '실행이 멈춰 미완료 요청을 보존했습니다. 환경이나 실패 원인을 해결한 뒤 실행하면 선두 요청부터 이어갑니다.'
                  : '이 작업에서 반영하고 검증한 추가 수정 내역입니다.'}</p>
            {hasPendingRevisionRequest && (
              <div className="revision-queue-toolbar">
                {task.revisionQueuePaused ? (
                  <>
                    {!isActiveTask(task) && (
                      <button className="secondary-button" disabled={Boolean(revisionActionBusy)} onClick={() => void runNextRevisionRequest()}>
                        <StepForward size={12} />다음 요청 하나 실행
                      </button>
                    )}
                    <button className="secondary-button" disabled={Boolean(revisionActionBusy)} onClick={() => void setRevisionQueuePaused(false)}>
                      <Play size={12} />자동 실행 재개
                    </button>
                  </>
                ) : (
                  <button className="secondary-button" disabled={Boolean(revisionActionBusy)} onClick={() => void setRevisionQueuePaused(true)}>
                    <Pause size={12} />{isActiveTask(task) ? '현재 요청 후 일시정지' : '자동 실행 일시정지'}
                  </button>
                )}
              </div>
            )}
            {(task.revisionRequests?.length ?? 0) > 0 && (
              <details>
                <summary>추가 수정 내역 {task.revisionRequests!.length}개</summary>
                <ol>
                  {task.revisionRequests!.map((request, index) => {
                    const isProcessing = request.id === processingRevisionRequestId
                    const isMutable = !request.appliedAt && !request.cancelledAt && !isProcessing
                    const mutableIndex = mutableRevisionRequestIds.indexOf(request.id)
                    const elapsed = request.appliedAt ? shortElapsed(request.startedAt, request.appliedAt) : null
                    return (
                      <li className={request.cancelledAt ? 'is-cancelled' : ''} key={request.id}>
                        {editingRevisionId === request.id ? (
                          <div className="revision-request-editor">
                            <textarea
                              aria-label={`추가 수정 요청 ${index + 1} 내용`}
                              maxLength={5_000}
                              rows={3}
                              value={editingRevisionInstruction}
                              onChange={(event) => setEditingRevisionInstruction(event.target.value)}
                            />
                            <div>
                              <button aria-label={`추가 수정 요청 ${index + 1} 수정 취소`} className="icon-button" onClick={() => setEditingRevisionId(null)}><X size={11} /></button>
                              <button aria-label={`추가 수정 요청 ${index + 1} 저장`} className="icon-button" disabled={editingRevisionInstruction.trim().length < 5 || Boolean(revisionActionBusy)} onClick={() => void updateRevisionRequest(request.id)}><Check size={11} /></button>
                            </div>
                          </div>
                        ) : (
                          <div className="revision-request-row">
                            <span>{request.instruction}</span>
                            {isMutable && (
                              <div className="revision-request-actions">
                                <button aria-label={`추가 수정 요청 ${index + 1} 위로 이동`} className="icon-button" disabled={mutableIndex <= 0 || Boolean(revisionActionBusy)} onClick={() => void moveRevisionRequest(request.id, 'up')}><ArrowUp size={11} /></button>
                                <button aria-label={`추가 수정 요청 ${index + 1} 아래로 이동`} className="icon-button" disabled={mutableIndex < 0 || mutableIndex >= mutableRevisionRequestIds.length - 1 || Boolean(revisionActionBusy)} onClick={() => void moveRevisionRequest(request.id, 'down')}><ArrowDown size={11} /></button>
                                <button aria-label={`추가 수정 요청 ${index + 1} 수정`} className="icon-button" disabled={Boolean(revisionActionBusy)} onClick={() => {
                                  setEditingRevisionId(request.id)
                                  setEditingRevisionInstruction(request.instruction)
                                }}><Pencil size={11} /></button>
                                <button aria-label={`추가 수정 요청 ${index + 1} 취소`} className="icon-button danger" disabled={Boolean(revisionActionBusy)} onClick={() => void cancelRevisionRequest(request.id, request.instruction)}><Trash2 size={11} /></button>
                              </div>
                            )}
                          </div>
                        )}
                        <time className={isProcessing ? 'is-processing' : !request.appliedAt && !request.cancelledAt ? 'is-queued' : ''}>
                          {request.cancelledAt
                            ? `${timeAgo(request.cancelledAt)} 취소됨`
                            : request.appliedAt
                              ? `${timeAgo(request.appliedAt)} 검증 완료${elapsed ? ` · ${elapsed}` : ''}`
                              : isProcessing
                                ? '현재 반영 중'
                                : request.lastFailureAt
                                  ? '실패 후 재개 대기'
                                  : request.startedAt
                                    ? '재개 대기'
                                    : '큐 대기'}
                        </time>
                        {(request.resultSummary || request.lastFailureMessage) && (
                          <small className={request.lastFailureMessage ? 'revision-request-failure' : 'revision-request-result'}>
                            {request.lastFailureMessage ?? request.resultSummary}
                          </small>
                        )}
                      </li>
                    )
                  })}
                </ol>
              </details>
            )}
            {canContinueTask && <form onSubmit={(event) => void submitRevisionRequest(event)}>
              <label htmlFor={`task-revision-${task.id}`}>추가로 수정할 내용</label>
              <textarea
                id={`task-revision-${task.id}`}
                maxLength={5_000}
                placeholder="예: 메인 스레드 경고가 발생합니다. 원인을 수정하고 기존 검증을 다시 실행해 주세요."
                rows={4}
                value={revisionInstruction}
                onChange={(event) => setRevisionInstruction(event.target.value)}
              />
              <div>
                <small>{isActiveTask(task)
                  ? '현재 실행 다음에 시작 · 입력 순서 유지 · 실패 시 큐 보존'
                  : '같은 브랜치 · 구현 · 기존 검증 · Reviewer · 다시 승인 대기'}</small>
                <button className="primary-button" disabled={revisionInstruction.trim().length < 5 || revisionSubmitting} type="submit">
                  {revisionSubmitting ? <LoaderCircle className="spin" size={13} /> : <MessageSquare size={13} />}
                  {revisionSubmitting ? '요청 등록 중' : isActiveTask(task) ? '큐에 추가' : '요청하고 작업 이어가기'}
                </button>
              </div>
            </form>}
          </section>
        )}
        {task.techSpec && (
          <section className="approved-tech-spec">
            <div className="drawer-section-title"><strong>승인된 테크스펙</strong><span>revision {task.techSpec.revision}</span></div>
            <p>{task.techSpec.summary}</p>
            <details>
              <summary>전체 테크스펙 보기</summary>
              <pre>{task.techSpec.markdown}</pre>
            </details>
            <small><ShieldCheck size={11} />{timeAgo(task.techSpec.approvedAt)} 승인 · 구현과 검토의 추가 계약</small>
          </section>
        )}
        {task.verificationPlan && (
          <section className="verification-report">
            <div className="drawer-section-title"><strong>작업별 검증 계획</strong><span>등록 시 고정됨</span></div>
            <p className="verification-report-plan">
              <strong>{VERIFICATION_MODE_LABELS[task.verificationPlan.mode]}</strong>
              {task.verificationPlan.mode === 'project-tests' || task.verificationPlan.mode === 'both'
                ? ` · ${TEST_DESIGN_LABELS[task.verificationPlan.testDesign]}`
                : ''}
              {task.verificationPlan.mode === 'simulator-runtime' || task.verificationPlan.mode === 'both'
                ? ` · ${RUNTIME_SOURCE_LABELS[task.verificationPlan.runtimeSource]}`
                : ''}
            </p>
            {task.verificationResult && (
              <div className="verification-steps">
                {([
                  ['환경 준비', task.verificationResult.environmentSetup],
                  ['테스트 설계', task.verificationResult.testDesign],
                  ['프로젝트 테스트', task.verificationResult.projectTests],
                  ['Simulator', task.verificationResult.simulatorRuntime],
                  ['Reviewer', task.verificationResult.reviewer]
                ] as const).map(([label, result]) => (
                  <div className={`verification-step step-${result.status}`} key={label}>
                    <span>{result.status === 'passed' ? <CheckCircle2 size={13} /> : result.status === 'failed' ? <AlertTriangle size={13} /> : result.status === 'running' ? <LoaderCircle className="spin" size={13} /> : <Circle size={13} />}</span>
                    <div><strong>{label}</strong><small>{result.message}</small></div>
                    <em>{VERIFICATION_STEP_STATUS_LABELS[result.status]}</em>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {task.runtimeContract && (
          <section className="approved-scenario">
            <div className="drawer-section-title"><strong>승인된 Simulator 검증</strong><span>조건 고정됨</span></div>
            <p>{task.runtimeScenarioSummary ?? '사용자가 승인한 작업별 검증 시나리오'}</p>
            <div>
              {runtimeCaseCount > 1 && <span><ListTodo size={12} />케이스 {runtimeCaseCount}개</span>}
              {(runtimeScenario?.permissions.length ?? 0) > 0 && <span><ShieldCheck size={12} />권한 {runtimeScenario!.permissions.length}개</span>}
              <span><Play size={12} />조작 {runtimeActionCount}단계</span>
              <span><CheckCircle2 size={12} />검증 {runtimeAssertionCount}개</span>
              <span><SquareTerminal size={12} />{task.runtimeContract.adapter.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'}</span>
            </div>
            <small>
              <ShieldCheck size={11} />
              {task.runtimeScenarioApprovedAt ? `${timeAgo(task.runtimeScenarioApprovedAt)} 승인` : '등록 시 승인'} · 에이전트가 변경할 수 없는 스냅샷
              {(runtimeScenario?.migratedSystemActionIdentifiers.length ?? 0) > 0
                ? ` · 시스템 권한 조작 ${runtimeScenario!.migratedSystemActionIdentifiers.length}개를 실행 환경 준비로 자동 변환`
                : ''}
            </small>
          </section>
        )}
        {task.publication && (
          <section className="task-publication">
            <div className="drawer-section-title"><strong>원격 게시</strong><span>{task.publication.strategy === 'pull-request' ? 'PR 방식' : '직접 게시'}</span></div>
            <p>{task.publication.message ?? '게시를 기다리고 있습니다.'}</p>
            <div><code>{task.publication.remoteName ?? 'origin'}/{task.publication.baseBranch ?? task.sourceBranch ?? '기준 브랜치'}</code>{task.publication.publishedCommit && <code>{task.publication.publishedCommit.slice(0, 8)}</code>}</div>
            {task.publication.pullRequestUrl && <button className="secondary-button" onClick={() => void bridge.openExternalUrl(task.publication!.pullRequestUrl!)}><GitBranch size={13} />GitHub PR 열기</button>}
          </section>
        )}
        {runtime && (
          <section className={`runtime-session runtime-${runtime.status}`}>
            <div className="drawer-section-title">
              <strong>Swift runtime</strong>
              <span>{RUNTIME_SESSION_STATUS_LABELS[runtime.status]}</span>
            </div>
            <div className="runtime-session-target">
              <SquareTerminal size={15} />
              <div>
                <strong>{runtime.deviceName ?? 'iOS Simulator 확인 중'}</strong>
                <small>{runtime.bundleIdentifier ?? '앱 산출물 확인 전'}</small>
              </div>
              {runtime.processId && <code>PID {runtime.processId}</code>}
            </div>
            <p>{runtime.message}</p>
            {runtimeReport && (
              <div className="runtime-report">
                <div className="runtime-report-heading">
                  <div>
                    <strong>실행 보고서</strong>
                    <small>판정 통과 {runtimeReport.passedCount} · 실패 {runtimeReport.failedCount}</small>
                  </div>
                  <span className={`runtime-report-outcome outcome-${runtimeReport.latestOutcome}`}>
                    {runtimeReportOutcome}
                  </span>
                </div>
                <div className="runtime-report-stats">
                  <span><strong>{runtimeReport.runCount}</strong>실행</span>
                  <span><strong>{runtimeReport.attempts.length}</strong>시도</span>
                  <span><strong>{runtimeReport.repairCount}</strong>복구</span>
                  <span><strong>{runtimeReport.evidenceCount}</strong>증거</span>
                </div>
                <div className="runtime-report-attempts">
                  {runtimeReport.attempts.map((attempt, index) => (
                    <details
                      className={`runtime-report-attempt outcome-${attempt.outcome}`}
                      open={index === 0 || undefined}
                      key={`${attempt.runId}-${attempt.attempt}`}
                    >
                      <summary>
                        <span>
                          <strong>실행 {attempt.executionNumber} · 시도 {attempt.attempt}</strong>
                          <small>{timeAgo(attempt.createdAt)} · 증거 {attempt.evidence.length}개</small>
                        </span>
                        <em>
                          {attempt.repaired
                            ? '실패 · 복구됨'
                            : RUNTIME_REPORT_OUTCOME_LABELS[attempt.outcome]}
                        </em>
                        <ChevronDown size={13} />
                      </summary>
                      {attempt.summary && <p>{attempt.summary}</p>}
                      <div className="runtime-evidence-list">
                        {attempt.evidence.map((item) => {
                          const isJsonEvidence = item.kind !== 'screen'
                          const EvidenceIcon = isJsonEvidence ? FileJson : ImageIcon
                          return (
                            <button key={item.id} onClick={() => onOpenEvidence(item.path)}>
                              <EvidenceIcon size={14} />
                              <span>
                                <strong>{RUNTIME_EVIDENCE_LABELS[item.kind]}</strong>
                                <small>
                                  {item.summary ? `${item.summary} · ` : ''}
                                  {isJsonEvidence ? 'JSON' : 'PNG'} · {formatBytes(item.sizeBytes)}
                                </small>
                              </span>
                              <span className="runtime-evidence-action"><FolderOpen size={12} />열기</span>
                            </button>
                          )
                        })}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
            <small>작업별 격리 build · {timeAgo(runtime.updatedAt)}</small>
          </section>
        )}
        {task.worktreePath && (
          <section className="task-changes">
            <div className="drawer-section-title"><strong>변경 내역</strong><span>{changes ? `${changes.files.length}개 파일` : '불러오는 중'}</span></div>
            {!changes && <p className="empty-copy"><LoaderCircle className="spin" size={12} /> Git diff를 확인하고 있습니다.</p>}
            {changes && !changes.available && <p className="empty-copy">변경 내역을 읽을 수 없습니다.</p>}
            {changes?.available && changes.files.length === 0 && <p className="empty-copy">아직 변경된 파일이 없습니다.</p>}
            {changes?.files.map((file) => (
              <div className="change-file" key={file.path}>
                <span>{file.status}</span>
                <code>{file.path}</code>
                <small className="additions">+{file.additions ?? '—'}</small>
                <small className="deletions">−{file.deletions ?? '—'}</small>
              </div>
            ))}
            {changes?.stat && <p className="change-stat"><GitCompareArrows size={12} />{changes.stat}</p>}
            {changes?.patch && <details className="diff-details"><summary>패치 미리보기{changes.truncated ? ' · 일부만 표시' : ''}</summary><pre>{changes.patch}</pre></details>}
          </section>
        )}
        <section className="drawer-events"><div className="drawer-section-title"><strong>실시간 로그</strong><span>{events.length}개</span></div>{events.length === 0 && <p className="empty-copy">아직 실행 로그가 없습니다.</p>}{events.map((event) => { const Icon = eventIcon(event.kind); return <div key={event.id}><span><Icon size={12} /></span><p><strong>{event.actor}</strong>{event.message}</p><time>{timeAgo(event.createdAt)}</time></div> })}</section>
        {['awaiting_approval', 'awaiting_manual_validation'].includes(task.status) && (
          <div className={`approval-notice${task.status === 'awaiting_manual_validation' ? ' manual' : ''}${hasPendingRevisionRequest ? ' revision-pending' : ''}`}>
            {hasPendingRevisionRequest ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
            <p>
              <strong>{hasPendingRevisionRequest
                ? `추가 수정 요청 ${pendingRevisionRequests.length}개가 남았습니다`
                : task.status === 'awaiting_manual_validation'
                  ? '사람의 직접 검증이 필요합니다'
                  : '안전한 원격 게시'}</strong>
              {hasPendingRevisionRequest
                ? '대기 요청을 실행하거나 취소한 뒤 게시할 수 있습니다. 위의 추가 수정 큐에서 순서와 자동 실행 상태를 확인하세요.'
                : task.status === 'awaiting_manual_validation'
                  ? '자동 통과로 판정하지 않았습니다. 변경을 직접 확인한 뒤 게시하거나 폐기하세요.'
                  : '원격 최신 상태를 반영하고 fast-forward 가능한 경우에만 게시합니다.'}
            </p>
          </div>
        )}
        {task.status === 'blocked_environment' && (
          <div className="approval-notice environment-blocked">
            <AlertTriangle size={14} />
            <p><strong>코드 문제가 아니라 검증 환경을 먼저 준비해야 합니다</strong>현재 변경과 작업공간은 그대로 보관했습니다. 프로젝트 설정의 환경 준비 명령을 확인한 뒤 구현을 다시 시키지 않고 검증만 재실행할 수 있습니다.</p>
          </div>
        )}
        {task.status === 'blocked_agent' && (
          <div className="approval-notice environment-blocked">
            <AlertTriangle size={14} />
            <p><strong>Codex를 다시 사용할 수 있을 때 이어서 실행하세요</strong>제품 코드 실패가 아니라 AI 제공자 요청이 중단된 상태입니다. 현재 변경과 작업공간은 보존했으며, 실행을 누르면 Implementer 단계부터 다시 이어갑니다.</p>
          </div>
        )}
        {task.status === 'failed' && task.verificationResult?.reviewer.status === 'failed' && (
          <div className="approval-notice environment-blocked">
            <AlertTriangle size={14} />
            <p><strong>Reviewer 지적을 다음 구현에 반영할 수 있습니다</strong>실행을 누르면 기존 작업공간을 유지한 채 미해결 지적을 Implementer에 전달하고 테스트부터 Reviewer까지 다시 진행합니다.</p>
          </div>
        )}
        {task.runtimeContract && ['failed', 'stopped', 'blocked_environment'].includes(task.status) && (
          <div className="approval-notice environment-blocked">
            <AlertTriangle size={14} />
            <p><strong>{task.runtimeContract.version === 1 ? '이전 Simulator 시나리오를 최신화할 수 있습니다' : '검증 시나리오를 다시 만들 수 있습니다'}</strong>실행할 수 없는 환경값이나 순간적인 상태로 막힌 경우, 현재 코드와 IDE에 등록된 환경을 기준으로 재생성합니다.</p>
          </div>
        )}
        </div>
        <footer>
          {canLaunchTaskApp && (
            <div className="task-device-launch">
              <select
                aria-label="작업 브랜치 앱 실행 기기"
                disabled={taskDestinationsLoading}
                value={taskDestinationId}
                onChange={(event) => setTaskDestinationId(event.target.value)}
              >
                {taskDestinations.length === 0 && <option value="">{taskDestinationsLoading ? '기기 찾는 중' : taskDestinationError ? '기기 조회 실패' : '사용 가능한 기기 없음'}</option>}
                {taskDestinations.map((destination) => (
                  <option disabled={!destination.available} key={destination.id} value={destination.id}>
                    {destination.name} · {destination.kind === 'simulator' ? 'Simulator' : '실기기'} · {destination.statusLabel}
                  </option>
                ))}
              </select>
              <button
                aria-label="작업 실행 기기 새로고침"
                className="icon-button"
                disabled={taskDestinationsLoading}
                onClick={() => void refreshTaskDestinations()}
              >
                {taskDestinationsLoading ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
              </button>
              <button className="secondary-button" disabled={!taskDestinationId || taskDestinationsLoading} onClick={() => onLaunchSimulator(task, taskDestinationId)}><SquareTerminal size={14} />작업본 실행</button>
            </div>
          )}
          {task.worktreePath && <button className="secondary-button" onClick={onOpenPath}><FolderOpen size={14} />작업공간 열기</button>}
          {canLaunchSimulator && task.worktreePath && <button className="secondary-button" onClick={onOpenXcode}><SquareTerminal size={14} />Xcode로 열기</button>}
          {task.runtimeContract && ['failed', 'stopped', 'blocked_environment'].includes(task.status) && <button className="secondary-button" onClick={() => onRegenerateRuntimeScenario(task)}><RotateCcw size={14} />검증 시나리오 다시 만들기</button>}
          {(['queued', 'failed', 'stopped', 'blocked_agent'].includes(task.status) || (task.status === 'blocked_environment' && hasPendingRevisionRequest)) && <button className="primary-button" onClick={() => onRun(task)}><Play size={14} />{task.status === 'blocked_environment' && hasPendingRevisionRequest ? '환경 준비 후 수정 계속' : task.status === 'failed' && task.verificationResult?.reviewer.status === 'failed' ? '지적 반영하고 실행' : '실행'}</button>}
          {task.worktreePath && ['blocked_environment', 'failed', 'stopped'].includes(task.status) && task.verificationResult?.reviewer.status !== 'failed' && !hasPendingRevisionRequest && <button className="primary-button" onClick={() => onRetryVerification(task)}><ShieldCheck size={14} />{task.status === 'blocked_environment' ? '환경 준비 후 다시 검증' : '구현 없이 다시 검증'}</button>}
          {['failed', 'stopped', 'blocked_environment', 'blocked_agent'].includes(task.status) && <button className="danger-button" onClick={() => onAction(task, 'discard')}><Trash2 size={14} />폐기</button>}
          {isActiveTask(task) && <button className="danger-button" onClick={() => onAction(task, 'stop')}><Octagon size={14} />중단</button>}
          {['awaiting_approval', 'awaiting_manual_validation'].includes(task.status) && !awaitingLocalPublicationSync && <><button className="danger-button" onClick={() => onAction(task, 'discard')}><Trash2 size={14} />폐기</button>{!hasPendingRevisionRequest && <button className="primary-button" onClick={() => onAction(task, 'approve')}><GitBranch size={14} />{(task.publishStrategy ?? 'pull-request') === 'pull-request' ? '브랜치 올리고 PR 만들기' : directPublishLabel(task)}</button>}</>}
          {['awaiting_approval', 'awaiting_manual_validation'].includes(task.status) && task.publishStrategy === 'direct' && task.publication?.status === 'failed' && <button className="secondary-button" onClick={() => onAction(task, 'switch-to-pr')}><GitBranch size={14} />PR 방식으로 전환</button>}
          {task.status === 'awaiting_merge' && !awaitingLocalPublicationSync && <button className="primary-button" onClick={() => onAction(task, 'refresh-publication')}><GitCompareArrows size={14} />PR 상태 확인</button>}
          {awaitingLocalPublicationSync && <button className="primary-button" onClick={() => onAction(task, 'refresh-publication')}><GitCompareArrows size={14} />로컬 동기화 다시 시도</button>}
        </footer>
      </aside>
    </div>
  )
}
