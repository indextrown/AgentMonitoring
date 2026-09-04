import { execFile } from 'node:child_process'

export interface CodexExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  encoding: 'utf8'
  maxBuffer: number
  timeout: number
}

export interface CodexExecResult {
  stdout: string
  stderr: string
}

export class CodexExecTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'

  constructor(timeout: number) {
    super(`Codex 실행이 ${timeout}ms 안에 끝나지 않았습니다.`)
    this.name = 'CodexExecTimeoutError'
  }
}

export function execCodexFile(
  command: string,
  args: string[],
  options: CodexExecOptions
): Promise<CodexExecResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    let timeoutTimer: NodeJS.Timeout | null = null
    let forceKillTimer: NodeJS.Timeout | null = null

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      timeoutTimer = null
      forceKillTimer = null
    }

    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: options.encoding,
        maxBuffer: options.maxBuffer
      },
      (error, stdout, stderr) => {
        clearTimers()
        if (timedOut) {
          reject(new CodexExecTimeoutError(options.timeout))
          return
        }
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )

    // `codex exec` treats an open non-TTY stdin as additional piped input and waits for EOF.
    child.stdin?.end()

    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 1_500)
    }, Math.max(1, options.timeout))
  })
}
