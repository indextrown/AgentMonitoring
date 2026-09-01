export type TaskStatus =
  | 'queued'
  | 'running'
  | 'testing'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'discarded'

export type EventKind =
  | 'task_created'
  | 'task_started'
  | 'agent'
  | 'test_started'
  | 'test_passed'
  | 'test_failed'
  | 'finding_created'
  | 'finding_resolved'
  | 'note_created'
  | 'task_completed'
  | 'task_stopped'
  | 'task_discarded'
  | 'project_created'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type CodexAuthState = 'checking' | 'signed_out' | 'signing_in' | 'signed_in' | 'unavailable' | 'error'

export interface CodexAuthStatus {
  state: CodexAuthState
  authMode: string | null
  email: string | null
  planType: string | null
  message?: string
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  testCommand: string
  isDemo: boolean
  createdAt: string
}

export interface TaskRecord {
  id: string
  projectId: string
  title: string
  prompt: string
  status: TaskStatus
  provider: 'codex'
  maxAttempts: number
  attempt: number
  branchName: string | null
  worktreePath: string | null
  createdAt: string
  updatedAt: string
}

export interface EventRecord {
  id: number
  projectId: string
  taskId: string | null
  kind: EventKind
  actor: string
  message: string
  severity: Severity | null
  createdAt: string
}

export interface FindingRecord {
  id: string
  projectId: string
  taskId: string | null
  title: string
  severity: Severity
  resolved: boolean
  createdAt: string
  resolvedAt: string | null
}

export interface NoteRecord {
  id: string
  projectId: string
  title: string
  body: string
  createdAt: string
}

export interface DashboardSnapshot {
  projects: ProjectRecord[]
  selectedProject: ProjectRecord
  tasks: TaskRecord[]
  events: EventRecord[]
  findings: FindingRecord[]
  notes: NoteRecord[]
}

export interface CreateTaskInput {
  projectId: string
  title: string
  prompt: string
  maxAttempts: number
}

export interface UpdateProjectInput {
  projectId: string
  name: string
  testCommand: string
}

export interface AgentMonitoringBridge {
  getCodexAuth: () => Promise<CodexAuthStatus>
  loginCodex: () => Promise<CodexAuthStatus>
  cancelCodexLogin: () => Promise<CodexAuthStatus>
  logoutCodex: () => Promise<CodexAuthStatus>
  getSnapshot: (projectId?: string) => Promise<DashboardSnapshot>
  addProject: () => Promise<ProjectRecord | null>
  updateProject: (input: UpdateProjectInput) => Promise<ProjectRecord>
  createTask: (input: CreateTaskInput) => Promise<TaskRecord>
  runTask: (taskId: string) => Promise<void>
  stopTask: (taskId: string) => Promise<void>
  approveTask: (taskId: string) => Promise<void>
  discardTask: (taskId: string) => Promise<void>
  addNote: (projectId: string, title: string, body: string) => Promise<NoteRecord>
  openPath: (path: string) => Promise<void>
  onCodexAuthChanged: (listener: (status: CodexAuthStatus) => void) => () => void
  onEvent: (listener: (event: EventRecord) => void) => () => void
}
