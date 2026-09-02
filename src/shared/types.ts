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
  | 'finding_reopened'
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'task_completed'
  | 'task_stopped'
  | 'task_timed_out'
  | 'task_recovered'
  | 'task_discarded'
  | 'runtime_started'
  | 'runtime_ready'
  | 'runtime_observed'
  | 'runtime_failed'
  | 'runtime_stopped'
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

export type ProjectChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface ProjectChangeSummary {
  modified: number
  added: number
  deleted: number
  renamed: number
  untracked: number
  conflicted: number
}

export interface ProjectChangeDetail {
  kind: ProjectChangeKind
  path: string
}

export type ProjectCapabilityKey = 'code' | 'build' | 'run' | 'observe' | 'act' | 'verify'

export type ProjectCapabilityStatus = 'ready' | 'declared' | 'missing'

export interface ProjectCapability {
  key: ProjectCapabilityKey
  status: ProjectCapabilityStatus
  detail: string
}

export type ProjectCapabilityManifestState = 'missing' | 'valid' | 'invalid'

export interface ProjectCapabilityManifestInspection {
  path: string
  state: ProjectCapabilityManifestState
  adapterKind: 'ios-simulator' | null
  message: string
}

export interface ProjectInspection {
  projectId: string
  branch: string | null
  headCommit: string | null
  lastCommitAt: string | null
  clean: boolean
  changeCount: number
  changeSummary: ProjectChangeSummary
  changePreview: ProjectChangeDetail[]
  hasRemote: boolean
  primaryLanguage: string | null
  languages: string[]
  tools: string[]
  manifests: string[]
  trackedFileCount: number
  testFileCount: number
  suggestedTestCommands: string[]
  capabilityManifest: ProjectCapabilityManifestInspection
  capabilities: ProjectCapability[]
  inspectedAt: string
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

export type RuntimeSessionStatus =
  | 'preparing'
  | 'booting'
  | 'building'
  | 'installing'
  | 'launching'
  | 'observing'
  | 'running'
  | 'failed'
  | 'stopped'

export interface RuntimeSessionRecord {
  taskId: string
  projectId: string
  status: RuntimeSessionStatus
  adapterKind: 'ios-simulator'
  deviceId: string | null
  deviceName: string | null
  bundleIdentifier: string | null
  processId: number | null
  message: string
  startedAt: string
  updatedAt: string
}

export interface RuntimeEvidenceRecord {
  id: string
  taskId: string
  projectId: string
  kind: 'screen' | 'accessibility'
  path: string
  mimeType: 'image/png' | 'application/json'
  sizeBytes: number
  createdAt: string
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

export interface TaskChangeFile {
  path: string
  status: string
  additions: number | null
  deletions: number | null
}

export interface TaskChanges {
  taskId: string
  available: boolean
  files: TaskChangeFile[]
  stat: string
  patch: string
  truncated: boolean
}

export interface DashboardSnapshot {
  projects: ProjectRecord[]
  selectedProject: ProjectRecord | null
  tasks: TaskRecord[]
  events: EventRecord[]
  findings: FindingRecord[]
  notes: NoteRecord[]
  runtimeSessions: RuntimeSessionRecord[]
  runtimeEvidence: RuntimeEvidenceRecord[]
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
  inspectProject: (projectId: string) => Promise<ProjectInspection>
  removeProject: (projectId: string) => Promise<void>
  createTask: (input: CreateTaskInput) => Promise<TaskRecord>
  getTaskChanges: (taskId: string) => Promise<TaskChanges>
  runTask: (taskId: string) => Promise<void>
  stopTask: (taskId: string) => Promise<void>
  approveTask: (taskId: string) => Promise<void>
  discardTask: (taskId: string) => Promise<void>
  setFindingResolved: (findingId: string, resolved: boolean) => Promise<FindingRecord>
  addNote: (projectId: string, title: string, body: string) => Promise<NoteRecord>
  updateNote: (noteId: string, title: string, body: string) => Promise<NoteRecord>
  deleteNote: (noteId: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  openFeedback: () => Promise<void>
  onCodexAuthChanged: (listener: (status: CodexAuthStatus) => void) => () => void
  onEvent: (listener: (event: EventRecord) => void) => () => void
}
