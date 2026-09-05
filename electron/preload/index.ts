import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_MONITORING_BRIDGE_VERSION } from '../../src/shared/types'
import type {
  AgentMonitoringBridge,
  CodexAuthStatus,
  ContinueTaskInput,
  CreateTaskInput,
  DeleteProjectRuntimeEnvironmentInput,
  EventRecord,
  GenerateTechSpecInput,
  GenerateRuntimeScenarioInput,
  MoveTaskRevisionRequestInput,
  ProjectSimulatorSession,
  RecommendVerificationPlanInput,
  RefineTechSpecInput,
  SourceControlCommitInput,
  SourceControlDiffInput,
  SourceControlIdentityInput,
  SourceControlPathsInput,
  SetTaskRevisionQueuePausedInput,
  TaskRevisionRequestInput,
  UpdateProjectInput,
  UpdateTaskRevisionRequestInput,
  UpsertProjectRuntimeEnvironmentInput
} from '../../src/shared/types'

const bridge: AgentMonitoringBridge = {
  apiVersion: AGENT_MONITORING_BRIDGE_VERSION,
  getCodexAuth: () => ipcRenderer.invoke('codex-auth:status'),
  loginCodex: () => ipcRenderer.invoke('codex-auth:login'),
  cancelCodexLogin: () => ipcRenderer.invoke('codex-auth:cancel'),
  logoutCodex: () => ipcRenderer.invoke('codex-auth:logout'),
  listCodexModels: (refresh = false) => ipcRenderer.invoke('codex-models:list', refresh),
  getSnapshot: (projectId?: string) => ipcRenderer.invoke('dashboard:snapshot', projectId),
  addProject: () => ipcRenderer.invoke('project:add'),
  updateProject: (input: UpdateProjectInput) => ipcRenderer.invoke('project:update', input),
  listProjectRuntimeEnvironment: (projectId: string) =>
    ipcRenderer.invoke('project-runtime-environment:list', projectId),
  upsertProjectRuntimeEnvironment: (input: UpsertProjectRuntimeEnvironmentInput) =>
    ipcRenderer.invoke('project-runtime-environment:upsert', input),
  deleteProjectRuntimeEnvironment: (input: DeleteProjectRuntimeEnvironmentInput) =>
    ipcRenderer.invoke('project-runtime-environment:delete', input),
  inspectProject: (projectId: string) => ipcRenderer.invoke('project:inspect', projectId),
  getSourceControlStatus: (projectId: string) => ipcRenderer.invoke('source-control:status', projectId),
  getSourceControlDiff: (input: SourceControlDiffInput) => ipcRenderer.invoke('source-control:diff', input),
  stageSourceControlPaths: (input: SourceControlPathsInput) => ipcRenderer.invoke('source-control:stage', input),
  unstageSourceControlPaths: (input: SourceControlPathsInput) => ipcRenderer.invoke('source-control:unstage', input),
  stageAllSourceControlChanges: (projectId: string) => ipcRenderer.invoke('source-control:stage-all', projectId),
  unstageAllSourceControlChanges: (projectId: string) => ipcRenderer.invoke('source-control:unstage-all', projectId),
  setSourceControlIdentity: (input: SourceControlIdentityInput) =>
    ipcRenderer.invoke('source-control:set-identity', input),
  commitSourceControlChanges: (input: SourceControlCommitInput) =>
    ipcRenderer.invoke('source-control:commit', input),
  fetchSourceControlRemote: (projectId: string) => ipcRenderer.invoke('source-control:fetch', projectId),
  pushSourceControlRemote: (projectId: string) => ipcRenderer.invoke('source-control:push', projectId),
  syncSourceControlRemote: (projectId: string) => ipcRenderer.invoke('source-control:sync', projectId),
  getProjectSimulatorStatus: (projectId: string) => ipcRenderer.invoke('project-simulator:status', projectId),
  listProjectRunDestinations: (projectId: string, refresh = false) =>
    ipcRenderer.invoke('project-simulator:destinations', projectId, refresh),
  launchProjectSimulator: (projectId: string, destinationId?: string) =>
    ipcRenderer.invoke('project-simulator:launch', projectId, destinationId),
  launchTaskSimulator: (taskId: string, destinationId?: string) =>
    ipcRenderer.invoke('project-simulator:launch-task', taskId, destinationId),
  restartProjectSimulator: (projectId: string) => ipcRenderer.invoke('project-simulator:restart', projectId),
  stopProjectSimulator: (projectId: string) => ipcRenderer.invoke('project-simulator:stop', projectId),
  autoConfigureProjectRuntime: (projectId: string) =>
    ipcRenderer.invoke('project:auto-configure-runtime', projectId),
  generateTechSpec: (input: GenerateTechSpecInput) =>
    ipcRenderer.invoke('tech-spec:generate', input),
  refineTechSpec: (input: RefineTechSpecInput) =>
    ipcRenderer.invoke('tech-spec:refine', input),
  generateRuntimeScenario: (input: GenerateRuntimeScenarioInput) =>
    ipcRenderer.invoke('runtime-scenario:generate', input),
  recommendVerificationPlan: (input: RecommendVerificationPlanInput) =>
    ipcRenderer.invoke('verification-plan:recommend', input),
  removeProject: (projectId: string) => ipcRenderer.invoke('project:remove', projectId),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke('task:create', input),
  regenerateTaskRuntimeScenario: (taskId: string) =>
    ipcRenderer.invoke('task:regenerate-runtime-scenario', taskId),
  getTaskChanges: (taskId: string) => ipcRenderer.invoke('task:changes', taskId),
  runTask: (taskId: string) => ipcRenderer.invoke('task:run', taskId),
  continueTask: (input: ContinueTaskInput) => ipcRenderer.invoke('task:continue', input),
  updateTaskRevisionRequest: (input: UpdateTaskRevisionRequestInput) =>
    ipcRenderer.invoke('task:revision-update', input),
  cancelTaskRevisionRequest: (input: TaskRevisionRequestInput) =>
    ipcRenderer.invoke('task:revision-cancel', input),
  moveTaskRevisionRequest: (input: MoveTaskRevisionRequestInput) =>
    ipcRenderer.invoke('task:revision-move', input),
  setTaskRevisionQueuePaused: (input: SetTaskRevisionQueuePausedInput) =>
    ipcRenderer.invoke('task:revision-queue-pause', input),
  runNextTaskRevision: (taskId: string) => ipcRenderer.invoke('task:revision-run-next', taskId),
  retryTaskVerification: (taskId: string) => ipcRenderer.invoke('task:retry-verification', taskId),
  stopTask: (taskId: string) => ipcRenderer.invoke('task:stop', taskId),
  approveTask: (taskId: string) => ipcRenderer.invoke('task:approve', taskId),
  refreshTaskPublication: (taskId: string) => ipcRenderer.invoke('task:refresh-publication', taskId),
  switchTaskPublicationToPullRequest: (taskId: string) => ipcRenderer.invoke('task:switch-publication-to-pr', taskId),
  discardTask: (taskId: string) => ipcRenderer.invoke('task:discard', taskId),
  openTaskInXcode: (taskId: string) => ipcRenderer.invoke('task:open-in-xcode', taskId),
  getStorageOverview: () => ipcRenderer.invoke('storage:overview'),
  setStoragePolicy: (policy) => ipcRenderer.invoke('storage:set-policy', policy),
  cleanupStorage: (input) => ipcRenderer.invoke('storage:cleanup', input),
  setFindingResolved: (findingId: string, resolved: boolean) =>
    ipcRenderer.invoke('finding:set-resolved', { findingId, resolved }),
  addNote: (projectId: string, title: string, body: string) =>
    ipcRenderer.invoke('note:add', { projectId, title, body }),
  updateNote: (noteId: string, title: string, body: string) =>
    ipcRenderer.invoke('note:update', { noteId, title, body }),
  deleteNote: (noteId: string) => ipcRenderer.invoke('note:delete', noteId),
  openPath: (path: string) => ipcRenderer.invoke('shell:open-path', path),
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:open-external-url', url),
  openFeedback: () => ipcRenderer.invoke('shell:open-feedback'),
  onCodexAuthChanged: (listener: (status: CodexAuthStatus) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: CodexAuthStatus): void => listener(payload)
    ipcRenderer.on('codex-auth:changed', wrapped)
    return () => ipcRenderer.removeListener('codex-auth:changed', wrapped)
  },
  onEvent: (listener: (event: EventRecord) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: EventRecord): void => listener(payload)
    ipcRenderer.on('runner:event', wrapped)
    return () => ipcRenderer.removeListener('runner:event', wrapped)
  },
  onProjectSimulatorChanged: (listener: (session: ProjectSimulatorSession) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProjectSimulatorSession): void => listener(payload)
    ipcRenderer.on('project-simulator:changed', wrapped)
    return () => ipcRenderer.removeListener('project-simulator:changed', wrapped)
  }
}

contextBridge.exposeInMainWorld('agentMonitoring', bridge)
ipcRenderer.send('preload:ready')
