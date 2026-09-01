/// <reference types="vite/client" />

import type { AgentMonitoringBridge } from '../../shared/types'

declare global {
  interface Window {
    agentMonitoring?: AgentMonitoringBridge
  }
}

export {}
