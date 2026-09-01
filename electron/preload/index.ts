import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentMonitoringBridge,
  CreateTaskInput,
  EventRecord,
  UpdateProjectInput
} from '../../src/shared/types'

const bridge: AgentMonitoringBridge = {
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
  onEvent: (listener: (event: EventRecord) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: EventRecord): void => listener(payload)
    ipcRenderer.on('runner:event', wrapped)
    return () => ipcRenderer.removeListener('runner:event', wrapped)
  }
}

contextBridge.exposeInMainWorld('agentMonitoring', bridge)
