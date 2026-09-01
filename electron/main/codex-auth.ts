import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { CodexAuthStatus } from '../../src/shared/types'

type JsonObject = Record<string, unknown>

interface PendingRequest {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface NotificationWaiter {
  predicate: (message: JsonObject) => boolean
  resolve: (message: JsonObject) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const AUTH_ARGUMENTS = [
  '-c',
  'forced_login_method="chatgpt"',
  '-c',
  'cli_auth_credentials_store="file"',
  '-c',
  'model_provider="openai"'
] as const
const execFileAsync = promisify(execFile)

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Codex가 올바르지 않은 응답을 반환했습니다.')
  }
  return value as JsonObject
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Codex 요청에 실패했습니다.'
  const message = (value as JsonObject).message
  return typeof message === 'string' ? message : 'Codex 요청에 실패했습니다.'
}

function codexEnvironment(codexHome: string, codexCommand = 'codex'): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
  delete environment.OPENAI_API_KEY
  delete environment.CODEX_API_KEY
  delete environment.CODEX_ACCESS_TOKEN
  if (isAbsolute(codexCommand)) {
    environment.PATH = [dirname(codexCommand), environment.PATH].filter(Boolean).join(delimiter)
  }
  return environment
}

function validateAuthUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new Error('Codex 로그인 주소를 확인할 수 없습니다.')
  }
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !['chatgpt.com', 'auth.openai.com'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('허용되지 않은 Codex 로그인 주소입니다.')
  }
  return value
}

class CodexAppServerSession {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notifications: JsonObject[] = []
  private readonly waiters: NotificationWaiter[] = []
  private readonly reader: ReadlineInterface
  private sequence = 0
  private closed = false
  private failure: Error | null = null

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.receive(line))
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code, signal) => {
      if (!this.closed) {
        this.fail(new Error(`Codex app-server가 종료되었습니다 (${signal ?? code ?? 'unknown'}).`))
      }
    })
  }

  async initialize(): Promise<void> {
    await this.call('initialize', {
      clientInfo: {
        name: 'agent_monitoring',
        title: 'AgentMonitoring',
        version: '0.1.0'
      }
    })
    this.send({ method: 'initialized', params: {} })
  }

  call(method: string, params: JsonObject, timeoutMs = 20_000): Promise<JsonObject> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} 요청 시간이 초과되었습니다.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  waitForNotification(
    predicate: (message: JsonObject) => boolean,
    timeoutMs = 10 * 60_000
  ): Promise<JsonObject> {
    const existingIndex = this.notifications.findIndex(predicate)
    if (existingIndex >= 0) {
      return Promise.resolve(this.notifications.splice(existingIndex, 1)[0])
    }
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Codex 로그인 승인 시간이 초과되었습니다.'))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.reader.close()
    this.fail(new Error('Codex app-server 연결이 닫혔습니다.'))
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => this.child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500))
    ])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }

  private send(message: JsonObject): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Codex app-server에 연결할 수 없습니다.')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    let message: JsonObject
    try {
      message = asObject(JSON.parse(line))
    } catch {
      this.fail(new Error('Codex app-server가 올바르지 않은 메시지를 반환했습니다.'))
      return
    }

    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id)
      if (!request) {
        if (typeof message.method === 'string') {
          this.send({
            id: message.id,
            error: { code: -32601, message: 'Client requests are not supported' }
          })
        }
        return
      }
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(errorMessage(message.error)))
      else request.resolve(asObject(message.result ?? {}))
      return
    }

    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message))
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
      return
    }
    this.notifications.push(message)
    if (this.notifications.length > 200) this.notifications.shift()
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }
}

export class CodexAuthManager {
  private loginSession: CodexAppServerSession | null = null
  private loginId: string | null = null
  private state: CodexAuthStatus = { state: 'checking', authMode: null, email: null, planType: null }

  constructor(
    readonly codexHome: string,
    private readonly publish: (status: CodexAuthStatus) => void,
    private readonly codexCommand = 'codex'
  ) {}

  get current(): CodexAuthStatus {
    return this.state
  }

  async status(): Promise<CodexAuthStatus> {
    if (this.loginSession) return this.state
    try {
      const result = await this.withSession((session) => session.call('account/read', { refreshToken: false }))
      return this.setState(this.statusFromAccount(result))
    } catch (error) {
      return this.setState(this.failureStatus(error))
    }
  }

  async login(openUrl: (url: string) => Promise<void>): Promise<CodexAuthStatus> {
    if (this.loginSession) throw new Error('Codex 로그인이 이미 진행 중입니다.')
    const session = await this.startSession()
    this.loginSession = session
    try {
      const current = this.statusFromAccount(await session.call('account/read', { refreshToken: false }))
      if (current.state === 'signed_in') return this.setState(current)

      this.setState({ state: 'signing_in', authMode: null, email: null, planType: null })
      const result = await session.call('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'codex'
      })
      const loginId = result.loginId
      if (typeof loginId !== 'string' || !loginId) throw new Error('Codex 로그인 ID를 받지 못했습니다.')
      this.loginId = loginId
      await openUrl(validateAuthUrl(result.authUrl))

      const notification = await session.waitForNotification((message) => {
        if (message.method !== 'account/login/completed') return false
        const params = message.params
        return Boolean(params && typeof params === 'object' && (params as JsonObject).loginId === loginId)
      })
      const params = asObject(notification.params)
      if (params.success !== true) {
        throw new Error(typeof params.error === 'string' ? params.error : 'Codex 로그인이 완료되지 않았습니다.')
      }
      const authenticated = this.statusFromAccount(
        await session.call('account/read', { refreshToken: false })
      )
      if (authenticated.state !== 'signed_in') throw new Error('Codex 로그인 상태를 확인하지 못했습니다.')
      return this.setState(authenticated)
    } catch (error) {
      this.setState(this.failureStatus(error, 'signed_out'))
      throw error
    } finally {
      this.loginId = null
      this.loginSession = null
      await session.close()
    }
  }

  async cancelLogin(): Promise<CodexAuthStatus> {
    const session = this.loginSession
    const loginId = this.loginId
    this.loginSession = null
    this.loginId = null
    if (session) {
      try {
        if (loginId) await session.call('account/login/cancel', { loginId })
      } finally {
        await session.close()
      }
    }
    return this.setState({ state: 'signed_out', authMode: null, email: null, planType: null })
  }

  async logout(): Promise<CodexAuthStatus> {
    await this.cancelLogin()
    await this.withSession((session) => session.call('account/logout', {}))
    return this.setState({ state: 'signed_out', authMode: null, email: null, planType: null })
  }

  async dispose(): Promise<void> {
    await this.cancelLogin()
  }

  private async startSession(): Promise<CodexAppServerSession> {
    await this.prepareHome()
    const child = spawn(
      this.codexCommand,
      [...AUTH_ARGUMENTS, 'app-server', '--listen', 'stdio://'],
      {
        env: codexEnvironment(this.codexHome, this.codexCommand),
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    child.stderr.resume()
    const session = new CodexAppServerSession(child)
    try {
      await session.initialize()
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }

  private async withSession<T>(operation: (session: CodexAppServerSession) => Promise<T>): Promise<T> {
    const session = await this.startSession()
    try {
      return await operation(session)
    } finally {
      await session.close()
    }
  }

  private async prepareHome(): Promise<void> {
    try {
      const info = await lstat(this.codexHome)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Codex 인증 저장소 경로가 안전하지 않습니다.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(this.codexHome, { recursive: true, mode: 0o700 })
    }
    await chmod(this.codexHome, 0o700)
  }

  private statusFromAccount(result: JsonObject): CodexAuthStatus {
    const account = result.account
    if (!account || typeof account !== 'object') {
      return { state: 'signed_out', authMode: null, email: null, planType: null }
    }
    const value = account as JsonObject
    if (value.type !== 'chatgpt') {
      return {
        state: 'error',
        authMode: typeof value.type === 'string' ? value.type : null,
        email: null,
        planType: null,
        message: 'AgentMonitoring은 ChatGPT Codex 로그인만 지원합니다.'
      }
    }
    return {
      state: 'signed_in',
      authMode: 'chatgpt',
      email: typeof value.email === 'string' ? value.email : null,
      planType: typeof value.planType === 'string' ? value.planType : null
    }
  }

  private failureStatus(error: unknown, fallback: 'error' | 'signed_out' = 'error'): CodexAuthStatus {
    const value = error as NodeJS.ErrnoException
    if (value.code === 'ENOENT') {
      return {
        state: 'unavailable',
        authMode: null,
        email: null,
        planType: null,
        message: 'Codex CLI를 찾을 수 없습니다. 설치 후 다시 시도하세요.'
      }
    }
    return {
      state: fallback,
      authMode: null,
      email: null,
      planType: null,
      message: error instanceof Error ? error.message : 'Codex 인증 상태를 확인하지 못했습니다.'
    }
  }

  private setState(status: CodexAuthStatus): CodexAuthStatus {
    this.state = status
    this.publish(status)
    return status
  }
}

export function buildCodexEnvironment(codexHome: string, codexCommand = 'codex'): NodeJS.ProcessEnv {
  return codexEnvironment(codexHome, codexCommand)
}

export const CODEX_AUTH_ARGUMENTS = AUTH_ARGUMENTS

export async function resolveCodexCommand(): Promise<string> {
  const configured = process.env.CODEX_CLI_PATH
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, 'codex'))
  const candidates = [
    configured && isAbsolute(configured) ? configured : null,
    ...pathCandidates,
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.codex', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex'
  ]

  for (const candidate of new Set(candidates.filter((value): value is string => Boolean(value)))) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through known installation locations.
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/bin/zsh', ['-lic', 'command -v codex'], {
        timeout: 5_000,
        maxBuffer: 8_192
      })
      const candidate = stdout
        .split('\n')
        .map((line) => line.trim())
        .findLast((line) => isAbsolute(line))
      if (candidate) {
        await access(candidate, constants.X_OK)
        return candidate
      }
    } catch {
      // The auth screen will show the installation guidance.
    }
  }
  return 'codex'
}
