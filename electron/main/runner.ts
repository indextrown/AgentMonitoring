import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgsStringToArgv } from 'string-argv'
import type { EventRecord, TaskRecord } from '../../src/shared/types'
import { isActiveTask } from '../../src/shared/domain'
import { AppStore } from './store'
import { buildCodexEnvironment, CODEX_AUTH_ARGUMENTS } from './codex-auth'

const ALLOWED_TEST_COMMANDS = new Set([
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'bun',
  'xcodebuild',
  'swift',
  'cargo',
  'go',
  'python',
  'python3',
  'pytest',
  'make',
  'cmake',
  'gradle'
])

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

interface ActiveRun {
  child: ChildProcess | null
  stopped: boolean
}

interface ProcessResult {
  code: number
  output: string
  finalMessage: string
}

class StoppedError extends Error {
  constructor() {
    super('사용자가 작업을 중단했습니다.')
  }
}

function redact(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/(?:sk|gho|github_pat|xox[baprs])-[-_A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/Bearer\s+[-._A-Za-z0-9]{16,}/gi, 'Bearer [REDACTED]')
    .slice(0, 8_000)
}

function safeSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 36)
  return slug || 'task'
}

function eventMessage(payload: Record<string, unknown>): string | null {
  const type = String(payload.type ?? '')
  if (type === 'thread.started') return `Codex 세션 시작 · ${String(payload.thread_id ?? '')}`
  if (type === 'turn.started') return 'Codex가 작업을 분석하고 있습니다.'
  if (type === 'turn.completed') return 'Codex 단계가 완료되었습니다.'
  if (type === 'turn.failed' || type === 'error') {
    return `Codex 오류 · ${String(payload.message ?? payload.error ?? '알 수 없는 오류')}`
  }
  if (type === 'item.completed' && payload.item && typeof payload.item === 'object') {
    const item = payload.item as Record<string, unknown>
    if (item.type === 'agent_message' && item.text) return String(item.text)
    if (item.type === 'command_execution') {
      return `명령 실행 완료 · ${String(item.command ?? '')}`
    }
    if (item.type === 'file_change') return '파일 변경을 적용했습니다.'
  }
  return null
}

export class AgentRunner {
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(
    private readonly store: AppStore,
    private readonly worktreesRoot: string,
    private readonly publish: (event: EventRecord) => void,
    private readonly codexCommand = 'codex',
    private readonly codexHome?: string
  ) {}

  isRunning(taskId: string): boolean {
    return this.activeRuns.has(taskId)
  }

  async run(taskId: string): Promise<void> {
    if (this.activeRuns.has(taskId)) throw new Error('이미 실행 중인 작업입니다.')

    let task = this.store.getTask(taskId)
    const project = this.store.getProject(task.projectId)
    if (project.isDemo || project.path.startsWith('demo://')) {
      throw new Error('데모 프로젝트는 실행할 수 없습니다. 실제 Git 프로젝트를 먼저 등록하세요.')
    }
    if (!['queued', 'failed', 'stopped', 'awaiting_approval'].includes(task.status)) {
      throw new Error(`현재 상태에서는 실행할 수 없습니다: ${task.status}`)
    }

    const control: ActiveRun = { child: null, stopped: false }
    this.activeRuns.set(taskId, control)

    try {
      const worktreePath = await this.prepareWorktree(task)
      task = this.store.transitionTask(taskId, 'running', 1)
      this.emit(task, 'task_started', 'orchestrator', `${task.title} 실행 시작`)

      const testDesign = await this.runCodexStage(
        task,
        worktreePath,
        'test-designer',
        'workspace-write',
        [
          `작업 목표: ${task.prompt}`,
          '당신은 테스트 설계자입니다. 프로덕션 구현은 수정하지 마세요.',
          '기존 테스트 구조를 확인하고 이 목표의 성공·실패·경계 조건을 검증하는 테스트만 추가하거나 보완하세요.',
          '테스트를 만들 수 없다면 이유와 필요한 테스트 훅을 최종 메시지에 기록하세요.',
          '커밋, push, merge는 하지 마세요.'
        ].join('\n\n')
      )

      const critique = await this.runCodexStage(
        task,
        worktreePath,
        'critic',
        'read-only',
        [
          `작업 목표: ${task.prompt}`,
          '당신은 읽기 전용 테스트 비평가입니다.',
          '현재 추가된 테스트가 구현 세부사항이 아니라 사용자 요구와 실패 경로를 검증하는지 평가하세요.',
          '누락된 경계 조건과 테스트를 약화해 통과할 수 있는 지점을 짧게 정리하세요.',
          `테스트 설계자 보고:\n${testDesign.finalMessage || '보고 없음'}`
        ].join('\n\n')
      )

      let repairContext = ''
      let testsPassed = project.testCommand.length === 0
      for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
        if (control.stopped) throw new StoppedError()
        if (attempt > 1) {
          this.store.transitionTask(taskId, 'running', attempt)
          this.emit(task, 'agent', 'orchestrator', `자가 수정 ${attempt}/${task.maxAttempts} 시작`)
        }

        await this.runCodexStage(
          this.store.getTask(taskId),
          worktreePath,
          'implementer',
          'workspace-write',
          [
            `작업 목표: ${task.prompt}`,
            '당신은 구현 담당자입니다. 현재 테스트와 프로젝트 규칙을 지키며 목표를 완성하세요.',
            '테스트를 삭제하거나 약화하지 마세요. 관련 없는 파일은 수정하지 마세요.',
            '변경 후 프로젝트에 맞는 검증을 실행하세요. 커밋, push, merge는 하지 마세요.',
            `테스트 비평가 보고:\n${critique.finalMessage || '보고 없음'}`,
            repairContext
          ]
            .filter(Boolean)
            .join('\n\n')
        )

        if (!project.testCommand) {
          this.emit(task, 'agent', 'orchestrator', '테스트 명령이 없어 Codex 자체 검증 결과를 사용합니다.')
          testsPassed = true
          break
        }

        this.store.transitionTask(taskId, 'testing', attempt)
        this.emit(task, 'test_started', 'test-runner', `${project.testCommand} 실행`)
        const testResult = await this.runConfiguredCommand(project.testCommand, worktreePath, control)
        if (testResult.code === 0) {
          testsPassed = true
          this.emit(task, 'test_passed', 'test-runner', '프로젝트 테스트가 모두 통과했습니다.')
          break
        }

        this.emit(
          task,
          'test_failed',
          'test-runner',
          `테스트 실패 · 종료 코드 ${testResult.code}\n${testResult.output.slice(-3_000)}`,
          'high'
        )
        repairContext = [
          '직전 테스트가 실패했습니다. 아래 출력의 원인을 수정하고 기존 테스트를 유지하세요.',
          testResult.output.slice(-4_000)
        ].join('\n\n')
      }

      if (!testsPassed) {
        this.store.transitionTask(taskId, 'failed')
        this.store.addFinding(task.projectId, task.id, `${task.title} 테스트가 재시도 한도를 초과했습니다.`, 'high')
        return
      }

      await this.runCodexStage(
        this.store.getTask(taskId),
        worktreePath,
        'reviewer',
        'read-only',
        [
          `작업 목표: ${task.prompt}`,
          '당신은 최종 읽기 전용 Reviewer입니다.',
          '현재 미커밋 diff, 기존 테스트, 실행 결과를 검토하세요.',
          '기능 오류, 테스트 공백, 보안·회귀 위험을 우선순위와 근거를 붙여 보고하세요.',
          '코드는 수정하지 마세요.'
        ].join('\n\n')
      )

      this.store.transitionTask(taskId, 'awaiting_approval')
      this.emit(task, 'agent', 'orchestrator', '모든 자동 단계가 끝났습니다. 사람의 최종 승인을 기다립니다.')
    } catch (error) {
      const current = this.store.getTask(taskId)
      if (error instanceof StoppedError || control.stopped) {
        if (isActiveTask(current)) this.store.transitionTask(taskId, 'stopped')
        this.emit(current, 'task_stopped', 'human', '작업을 중단했습니다.')
      } else {
        if (isActiveTask(current)) this.store.transitionTask(taskId, 'failed')
        this.emit(current, 'agent', 'orchestrator', `실행 실패 · ${redact(String(error))}`, 'high')
        this.store.addFinding(current.projectId, current.id, `${current.title} 실행 실패`, 'high')
      }
      throw error
    } finally {
      this.activeRuns.delete(taskId)
    }
  }

  async stop(taskId: string): Promise<void> {
    const control = this.activeRuns.get(taskId)
    if (!control) throw new Error('실행 중인 작업이 아닙니다.')
    control.stopped = true
    control.child?.kill('SIGTERM')
  }

  approve(taskId: string): void {
    const task = this.store.transitionTask(taskId, 'completed')
    this.emit(task, 'task_completed', 'human', `${task.title} 변경 승인`)
  }

  async discard(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId)
    if (this.activeRuns.has(taskId)) throw new Error('실행 중인 작업을 먼저 중단하세요.')
    const discarded = this.store.transitionTask(taskId, 'discarded')
    this.emit(discarded, 'task_discarded', 'human', `${task.title} 변경 폐기`)

    if (task.worktreePath) {
      const project = this.store.getProject(task.projectId)
      await this.runProcess('git', ['worktree', 'remove', '--force', task.worktreePath], project.path, null)
    }
  }

  private async prepareWorktree(task: TaskRecord): Promise<string> {
    if (task.worktreePath) {
      try {
        await stat(task.worktreePath)
        return task.worktreePath
      } catch {
        // A missing worktree is recreated below.
      }
    }

    const project = this.store.getProject(task.projectId)
    const projectRoot = resolve(project.path)
    const root = resolve(this.worktreesRoot, task.projectId)
    await mkdir(root, { recursive: true })
    const worktreePath = resolve(root, task.id)
    if (!worktreePath.startsWith(`${root}/`)) throw new Error('안전하지 않은 worktree 경로입니다.')
    const branchName = `agentmonitor/${safeSlug(task.title)}-${task.id.slice(0, 6)}`

    await this.runProcess('git', ['rev-parse', '--is-inside-work-tree'], projectRoot, null)
    await this.runProcess('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], projectRoot, null)
    this.store.setTaskWorkspace(task.id, branchName, worktreePath)
    this.emit(task, 'agent', 'git', `격리 작업공간 생성 · ${basename(worktreePath)} · ${branchName}`)
    return worktreePath
  }

  private async runCodexStage(
    task: TaskRecord,
    cwd: string,
    actor: string,
    sandbox: 'read-only' | 'workspace-write',
    prompt: string
  ): Promise<ProcessResult> {
    const control = this.activeRuns.get(task.id)
    if (!control || control.stopped) throw new StoppedError()
    this.emit(task, 'agent', actor, `${actor} 단계 시작`)

    const result = await this.runProcess(
      this.codexCommand,
      [
        ...(this.codexHome ? CODEX_AUTH_ARGUMENTS : []),
        'exec',
        '--json',
        '--sandbox',
        sandbox,
        '--cd',
        cwd,
        prompt
      ],
      cwd,
      control,
      (line) => {
        try {
          const payload = JSON.parse(line) as Record<string, unknown>
          const message = eventMessage(payload)
          if (message) this.emit(task, 'agent', actor, message)
        } catch {
          if (line.trim()) this.emit(task, 'agent', actor, redact(line))
        }
      },
      this.codexHome ? buildCodexEnvironment(this.codexHome, this.codexCommand) : process.env
    )
    if (result.code !== 0) {
      throw new Error(`${actor} 단계가 종료 코드 ${result.code}로 실패했습니다.\n${result.output.slice(-2_000)}`)
    }
    this.emit(task, 'agent', actor, `${actor} 단계 완료`)
    return result
  }

  private async runConfiguredCommand(commandLine: string, cwd: string, control: ActiveRun): Promise<ProcessResult> {
    const parts = parseArgsStringToArgv(commandLine)
    const command = parts.shift()
    if (!command || !ALLOWED_TEST_COMMANDS.has(command)) {
      throw new Error(`허용되지 않은 테스트 실행 파일입니다: ${command ?? '(비어 있음)'}`)
    }
    return this.runProcess(command, parts, cwd, control)
  }

  private runProcess(
    command: string,
    args: string[],
    cwd: string,
    control: ActiveRun | null,
    onLine?: (line: string) => void,
    environment: NodeJS.ProcessEnv = process.env
  ): Promise<ProcessResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      if (control) control.child = child

      let output = ''
      let finalMessage = ''
      let stdoutBuffer = ''

      const consumeLine = (rawLine: string): void => {
        const line = redact(rawLine)
        output = `${output}${line}\n`.slice(-80_000)
        onLine?.(line)
        try {
          const payload = JSON.parse(line) as Record<string, unknown>
          if (payload.type === 'item.completed' && payload.item && typeof payload.item === 'object') {
            const item = payload.item as Record<string, unknown>
            if (item.type === 'agent_message' && item.text) finalMessage = redact(String(item.text))
          }
        } catch {
          // Non-JSON process output is retained as a plain log.
        }
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8')
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        lines.forEach(consumeLine)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const text = redact(chunk.toString('utf8'))
        output = `${output}${text}`.slice(-80_000)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (stdoutBuffer) consumeLine(stdoutBuffer)
        if (control) control.child = null
        if (control?.stopped) {
          reject(new StoppedError())
          return
        }
        resolvePromise({ code: code ?? 1, output, finalMessage })
      })
    })
  }

  private emit(
    task: TaskRecord,
    kind: Parameters<AppStore['addEvent']>[2],
    actor: string,
    message: string,
    severity: Parameters<AppStore['addEvent']>[5] = null
  ): void {
    const event = this.store.addEvent(task.projectId, task.id, kind, actor, redact(message), severity)
    this.publish(event)
  }
}
