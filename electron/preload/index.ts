import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentMonitoringBridge,
  CodexAuthStatus,
  CreateTaskInput,
  EventRecord,
  UpdateProjectInput
} from '../../src/shared/types'

const bridge: AgentMonitoringBridge = {
  getCodexAuth: () => ipcRenderer.invoke('codex-auth:status'),
  loginCodex: () => ipcRenderer.invoke('codex-auth:login'),
  cancelCodexLogin: () => ipcRenderer.invoke('codex-auth:cancel'),
  logoutCodex: () => ipcRenderer.invoke('codex-auth:logout'),
  getSnapshot: (projectId?: string) => ipcRenderer.invoke('dashboard:snapshot', projectId),
  addProject: () => ipcRenderer.invoke('project:add'),
  updateProject: (input: UpdateProjectInput) => ipcRenderer.invoke('project:update', input),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke('task:create', input),
  runTask: (taskId: string) => ipcRenderer.invoke('task:run', taskId),
  stopTask: (taskId: string) => ipcRenderer.invoke('task:stop', taskId),
  approveTask: (taskId: string) => ipcRenderer.invoke('task:approve', taskId),
  discardTask: (taskId: string) => ipcRenderer.invoke('task:discard', taskId),
  addNote: (projectId: string, title: string, body: string) =>
    ipcRenderer.invoke('note:add', { projectId, title, body }),
  openPath: (path: string) => ipcRenderer.invoke('shell:open-path', path),
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
