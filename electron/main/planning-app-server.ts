import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildCodexEnvironment, CODEX_AUTH_ARGUMENTS } from './codex-auth'

export type RpcObject = Record<string, any>

/** A planning-only connection. Authentication and running implementation agents stay independent. */
export class PlanningAppServer {
  private sequence = 0
  private failure: Error | null = null
  private readonly pending = new Map<number, { resolve: (value: RpcObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<(message: RpcObject) => void>()
  private readonly failures = new Set<(error: Error) => void>()
  private readonly child: ChildProcessWithoutNullStreams

  constructor(command: string, codexHome?: string) {
    this.child = spawn(command, [
      ...(codexHome ? CODEX_AUTH_ARGUMENTS : []),
      'app-server', '--listen', 'stdio://', '-c', 'agents.enabled=false'
    ], { env: codexHome ? buildCodexEnvironment(codexHome, command) : process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const reader = createInterface({ input: this.child.stdout })
    reader.on('line', (line) => {
      try { this.receive(JSON.parse(line)) } catch { this.fail(new Error('Codex 연결 응답을 해석하지 못했습니다.')) }
    })
    this.child.stderr.resume()
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.once('error', (error) => this.fail(error))
    this.child.once('exit', () => {
      reader.close()
      this.fail(new Error('Codex 연결이 종료됐습니다. 기존 초안은 보존됩니다. 다시 시도하세요.'))
    })
  }

  async initialize(): Promise<void> {
    await this.call('initialize', { clientInfo: { name: 'agent_monitoring_planning', version: '0.1.0' } })
    this.send({ method: 'initialized', params: {} })
  }

  call(method: string, params: RpcObject, timeout = 20_000): Promise<RpcObject> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} 연결 응답 시간이 초과됐습니다.`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (error) { this.fail(error as Error) }
    })
  }

  subscribe(listener: (message: RpcObject) => void, failure: (error: Error) => void): () => void {
    this.listeners.add(listener)
    this.failures.add(failure)
    if (this.failure) failure(this.failure)
    return () => { this.listeners.delete(listener); this.failures.delete(failure) }
  }

  async close(): Promise<void> {
    this.fail(new Error('Codex 계획 연결을 종료했습니다.'))
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 1_500)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
      this.child.kill('SIGTERM')
    })
  }

  private send(message: RpcObject): void {
    if (this.child.stdin.destroyed) throw new Error('Codex 계획 연결이 닫혔습니다.')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(message: RpcObject): void {
    // Server requests can reuse client request IDs. Never treat approval requests as responses.
    if (message.id !== undefined && message.method) {
      this.send({ id: message.id, error: { code: -32601, message: 'Read-only planning does not accept client tool or approval requests' } })
    } else if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(String(message.error.message ?? 'Codex 요청 실패')))
      else request.resolve(message.result ?? {})
    } else {
      for (const listener of this.listeners) listener(message)
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
    for (const listener of this.failures) listener(error)
  }
}
