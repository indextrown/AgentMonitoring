export type TaskStatus =
  | 'queued'
  | 'running'
  | 'testing'
  | 'awaiting_approval'
  | 'awaiting_manual_validation'
  | 'awaiting_merge'
  | 'blocked_environment'
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
  | 'environment_started'
  | 'environment_passed'
  | 'environment_failed'
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
  | 'runtime_acted'
  | 'runtime_observed'
  | 'runtime_verified'
  | 'runtime_repair_started'
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

export type IosDeviceFamily = 'iphone' | 'ipad'

export interface IosRuntimeAdapterConfig {
  kind: 'ios-simulator'
  container: string
  scheme: string
  configuration: 'Debug'
  deviceFamily: IosDeviceFamily
}

export type ProjectRuntimeConfigSource = 'detected' | 'manifest'

export type RuntimeUiAction =
  | {
      kind: 'tap'
      identifier: string
      timeoutSeconds: number
    }
  | {
      kind: 'type-text'
      identifier: string
      text: string
      timeoutSeconds: number
    }

export type RuntimeAcceptanceAssertion =
  | {
      kind: 'accessibility'
      name?: string
      identifier: string
      property: 'exists'
      expected: boolean
    }
  | {
      kind: 'accessibility'
      name?: string
      identifier: string
      property: 'label' | 'title' | 'value' | 'placeholderValue' | 'elementType'
      expected: string
    }
  | {
      kind: 'accessibility'
      name?: string
      identifier: string
      property: 'enabled' | 'selected'
      expected: boolean
    }
  | {
      kind: 'evidence'
      name?: string
      target: 'screen' | 'accessibility' | 'ui-actions'
    }

export interface TaskRuntimeScenario {
  actions: RuntimeUiAction[]
  assertions: RuntimeAcceptanceAssertion[]
}

export interface ApprovedRuntimeContract {
  version: 1
  adapter: IosRuntimeAdapterConfig
  capabilities: {
    build: true
    run: true
    observe: Array<'screen' | 'accessibility'>
    act: Array<'ui'>
    verify: Array<'test-command' | 'runtime-scenario'>
  }
  runtimeScenario: TaskRuntimeScenario
}

export interface GeneratedRuntimeScenario {
  summary: string
  contract: ApprovedRuntimeContract
}

export type VerificationMode =
  | 'project-tests'
  | 'simulator-runtime'
  | 'both'
  | 'manual-review'

export type TestDesignStrategy =
  | 'automatic'
  | 'swift-testing'
  | 'xctest'
  | 'existing-tests'
  | 'skip'

export type RuntimeVerificationSource = 'task-scenario' | 'project-default' | 'off'

export interface TaskVerificationPlan {
  version: 1
  mode: VerificationMode
  testDesign: TestDesignStrategy
  runtimeSource: RuntimeVerificationSource
}

export type VerificationStepKey =
  | 'environment-setup'
  | 'test-design'
  | 'project-tests'
  | 'simulator-runtime'
  | 'reviewer'

export type VerificationStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

export interface VerificationStepResult {
  status: VerificationStepStatus
  message: string
  updatedAt: string
}

export interface TaskVerificationResult {
  environmentSetup: VerificationStepResult
  testDesign: VerificationStepResult
  projectTests: VerificationStepResult
  simulatorRuntime: VerificationStepResult
  reviewer: VerificationStepResult
}

export interface VerificationPlanRecommendation {
  summary: string
  plan: TaskVerificationPlan
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
  testCommand: string
  setupCommand: string
  runtimeAdapter?: IosRuntimeAdapterConfig | null
  runtimeConfigSource?: ProjectRuntimeConfigSource | null
  publishStrategy?: PublishStrategy
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

export type SourceControlArea = 'staged' | 'working'

export interface SourceControlFile {
  path: string
  originalPath: string | null
  staged: ProjectChangeKind | null
  working: ProjectChangeKind | null
  conflicted: boolean
}

export interface SourceControlIdentity {
  name: string | null
  email: string | null
  complete: boolean
}

export interface SourceControlStatus {
  projectId: string
  branch: string | null
  headCommit: string | null
  identity: SourceControlIdentity
  files: SourceControlFile[]
  stagedCount: number
  workingCount: number
  conflictedCount: number
  remote: SourceControlRemoteStatus | null
  inspectedAt: string
}

export type PublishStrategy = 'pull-request' | 'direct'

export interface SourceControlRemoteStatus {
  name: string
  url: string
  upstream: string | null
  ahead: number
  behind: number
  diverged: boolean
}

export interface SourceControlDiff {
  projectId: string
  path: string
  area: SourceControlArea
  patch: string
  available: boolean
  binary: boolean
  truncated: boolean
}

export interface SourceControlPathsInput {
  projectId: string
  paths: string[]
}

export interface SourceControlDiffInput {
  projectId: string
  path: string
  area: SourceControlArea
}

export interface SourceControlCommitInput {
  projectId: string
  message: string
  includeWorking: boolean
}

export interface SourceControlIdentityInput {
  projectId: string
  name: string
  email: string
}

export interface SourceControlCommitResult {
  commit: string
  summary: string
  status: SourceControlStatus
}

export interface TaskApprovalResult {
  outcome: 'published' | 'pr_opened' | 'reverified' | 'awaiting_merge'
  message: string
}

export type TaskPublicationStatus =
  | 'not_started'
  | 'awaiting_merge'
  | 'awaiting_local_sync'
  | 'published'
  | 'failed'

export interface TaskPublication {
  strategy: PublishStrategy
  status: TaskPublicationStatus
  remoteName: string | null
  baseBranch: string | null
  remoteBranch: string | null
  pullRequestUrl: string | null
  publishedCommit: string | null
  message: string | null
  updatedAt: string | null
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
  sourceBranch: string | null
  baseCommit: string | null
  publishStrategy?: PublishStrategy
  publication?: TaskPublication | null
  runtimeContract?: ApprovedRuntimeContract | null
  runtimeScenarioSummary?: string | null
  runtimeScenarioApprovedAt?: string | null
  verificationPlan?: TaskVerificationPlan | null
  verificationResult?: TaskVerificationResult | null
  createdAt: string
  updatedAt: string
}

export type RuntimeSessionStatus =
  | 'preparing'
  | 'booting'
  | 'building'
  | 'installing'
  | 'launching'
  | 'acting'
  | 'observing'
  | 'verifying'
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
  runId: string
  attempt: number
  kind: 'screen' | 'accessibility' | 'ui-actions' | 'debug-state' | 'runtime-verification'
  outcome: 'captured' | 'passed' | 'failed'
  summary: string | null
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

export type RuntimeArtifactRetentionDays = 0 | 7 | 30 | 90

export interface StoragePolicy {
  runtimeArtifactRetentionDays: RuntimeArtifactRetentionDays
}

export interface StorageOverview {
  policy: StoragePolicy
  worktreeBytes: number
  runtimeArtifactBytes: number
  totalBytes: number
  worktreeCount: number
  runtimeArtifactCount: number
  cleanupCandidateCount: number
  branchCandidateCount: number
  scannedAt: string
}

export interface StorageCleanupInput {
  removeLocalBranches: boolean
}

export interface StorageCleanupResult {
  worktreesRemoved: number
  runtimeArtifactsRemoved: number
  branchesRemoved: number
  bytesReclaimed: number
  warnings: string[]
  overview: StorageOverview
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
  runtimeContract?: ApprovedRuntimeContract | null
  runtimeScenarioSummary?: string | null
  verificationPlan: TaskVerificationPlan
  publishStrategy: PublishStrategy
}

export interface UpdateProjectInput {
  projectId: string
  name: string
  testCommand: string
  setupCommand: string
  runtimeAdapter?: IosRuntimeAdapterConfig | null
  publishStrategy?: PublishStrategy
}

export interface GenerateRuntimeScenarioInput {
  projectId: string
  title: string
  prompt: string
}

export interface RecommendVerificationPlanInput {
  projectId: string
  title: string
  prompt: string
}

export const AGENT_MONITORING_BRIDGE_VERSION = 6

export interface AgentMonitoringBridge {
  apiVersion: number
  getCodexAuth: () => Promise<CodexAuthStatus>
  loginCodex: () => Promise<CodexAuthStatus>
  cancelCodexLogin: () => Promise<CodexAuthStatus>
  logoutCodex: () => Promise<CodexAuthStatus>
  getSnapshot: (projectId?: string) => Promise<DashboardSnapshot>
  addProject: () => Promise<ProjectRecord | null>
  updateProject: (input: UpdateProjectInput) => Promise<ProjectRecord>
  inspectProject: (projectId: string) => Promise<ProjectInspection>
  getSourceControlStatus: (projectId: string) => Promise<SourceControlStatus>
  getSourceControlDiff: (input: SourceControlDiffInput) => Promise<SourceControlDiff>
  stageSourceControlPaths: (input: SourceControlPathsInput) => Promise<SourceControlStatus>
  unstageSourceControlPaths: (input: SourceControlPathsInput) => Promise<SourceControlStatus>
  stageAllSourceControlChanges: (projectId: string) => Promise<SourceControlStatus>
  unstageAllSourceControlChanges: (projectId: string) => Promise<SourceControlStatus>
  setSourceControlIdentity: (input: SourceControlIdentityInput) => Promise<SourceControlStatus>
  commitSourceControlChanges: (input: SourceControlCommitInput) => Promise<SourceControlCommitResult>
  fetchSourceControlRemote: (projectId: string) => Promise<SourceControlStatus>
  autoConfigureProjectRuntime: (projectId: string) => Promise<ProjectRecord>
  generateRuntimeScenario: (input: GenerateRuntimeScenarioInput) => Promise<GeneratedRuntimeScenario>
  recommendVerificationPlan: (
    input: RecommendVerificationPlanInput
  ) => Promise<VerificationPlanRecommendation>
  removeProject: (projectId: string) => Promise<void>
  createTask: (input: CreateTaskInput) => Promise<TaskRecord>
  getTaskChanges: (taskId: string) => Promise<TaskChanges>
  runTask: (taskId: string) => Promise<void>
  retryTaskVerification: (taskId: string) => Promise<void>
  stopTask: (taskId: string) => Promise<void>
  approveTask: (taskId: string) => Promise<TaskApprovalResult>
  refreshTaskPublication: (taskId: string) => Promise<TaskApprovalResult>
  switchTaskPublicationToPullRequest: (taskId: string) => Promise<TaskRecord>
  discardTask: (taskId: string) => Promise<void>
  getStorageOverview: () => Promise<StorageOverview>
  setStoragePolicy: (policy: StoragePolicy) => Promise<StorageOverview>
  cleanupStorage: (input: StorageCleanupInput) => Promise<StorageCleanupResult>
  setFindingResolved: (findingId: string, resolved: boolean) => Promise<FindingRecord>
  addNote: (projectId: string, title: string, body: string) => Promise<NoteRecord>
  updateNote: (noteId: string, title: string, body: string) => Promise<NoteRecord>
  deleteNote: (noteId: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  openExternalUrl: (url: string) => Promise<void>
  openFeedback: () => Promise<void>
  onCodexAuthChanged: (listener: (status: CodexAuthStatus) => void) => () => void
  onEvent: (listener: (event: EventRecord) => void) => () => void
}
