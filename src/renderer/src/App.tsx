import {
  Activity,
  AlertTriangle,
  Bot,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Command,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  LayoutDashboard,
  ListTodo,
  LogIn,
  LogOut,
  LoaderCircle,
  MessageSquare,
  NotebookPen,
  Octagon,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  SquareTerminal,
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
import { buildDailySeries, buildHourlyActivity, isActiveTask } from '../../shared/domain'
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
import { demoBridge } from './demo'

type Page = 'dashboard' | 'tasks' | 'findings' | 'notes' | 'projects'
type Range = 7 | 30 | 'all'

const electronBridgeUnavailable = !window.agentMonitoring && navigator.userAgent.toLowerCase().includes('electron')
const bridge: AgentMonitoringBridge = window.agentMonitoring ?? demoBridge

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '대기',
  running: '구현 중',
  testing: '테스트 중',
  awaiting_approval: '승인 대기',
  completed: '완료',
  failed: '실패',
  stopped: '중단',
  discarded: '폐기'
}

const NAV_ITEMS: Array<{ page: Page; label: string; icon: typeof LayoutDashboard }> = [
  { page: 'dashboard', label: '대시보드', icon: LayoutDashboard },
  { page: 'tasks', label: '작업', icon: ListTodo },
  { page: 'findings', label: '버그', icon: Bug },
  { page: 'notes', label: '메모', icon: NotebookPen }
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

function duration(task: TaskRecord): string {
  const minutes = Math.max(1, Math.round((new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}분`
  const hours = Math.floor(minutes / 60)
  return `${hours}시간 ${minutes % 60}분`
}

function eventIcon(kind: EventKind): typeof Activity {
  if (kind.includes('finding')) return Bug
  if (kind.includes('note')) return NotebookPen
  if (kind.includes('test')) return kind === 'test_failed' ? AlertTriangle : CheckCircle2
  if (kind.includes('completed')) return CheckCircle2
  if (kind.includes('started')) return Play
  return Bot
}

function statusTone(status: TaskStatus): string {
  if (status === 'completed') return 'green'
  if (status === 'failed') return 'red'
  if (status === 'awaiting_approval') return 'violet'
  if (status === 'running' || status === 'testing') return 'blue'
  if (status === 'stopped' || status === 'discarded') return 'muted'
  return 'amber'
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const selectedProjectRef = useRef<string | undefined>(undefined)
  const [page, setPage] = useState<Page>('dashboard')
  const [range, setRange] = useState<Range>('all')
  const [taskModal, setTaskModal] = useState(false)
  const [noteModal, setNoteModal] = useState(false)
  const [searchModal, setSearchModal] = useState(false)
  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (projectId?: string) => {
    try {
      const next = await bridge.getSnapshot(projectId)
      setSnapshot(next)
      setSelectedProjectId(next.selectedProject?.id)
      selectedProjectRef.current = next.selectedProject?.id
      setSelectedTask((current) => (current ? next.tasks.find((task) => task.id === current.id) ?? null : null))
    } catch (loadError) {
      setError(String(loadError))
    }
  }, [])

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
        setTaskModal(false)
        setNoteModal(false)
        setSelectedTask(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const selectProject = async (projectId: string): Promise<void> => {
    setSelectedProjectId(projectId)
    selectedProjectRef.current = projectId
    await load(projectId)
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
    setSelectedTask(task)
    void bridge.runTask(task.id).catch((runError) => setError(String(runError)))
    void load(task.projectId)
  }

  const taskAction = async (task: TaskRecord, action: 'stop' | 'approve' | 'discard'): Promise<void> => {
    try {
      if (action === 'discard' && !window.confirm('격리 작업공간과 변경을 폐기할까요?')) return
      if (action === 'stop') await bridge.stopTask(task.id)
      if (action === 'approve') await bridge.approveTask(task.id)
      if (action === 'discard') await bridge.discardTask(task.id)
      await load(task.projectId)
    } catch (actionError) {
      setError(String(actionError))
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

  if (electronBridgeUnavailable) {
    return <RuntimeErrorScreen />
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
  const awaitingTask = snapshot.tasks.find((task) => task.status === 'awaiting_approval') ?? null
  const selectedProject = snapshot.selectedProject

  return (
    <div className="app-shell">
      <Sidebar
        snapshot={snapshot}
        selectedProjectId={selectedProjectId ?? selectedProject?.id}
        page={page}
        busy={busy}
        onPage={setPage}
        onProject={selectProject}
        onAddProject={addProject}
        onSearch={() => setSearchModal(true)}
      />

      <main className="main-content">
        <header className="workspace-header">
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

        {!selectedProject && (
          <EmptyWorkspace busy={busy} onAddProject={addProject} />
        )}
        {selectedProject && page === 'dashboard' && (
          <DashboardPage
            snapshot={snapshot}
            activeTask={activeTask}
            awaitingTask={awaitingTask}
            unresolvedCount={unresolved.length}
            range={range}
            onRange={setRange}
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
        {selectedProject && page === 'findings' && <FindingsPage findings={snapshot.findings} />}
        {selectedProject && page === 'notes' && <NotesPage notes={snapshot.notes} onNew={() => setNoteModal(true)} />}
        {selectedProject && page === 'projects' && (
          <ProjectsPage project={selectedProject} onSave={async (project) => {
            await bridge.updateProject(project)
            await load(project.projectId)
          }} onOpen={() => void bridge.openPath(selectedProject.path)} />
        )}
      </main>

      {selectedProject && taskModal && (
        <TaskModal
          project={selectedProject}
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
          onClose={() => setNoteModal(false)}
          onCreate={async (projectId, title, body) => {
            await bridge.addNote(projectId, title, body)
            setNoteModal(false)
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
        />
      )}
      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          events={snapshot.events.filter((event) => event.taskId === selectedTask.id)}
          onClose={() => setSelectedTask(null)}
          onRun={runTask}
          onAction={taskAction}
          onOpenPath={() => selectedTask.worktreePath && void bridge.openPath(selectedTask.worktreePath)}
        />
      )}
      {error && (
        <div className="error-toast" role="alert">
          <AlertTriangle size={16} />
          <span>{error.replace(/^Error:\s*/, '')}</span>
          <button aria-label="오류 닫기" onClick={() => setError(null)}><X size={15} /></button>
        </div>
      )}
    </div>
  )
}

function RuntimeErrorScreen(): React.JSX.Element {
  return (
    <main className="auth-shell">
      <div className="auth-titlebar">
        <div className="brand-mark"><Activity size={14} /></div>
        <span>AgentMonitoring</span>
      </div>
      <section className="auth-card" role="alert">
        <div className="auth-icon error"><Octagon size={25} /></div>
        <p className="eyebrow">RUNTIME CONNECTION</p>
        <h1>앱 연결을 불러오지 못했습니다</h1>
        <p className="auth-description">
          Electron preload가 연결되지 않아 실제 프로젝트와 로컬 데이터에 접근할 수 없습니다.
          안전을 위해 데모 화면으로 전환하지 않았습니다.
        </p>
        <button className="auth-primary" onClick={() => window.location.reload()}>
          다시 불러오기
        </button>
        <p className="auth-footnote">문제가 계속되면 터미널에서 앱을 종료한 뒤 `pnpm dev`로 다시 실행하세요.</p>
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
            <strong>검증 명령 설정</strong>
            <p>프로젝트 테스트 명령을 등록합니다.</p>
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
  busy,
  onPage,
  onProject,
  onAddProject,
  onSearch
}: {
  snapshot: DashboardSnapshot
  selectedProjectId?: string
  page: Page
  busy: boolean
  onPage: (page: Page) => void
  onProject: (id: string) => void
  onAddProject: () => void
  onSearch: () => void
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
          const count = item.page === 'tasks' ? snapshot.tasks.length : item.page === 'notes' ? snapshot.notes.length : null
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
          <button key={project.id} onClick={() => onProject(project.id)} className={selectedProjectId === project.id ? 'selected' : ''}>
            <span className={`project-dot dot-${index % 3}`} />
            <span>{project.name}</span>
          </button>
        ))}
      </div>
      <button className="add-project" disabled={busy} onClick={onAddProject}>
        {busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}
        실제 Git 프로젝트 추가
      </button>

      <button className="feedback-button">
        <MessageSquare size={14} />
        앱 피드백
      </button>
    </aside>
  )
}

function DashboardPage({
  snapshot,
  activeTask,
  awaitingTask,
  unresolvedCount,
  range,
  onRange,
  onOpenTask,
  onNewTask
}: {
  snapshot: DashboardSnapshot
  activeTask: TaskRecord | null
  awaitingTask: TaskRecord | null
  unresolvedCount: number
  range: Range
  onRange: (range: Range) => void
  onOpenTask: (task: TaskRecord) => void
  onNewTask: () => void
}): React.JSX.Element {
  const focusTask = activeTask ?? awaitingTask ?? snapshot.tasks[0] ?? null
  const hourly = buildHourlyActivity(snapshot.events)
  const seriesDays = range === 'all' ? 16 : range
  const daily = buildDailySeries(snapshot.tasks, snapshot.findings, seriesDays)
  const latest24 = snapshot.events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < 86_400_000)
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
        <ChartCard title="작업" subtitle="시작 대비 완료 누적 추이" action="작업 전체">
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
        <ChartCard title="버그" subtitle="등록 대비 해결 누적 추이" action="버그 보드">
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

      <ActivityFeed events={snapshot.events.slice(0, 15)} />
    </section>
  )
}

function ChartCard({ title, subtitle, action, children }: { title: string; subtitle: string; action: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <article className="panel chart-card">
      <header><div><strong>{title}</strong><span>{subtitle}</span></div><button>{action}</button></header>
      <div className="chart-body">{children}</div>
    </article>
  )
}

function ActivityFeed({ events }: { events: EventRecord[] }): React.JSX.Element {
  return (
    <article className="panel activity-card">
      <header className="activity-header">
        <strong>활동</strong>
        <div className="activity-key"><span className="blue">작업</span><span className="green">완료</span><span className="pink">메모</span><span className="orange">버그</span><span className="violet">해결</span></div>
        <span>이벤트 {events.length}개 · 최근 기록</span>
        <button>모두 펼치기</button>
      </header>
      <div className="activity-day"><ChevronDown size={13} /><strong>오늘</strong><span>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' }).format(new Date())}</span></div>
      <div className="activity-list">
        {events.map((event) => {
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

function TasksPage({ tasks, onNewTask, onOpen, onRun, onAction }: { tasks: TaskRecord[]; onNewTask: () => void; onOpen: (task: TaskRecord) => void; onRun: (task: TaskRecord) => void; onAction: (task: TaskRecord, action: 'stop' | 'approve' | 'discard') => void }): React.JSX.Element {
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
              {['queued', 'failed', 'stopped'].includes(task.status) && <button title="실행" onClick={() => onRun(task)}><Play size={13} /></button>}
              {isActiveTask(task) && <button title="중단" onClick={() => onAction(task, 'stop')}><Square size={12} /></button>}
              {task.status === 'awaiting_approval' && <button title="승인" onClick={() => onAction(task, 'approve')}><Check size={13} /></button>}
            </div>
          </div>
        ))}
      </article>
    </section>
  )
}

function FindingsPage({ findings }: { findings: DashboardSnapshot['findings'] }): React.JSX.Element {
  return (
    <section className="workspace-page">
      <PageHeading title="버그" description="테스트 실행과 Reviewer가 근거와 함께 등록한 결함이다." />
      <div className="finding-grid">
        {findings.map((finding) => (
          <article className="panel finding-card" key={finding.id}>
            <div><span className={`severity-dot ${finding.severity}`} /><strong>{finding.title}</strong></div>
            <p>{finding.taskId ? `WORK-${finding.taskId.slice(0, 8).toUpperCase()}` : '프로젝트 전체'} · {shortDate(finding.createdAt)}</p>
            <span className={`status-pill ${finding.resolved ? 'green' : 'red'}`}>{finding.resolved ? '해결됨' : '미해결'}</span>
          </article>
        ))}
        {findings.length === 0 && <EmptyState icon={Bug} title="등록된 버그가 없습니다." />}
      </div>
    </section>
  )
}

function NotesPage({ notes, onNew }: { notes: DashboardSnapshot['notes']; onNew: () => void }): React.JSX.Element {
  return (
    <section className="workspace-page">
      <PageHeading title="메모" description="사람의 결정과 에이전트 보고를 프로젝트 문맥으로 남긴다." action="새 메모" onAction={onNew} />
      <div className="notes-grid">
        {notes.map((note) => <article className="panel note-card" key={note.id}><NotebookPen size={14} /><div><strong>{note.title}</strong><p>{note.body}</p><time>{timeAgo(note.createdAt)}</time></div></article>)}
      </div>
    </section>
  )
}

function ProjectsPage({ project, onSave, onOpen }: { project: ProjectRecord; onSave: (input: { projectId: string; name: string; testCommand: string }) => Promise<void>; onOpen: () => void }): React.JSX.Element {
  const [name, setName] = useState(project.name)
  const [testCommand, setTestCommand] = useState(project.testCommand)
  useEffect(() => { setName(project.name); setTestCommand(project.testCommand) }, [project])
  return (
    <section className="workspace-page">
      <PageHeading title="프로젝트 설정" description="에이전트가 접근할 저장소와 검증 명령을 명시한다." />
      <form className="panel settings-form" onSubmit={(event) => { event.preventDefault(); void onSave({ projectId: project.id, name, testCommand }) }}>
        <div className="setting-icon"><Settings2 size={18} /></div>
        <label><span>프로젝트 이름</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>저장소 경로</span><div className="path-field"><code>{project.path}</code><button type="button" disabled={project.isDemo} onClick={onOpen}><FolderOpen size={14} /> 열기</button></div></label>
        <label><span>검증 명령</span><input value={testCommand} placeholder="예: pnpm check 또는 xcodebuild test ..." onChange={(event) => setTestCommand(event.target.value)} /><small>shell 연산자 없이 허용된 실행 파일과 인자만 입력한다.</small></label>
        <div className="allowed-tools"><strong>허용된 테스트 실행 파일</strong><span>pnpm · npm · npx · yarn · bun · xcodebuild · swift · cargo · go · python · pytest · make · cmake · gradle</span></div>
        <button className="primary-button" type="submit">설정 저장</button>
      </form>
    </section>
  )
}

function PageHeading({ title, description, action, onAction }: { title: string; description: string; action?: string; onAction?: () => void }): React.JSX.Element {
  return <header className="page-heading"><div><h2>{title}</h2><p>{description}</p></div>{action && <button className="primary-button" onClick={onAction}><Plus size={14} />{action}</button>}</header>
}

function EmptyState({ icon: Icon, title }: { icon: typeof Bug; title: string }): React.JSX.Element {
  return <div className="panel empty-state"><Icon size={20} /><span>{title}</span></div>
}

function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true">
        <header><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button aria-label="닫기" onClick={onClose}><X size={16} /></button></header>
        {children}
      </section>
    </div>
  )
}

function TaskModal({ project, onClose, onCreate }: { project: ProjectRecord; onClose: () => void; onCreate: (input: { projectId: string; title: string; prompt: string; maxAttempts: number }) => Promise<void> }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [maxAttempts, setMaxAttempts] = useState(3)
  const [submitting, setSubmitting] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitting(true)
    try { await onCreate({ projectId: project.id, title, prompt, maxAttempts }) } finally { setSubmitting(false) }
  }
  return (
    <Modal title="새 에이전트 작업" description={`${project.name}의 격리된 worktree에서 실행된다.`} onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <label><span>작업 제목</span><input autoFocus minLength={2} maxLength={120} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 네비게이션 경로 이탈 감지 구현" /></label>
        <label><span>목표와 완료 조건</span><textarea minLength={10} maxLength={20000} required rows={8} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="구현할 동작, 제외 범위, 통과해야 할 테스트를 구체적으로 작성한다." /></label>
        <label><span>최대 자가 수정 횟수</span><input type="number" min={1} max={5} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} /></label>
        <div className="workflow-preview"><span><FileText size={13} />테스트 설계</span><i /><span><Search size={13} />비평</span><i /><span><Bot size={13} />구현</span><i /><span><CheckCircle2 size={13} />검증</span></div>
        <button className="primary-button" disabled={submitting || project.isDemo} type="submit">{submitting ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{project.isDemo ? '실제 프로젝트에서 사용 가능' : '작업 등록'}</button>
      </form>
    </Modal>
  )
}

function NoteModal({ projectId, onClose, onCreate }: { projectId: string; onClose: () => void; onCreate: (projectId: string, title: string, body: string) => Promise<void> }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <Modal title="새 메모" onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onCreate(projectId, title, body) }}>
        <label><span>제목</span><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>내용</span><textarea required rows={7} value={body} onChange={(event) => setBody(event.target.value)} /></label>
        <button className="primary-button" type="submit"><Plus size={14} />메모 저장</button>
      </form>
    </Modal>
  )
}

function SearchModal({ snapshot, onClose, onTask }: { snapshot: DashboardSnapshot; onClose: () => void; onTask: (task: TaskRecord) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return snapshot.tasks.slice(0, 6)
    return snapshot.tasks.filter((task) => `${task.title} ${task.prompt}`.toLowerCase().includes(normalized)).slice(0, 8)
  }, [query, snapshot.tasks])
  return (
    <div className="search-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="search-modal">
        <div className="search-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="작업, 메모, 이벤트 검색" /><kbd>ESC</kbd></div>
        <div className="search-results"><p>작업</p>{results.map((task) => <button key={task.id} onClick={() => onTask(task)}><ListTodo size={14} /><span><strong>{task.title}</strong><small>{STATUS_LABELS[task.status]} · {timeAgo(task.updatedAt)}</small></span><Command size={12} /></button>)}{results.length === 0 && <span className="no-result">검색 결과가 없습니다.</span>}</div>
      </section>
    </div>
  )
}

function TaskDrawer({ task, events, onClose, onRun, onAction, onOpenPath }: { task: TaskRecord; events: EventRecord[]; onClose: () => void; onRun: (task: TaskRecord) => void; onAction: (task: TaskRecord, action: 'stop' | 'approve' | 'discard') => void; onOpenPath: () => void }): React.JSX.Element {
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <aside className="task-drawer">
        <header><div><span className={`status-pill ${statusTone(task.status)}`}>{STATUS_LABELS[task.status]}</span><h2>{task.title}</h2><p>WORK-{task.id.slice(0, 8).toUpperCase()} · codex</p></div><button aria-label="닫기" onClick={onClose}><X size={16} /></button></header>
        <section className="task-contract"><strong>작업 계약</strong><p>{task.prompt}</p><div><span><Clock3 size={12} />최대 {task.maxAttempts}회</span><span><GitBranch size={12} />{task.branchName ?? '실행 전'}</span></div></section>
        <section className="drawer-events"><div className="drawer-section-title"><strong>실시간 로그</strong><span>{events.length}개</span></div>{events.length === 0 && <p className="empty-copy">아직 실행 로그가 없습니다.</p>}{events.map((event) => { const Icon = eventIcon(event.kind); return <div key={event.id}><span><Icon size={12} /></span><p><strong>{event.actor}</strong>{event.message}</p><time>{timeAgo(event.createdAt)}</time></div> })}</section>
        <footer>
          {task.worktreePath && <button className="secondary-button" onClick={onOpenPath}><FolderOpen size={14} />작업공간 열기</button>}
          {['queued', 'failed', 'stopped'].includes(task.status) && <button className="primary-button" onClick={() => onRun(task)}><Play size={14} />실행</button>}
          {isActiveTask(task) && <button className="danger-button" onClick={() => onAction(task, 'stop')}><Octagon size={14} />중단</button>}
          {task.status === 'awaiting_approval' && <><button className="danger-button" onClick={() => onAction(task, 'discard')}><Trash2 size={14} />폐기</button><button className="primary-button" onClick={() => onAction(task, 'approve')}><Check size={14} />변경 승인</button></>}
        </footer>
      </aside>
    </div>
  )
}
