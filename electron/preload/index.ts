import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_MONITORING_BRIDGE_VERSION } from '../../src/shared/types'
import type {
  AgentMonitoringBridge,
  CodexAuthStatus,
  CreateTaskInput,
  EventRecord,
  GenerateRuntimeScenarioInput,
  UpdateProjectInput
} from '../../src/shared/types'

const bridge: AgentMonitoringBridge = {
  apiVersion: AGENT_MONITORING_BRIDGE_VERSION,
  getCodexAuth: () => ipcRenderer.invoke('codex-auth:status'),
  loginCodex: () => ipcRenderer.invoke('codex-auth:login'),
  cancelCodexLogin: () => ipcRenderer.invoke('codex-auth:cancel'),
  logoutCodex: () => ipcRenderer.invoke('codex-auth:logout'),
  getSnapshot: (projectId?: string) => ipcRenderer.invoke('dashboard:snapshot', projectId),
  addProject: () => ipcRenderer.invoke('project:add'),
  updateProject: (input: UpdateProjectInput) => ipcRenderer.invoke('project:update', input),
  inspectProject: (projectId: string) => ipcRenderer.invoke('project:inspect', projectId),
  generateRuntimeScenario: (input: GenerateRuntimeScenarioInput) =>
    ipcRenderer.invoke('runtime-scenario:generate', input),
  removeProject: (projectId: string) => ipcRenderer.invoke('project:remove', projectId),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke('task:create', input),
  getTaskChanges: (taskId: string) => ipcRenderer.invoke('task:changes', taskId),
  runTask: (taskId: string) => ipcRenderer.invoke('task:run', taskId),
  stopTask: (taskId: string) => ipcRenderer.invoke('task:stop', taskId),
  approveTask: (taskId: string) => ipcRenderer.invoke('task:approve', taskId),
  discardTask: (taskId: string) => ipcRenderer.invoke('task:discard', taskId),
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
  }
}

contextBridge.exposeInMainWorld('agentMonitoring', bridge)
ipcRenderer.send('preload:ready')
