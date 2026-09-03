import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgsStringToArgv } from 'string-argv'
import type {
  EventRecord,
  ProjectRecord,
  RuntimeSessionStatus,
  Severity,
  StorageCleanupInput,
  StorageCleanupResult,
  StorageOverview,
  StoragePolicy,
  TaskChanges,
  TaskRecord
} from '../../src/shared/types'
import { isActiveTask } from '../../src/shared/domain'
import { AppStore } from './store'
import { buildCodexEnvironment, CODEX_AUTH_ARGUMENTS } from './codex-auth'
import {
  IosRuntimeStageError,
  iosSimulatorRuntimeAdapter,
  type IosSimulatorRuntimeAdapter,
  type RuntimeCommandRequest
} from './ios-simulator-runtime'
import { projectCapabilityManifestSchema, readProjectCapabilityManifest } from './project-capabilities'
import {
  evaluateRuntimeAcceptance,
  summarizeRuntimeAcceptance,
  writeRuntimeAcceptanceEvidence
} from './runtime-acceptance'

const ALLOWED_TEST_COMMANDS = new Set([
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'bun',
  'tuist',
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
  termination: Promise<void> | null
  done: Promise<void>
  resolveDone: () => void
}

interface ProcessResult {
  code: number
  output: string
  stdout: string
  finalMessage: string
}

interface ProcessDeadline {
  timeoutMs: number
  label: string
}

interface RuntimeRunResult {
  summary: string
  reviewContext: string
  imagePaths: string[]
}

const MAX_ACCESSIBILITY_REVIEW_CHARS = 60_000
const MAX_UI_ACTION_REVIEW_CHARS = 20_000
const MAX_DEBUG_STATE_REVIEW_CHARS = 60_000
const MAX_RUNTIME_VERIFICATION_REVIEW_CHARS = 40_000
const MAX_RUNTIME_REPAIR_CONTEXT_CHARS = 120_000
const TERMINAL_TASK_STATUSES = new Set<TaskRecord['status']>(['completed', 'discarded'])

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function directorySize(path: string): Promise<number> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) return stats.size
  const entries = await readdir(path, { withFileTypes: true })
  let total = 0
  for (const entry of entries) total += await directorySize(join(path, entry.name))
  return total
}

export interface RunnerPolicy {
  codexStageTimeoutMs: number
  testCommandTimeoutMs: number
  terminationGraceMs: number
}

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = {
  codexStageTimeoutMs: 30 * 60_000,
  testCommandTimeoutMs: 45 * 60_000,
  terminationGraceMs: 3_000
}

class StoppedError extends Error {
  constructor() {
    super('사용자가 작업을 중단했습니다.')
  }
}

class RuntimeAcceptanceStageError extends IosRuntimeStageError {
  constructor(
    message: string,
    readonly repairContext: string,
    readonly imagePaths: string[]
  ) {
    super('verifying', message)
  }
}

class ProcessTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number
  ) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000))
    const duration = seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`
    super(`${label} 제한 시간 초과 (${duration})`)
  }
}

function redact(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/(?:sk|gho|github_pat|xox[baprs])-[-_A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/Bearer\s+[-._A-Za-z0-9]{16,}/gi, 'Bearer [REDACTED]')
    .slice(0, 8_000)
}

export function parseReviewerFindings(report: string): Array<{ severity: Severity; title: string }> {
  const findings: Array<{ severity: Severity; title: string }> = []
  const seen = new Set<string>()
  for (const line of report.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?\[(critical|high|medium|low)]\s+(.+?)\s*$/i)
    if (!match) continue
    const severity = match[1].toLowerCase() as Severity
    const title = match[2].trim().slice(0, 500)
    const key = `${severity}:${title.toLowerCase()}`
    if (!title || seen.has(key)) continue
    seen.add(key)
    findings.push({ severity, title })
    if (findings.length >= 20) break
  }
  return findings
}

export function parseConfiguredCommand(commandLine: string): { command: string; args: string[] } {
  const parts = parseArgsStringToArgv(commandLine)
  const command = parts.shift()
  if (!command || !ALLOWED_TEST_COMMANDS.has(command)) {
    throw new Error(`허용되지 않은 테스트 실행 파일입니다: ${command ?? '(비어 있음)'}`)
  }
  return { command, args: parts }
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

function runtimeContractPrompt(task: TaskRecord): string {
  if (!task.runtimeContract) return '이 작업에는 별도로 승인된 Simulator 검증 시나리오가 없습니다.'
  return [
    '아래 JSON은 사람이 작업 등록 전에 승인한 고정 Simulator 검증 계약입니다.',
    '계약의 accessibility identifier를 제품 코드에 구현하되, 계약 자체를 수정하거나 검증을 우회하지 마세요.',
    '```json',
    JSON.stringify(task.runtimeContract, null, 2),
    '```'
  ].join('\n')
}

export class AgentRunner {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly managedRuntimeTaskIds = new Set<string>()
  private readonly policy: RunnerPolicy
  private readonly runtimeRoot: string

  constructor(
    private readonly store: AppStore,
    private readonly worktreesRoot: string,
    private readonly publish: (event: EventRecord) => void,
    private readonly codexCommand = 'codex',
    private readonly codexHome?: string,
    policy: Partial<RunnerPolicy> = {},
    private readonly runtimeAdapter: IosSimulatorRuntimeAdapter = iosSimulatorRuntimeAdapter
  ) {
    this.policy = { ...DEFAULT_RUNNER_POLICY, ...policy }
    this.runtimeRoot = resolve(this.worktreesRoot, '..', 'runtime-sessions')
  }

  isRunning(taskId: string): boolean {
    return this.activeRuns.has(taskId)
  }

  async getChanges(taskId: string): Promise<TaskChanges> {
    const task = this.store.getTask(taskId)
    if (!task.worktreePath) {
      return { taskId, available: false, files: [], stat: '', patch: '', truncated: false }
    }

    try {
      await stat(task.worktreePath)
    } catch {
      return { taskId, available: false, files: [], stat: '', patch: '', truncated: false }
    }

    const project = this.store.getProject(task.projectId)
    const projectHead = await this.requireGit(['rev-parse', 'HEAD'], project.path, '원본 기준 commit을 확인할 수 없습니다.')
    const mergeBase = await this.requireGit(
      ['merge-base', 'HEAD', projectHead.output.trim()],
      task.worktreePath,
      '작업 변경의 공통 기준 commit을 확인할 수 없습니다.'
    )
    const baseCommit = mergeBase.output.trim()
    const [statusResult, numstatResult, statResult, patchResult] = await Promise.all([
      this.requireGit(
        ['status', '--short', '--untracked-files=all'],
        task.worktreePath,
        '작업 변경 파일을 확인할 수 없습니다.'
      ),
      this.requireGit(['diff', '--numstat', baseCommit, '--'], task.worktreePath, '작업 변경 통계를 확인할 수 없습니다.'),
      this.requireGit(['diff', '--stat', baseCommit, '--'], task.worktreePath, '작업 변경 요약을 확인할 수 없습니다.'),
      this.requireGit(
        ['diff', '--no-ext-diff', '--unified=3', baseCommit, '--'],
        task.worktreePath,
        '작업 diff를 확인할 수 없습니다.'
      )
    ])

    const counts = new Map<string, { additions: number | null; deletions: number | null }>()
    for (const line of numstatResult.output.split(/\r?\n/)) {
      const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t')
      if (!path) continue
      counts.set(path, {
        additions: rawAdditions === '-' ? null : Number(rawAdditions),
        deletions: rawDeletions === '-' ? null : Number(rawDeletions)
      })
    }

    const statusLines = statusResult.output.split(/\r?\n/).filter(Boolean)
    let combinedPatch = patchResult.output
    let truncated = patchResult.output.length >= 79_000
    for (const line of statusLines.filter((item) => item.startsWith('?? '))) {
      const path = line.slice(3).trim()
      const absolutePath = resolve(task.worktreePath, path)
      if (!absolutePath.startsWith(`${resolve(task.worktreePath)}/`)) continue
      const [untrackedNumstat, untrackedPatch] = await Promise.all([
        this.runProcess('git', ['diff', '--no-index', '--numstat', '--', '/dev/null', absolutePath], task.worktreePath, null),
        this.runProcess(
          'git',
          ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', '/dev/null', absolutePath],
          task.worktreePath,
          null
        )
      ])
      if (![0, 1].includes(untrackedNumstat.code) || ![0, 1].includes(untrackedPatch.code)) continue
      const [rawAdditions, rawDeletions] = untrackedNumstat.output.trim().split('\t')
      counts.set(path, {
        additions: rawAdditions === '-' ? null : Number(rawAdditions),
        deletions: rawDeletions === '-' ? null : Number(rawDeletions)
      })
      const normalizedPatch = untrackedPatch.output
        .split(absolutePath)
        .join(path)
        .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
        .replace(/^\+\+\+ .*$/m, `+++ b/${path}`)
      const nextPatch = [combinedPatch.trimEnd(), normalizedPatch.trim()].filter(Boolean).join('\n')
      if (nextPatch.length > 79_000) truncated = true
      combinedPatch = nextPatch.slice(0, 79_000)
    }

    const fileMap = new Map<string, TaskChanges['files'][number]>()
    for (const line of statusLines) {
      const path = line.slice(3).trim()
      const count = counts.get(path)
      fileMap.set(path, {
        path,
        status: line.slice(0, 2).trim() || 'M',
        additions: count?.additions ?? null,
        deletions: count?.deletions ?? null
      })
    }
    for (const [path, count] of counts) {
      if (fileMap.has(path)) continue
      fileMap.set(path, { path, status: 'M', additions: count.additions, deletions: count.deletions })
    }
    const files = [...fileMap.values()].sort((left, right) => left.path.localeCompare(right.path))
    const untrackedCount = statusLines.filter((line) => line.startsWith('?? ')).length
    const statSummary = [
      statResult.output.trim(),
      untrackedCount > 0 ? `${untrackedCount} untracked ${untrackedCount === 1 ? 'file' : 'files'}` : ''
    ].filter(Boolean).join('\n')

    return {
      taskId,
      available: true,
      files,
      stat: statSummary,
      patch: combinedPatch,
      truncated
    }
  }

  async run(taskId: string): Promise<void> {
    if (this.activeRuns.has(taskId)) throw new Error('이미 실행 중인 작업입니다.')

    let task = this.store.getTask(taskId)
    const project = this.store.getProject(task.projectId)
    if (project.isDemo || project.path.startsWith('demo://')) {
      throw new Error('데모 프로젝트는 실행할 수 없습니다. 실제 Git 프로젝트를 먼저 등록하세요.')
    }
    if (!project.testCommand.trim()) {
      throw new Error('프로젝트 설정에서 검증 명령을 등록한 뒤 작업을 실행하세요.')
    }
    if (!['queued', 'failed', 'stopped', 'awaiting_approval'].includes(task.status)) {
      throw new Error(`현재 상태에서는 실행할 수 없습니다: ${task.status}`)
    }

    let resolveDone = (): void => undefined
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise
    })
    const control: ActiveRun = { child: null, stopped: false, termination: null, done, resolveDone }
    const runId = randomUUID()
    this.activeRuns.set(taskId, control)

    try {
      const worktreePath = await this.prepareWorktree(task)
      task = this.store.transitionTask(taskId, 'running', 1)
      this.emit(task, 'task_started', 'orchestrator', `${task.title} 실행 시작`)
      const approvedRuntimeContract = runtimeContractPrompt(task)

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
          approvedRuntimeContract,
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
      let repairImagePaths: string[] = []
      let automationPassed = false
      let runtimeResult: RuntimeRunResult | null = null
      for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
        if (control.stopped) throw new StoppedError()
        if (attempt > 1) {
          this.store.transitionTask(taskId, 'running', attempt)
          this.emit(
            this.store.getTask(taskId),
            'agent',
            'orchestrator',
            `자가 수정 ${attempt}/${task.maxAttempts} 시작`
          )
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
            approvedRuntimeContract,
            '변경 후 프로젝트에 맞는 검증을 실행하세요. 커밋, push, merge는 하지 마세요.',
            `테스트 비평가 보고:\n${critique.finalMessage || '보고 없음'}`,
            repairContext
          ]
            .filter(Boolean)
            .join('\n\n'),
          repairImagePaths
        )

        this.store.transitionTask(taskId, 'testing', attempt)
        this.emit(task, 'test_started', 'test-runner', `${project.testCommand} 실행`)
        const testResult = await this.runConfiguredCommand(project.testCommand, worktreePath, control)
        if (testResult.code === 0) {
          this.emit(task, 'test_passed', 'test-runner', '프로젝트 테스트가 모두 통과했습니다.')
          try {
            runtimeResult = await this.runRuntimeIfConfigured(
              this.store.getTask(taskId),
              project,
              worktreePath,
              control,
              runId
            )
            automationPassed = true
            break
          } catch (error) {
            if (!(error instanceof RuntimeAcceptanceStageError) || attempt >= task.maxAttempts) {
              throw error
            }
            const currentTask = this.store.getTask(taskId)
            await this.stopRuntimeSession(
              currentTask,
              'failed',
              'runtime acceptance 실패 후 자가 수정을 위해 Simulator 앱을 정리했습니다.'
            )
            repairContext = [
              '직전 runtime acceptance 검증이 실패했습니다.',
              '아래 증거에서 기대값과 실제값의 차이를 찾아 제품 코드를 수정하세요.',
              '합격 조건은 작업 등록 때 승인된 스냅샷에서 다시 읽으므로 assertion을 수정하거나 약화하지 마세요.',
              error.repairContext
            ].join('\n\n')
            repairImagePaths = error.imagePaths
            this.emit(
              currentTask,
              'runtime_repair_started',
              'orchestrator',
              `runtime 실패 증거를 Implementer에 전달 · 다음 시도 ${attempt + 1}/${task.maxAttempts}`
            )
          }
          continue
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
        repairImagePaths = []
      }

      if (!automationPassed) {
        this.store.transitionTask(taskId, 'failed')
        this.store.addFinding(task.projectId, task.id, `${task.title} 테스트가 재시도 한도를 초과했습니다.`, 'high')
        return
      }

      this.store.resolveTaskFindings(task.id)
      const review = await this.runCodexStage(
        this.store.getTask(taskId),
        worktreePath,
        'reviewer',
        'read-only',
        [
          `작업 목표: ${task.prompt}`,
          '당신은 최종 읽기 전용 Reviewer입니다.',
          '현재 미커밋 diff, 기존 테스트, 실행 결과를 검토하세요.',
          approvedRuntimeContract,
          runtimeResult
            ? [
                `Swift runtime 결과:\n${runtimeResult.summary}`,
                runtimeResult.reviewContext
              ].filter(Boolean).join('\n\n')
            : '이 프로젝트는 Swift runtime 실행 대상이 아닙니다.',
          runtimeResult?.imagePaths.length
            ? '첨부된 이미지는 이 작업이 선택한 iOS Simulator에서 수집한 화면 증거입니다. 요구사항과 명백히 어긋나는 화면 결함도 검토하세요.'
            : '',
          '기능 오류, 테스트 공백, 보안·회귀 위험을 우선순위와 근거를 붙여 보고하세요.',
          '최종 메시지는 문제가 없으면 `VERDICT: PASS`를 포함하세요.',
          '문제가 있으면 각 항목을 `[critical] 제목`, `[high] 제목`, `[medium] 제목`, `[low] 제목` 형식으로 한 줄씩 작성하세요.',
          '코드는 수정하지 마세요.'
        ].filter(Boolean).join('\n\n'),
        runtimeResult?.imagePaths ?? []
      )
      for (const finding of parseReviewerFindings(review.finalMessage)) {
        this.store.addFinding(task.projectId, task.id, finding.title, finding.severity)
      }

      if (control.stopped) throw new StoppedError()
      this.store.transitionTask(taskId, 'awaiting_approval')
      this.emit(task, 'agent', 'orchestrator', '모든 자동 단계가 끝났습니다. 사람의 최종 승인을 기다립니다.')
    } catch (error) {
      const current = this.store.getTask(taskId)
      if (error instanceof StoppedError || control.stopped) {
        await this.stopRuntimeSession(current, 'stopped', '사용자가 작업을 중단해 Simulator 앱을 종료했습니다.')
        if (isActiveTask(current)) this.store.transitionTask(taskId, 'stopped')
        this.emit(current, 'task_stopped', 'human', '작업을 중단했습니다.')
      } else if (error instanceof ProcessTimeoutError) {
        await this.stopRuntimeSession(current, 'failed', '시간 초과로 Simulator 앱을 종료했습니다.')
        if (isActiveTask(current)) this.store.transitionTask(taskId, 'failed')
        this.emit(current, 'task_timed_out', 'orchestrator', `시간 초과 · ${error.message}`, 'high')
        this.store.addFinding(current.projectId, current.id, `${current.title} · ${error.label} 시간 초과`, 'high')
      } else if (error instanceof IosRuntimeStageError) {
        await this.stopRuntimeSession(current, 'failed', error.message)
        if (isActiveTask(current)) this.store.transitionTask(taskId, 'failed')
        this.store.addFinding(
          current.projectId,
          current.id,
          `${current.title} · Swift runtime ${error.status} 단계 실패`,
          'high'
        )
      } else {
        await this.stopRuntimeSession(current, 'failed', '작업 실패로 Simulator 앱을 종료했습니다.')
        if (isActiveTask(current)) this.store.transitionTask(taskId, 'failed')
        this.emit(current, 'agent', 'orchestrator', `실행 실패 · ${redact(String(error))}`, 'high')
        this.store.addFinding(current.projectId, current.id, `${current.title} 실행 실패`, 'high')
      }
      throw error
    } finally {
      this.activeRuns.delete(taskId)
      control.resolveDone()
    }
  }

  async stop(taskId: string): Promise<void> {
    const control = this.activeRuns.get(taskId)
    if (!control) throw new Error('실행 중인 작업이 아닙니다.')
    control.stopped = true
    await this.terminateControl(control)
    await control.done
  }

  async dispose(): Promise<void> {
    const controls = [...this.activeRuns.values()]
    for (const control of controls) control.stopped = true
    await Promise.all(controls.map((control) => this.terminateControl(control)))
    await Promise.all(controls.map((control) => control.done))
    for (const taskId of [...this.managedRuntimeTaskIds]) {
      await this.stopRuntimeSession(
        this.store.getTask(taskId),
        'stopped',
        'AgentMonitoring 종료로 Simulator 앱을 정리했습니다.'
      )
    }
  }

  async getStorageOverview(): Promise<StorageOverview> {
    const tasks = this.store.listAllTasks()
    const runtimePaths = await this.listChildren(this.runtimeRoot)
    const runtimeRecordTaskIds = new Set([
      ...this.store.listRuntimeSessions().map((session) => session.taskId),
      ...this.store.listRuntimeEvidence().map((evidence) => evidence.taskId)
    ])
    const runtimeArtifactTaskIds = new Set([
      ...runtimePaths.map((path) => basename(path)),
      ...runtimeRecordTaskIds
    ])
    const orphanWorktrees = await this.findOrphanWorktrees(tasks)
    const existingWorktrees = await Promise.all(
      tasks.map(async (task) => {
        if (!task.worktreePath) return null
        return await pathExists(task.worktreePath) ? task.worktreePath : null
      })
    )
    const cleanupCandidateCount = orphanWorktrees.length + tasks.filter((task) =>
      Boolean(task.worktreePath) && TERMINAL_TASK_STATUSES.has(task.status)
    ).length + [...runtimeArtifactTaskIds].filter((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId)
      return !task || this.shouldRemoveRuntimeArtifacts(task)
    }).length
    const branchCandidateCount = tasks.filter((task) =>
      TERMINAL_TASK_STATUSES.has(task.status) &&
      !task.worktreePath &&
      task.branchName?.startsWith('agentmonitor/')
    ).length
    const [worktreeBytes, runtimeArtifactBytes] = await Promise.all([
      directorySize(this.worktreesRoot),
      directorySize(this.runtimeRoot)
    ])

    return {
      policy: { runtimeArtifactRetentionDays: this.store.getRuntimeArtifactRetentionDays() },
      worktreeBytes,
      runtimeArtifactBytes,
      totalBytes: worktreeBytes + runtimeArtifactBytes,
      worktreeCount: existingWorktrees.filter(Boolean).length + orphanWorktrees.length,
      runtimeArtifactCount: runtimeArtifactTaskIds.size,
      cleanupCandidateCount,
      branchCandidateCount,
      scannedAt: new Date().toISOString()
    }
  }

  async setStoragePolicy(policy: StoragePolicy): Promise<StorageOverview> {
    this.store.setRuntimeArtifactRetentionDays(policy.runtimeArtifactRetentionDays)
    return this.getStorageOverview()
  }

  async cleanupStorage(input: StorageCleanupInput): Promise<StorageCleanupResult> {
    const before = await this.getStorageOverview()
    const warnings: string[] = []
    let worktreesRemoved = 0
    let runtimeArtifactsRemoved = 0
    let branchesRemoved = 0
    const tasks = this.store.listAllTasks()

    for (const task of tasks) {
      if (task.worktreePath && !(await pathExists(task.worktreePath))) {
        this.store.clearTaskWorktree(task.id)
        continue
      }
      if (task.worktreePath && TERMINAL_TASK_STATUSES.has(task.status)) {
        try {
          await this.cleanupTaskWorktree(task, true)
          worktreesRemoved += 1
        } catch (error) {
          warnings.push(`${task.title}: ${String(error).replace(/^Error:\s*/, '')}`)
        }
      }
    }

    for (const orphanPath of await this.findOrphanWorktrees(this.store.listAllTasks())) {
      try {
        await this.removeManagedPath(orphanPath, this.worktreesRoot)
        worktreesRemoved += 1
      } catch (error) {
        warnings.push(`연결이 끊긴 작업공간: ${String(error).replace(/^Error:\s*/, '')}`)
      }
    }

    const refreshedTasks = this.store.listAllTasks()
    const taskById = new Map(refreshedTasks.map((task) => [task.id, task]))
    const runtimePaths = await this.listChildren(this.runtimeRoot)
    const runtimePathTaskIds = new Set(runtimePaths.map((path) => basename(path)))
    for (const runtimePath of runtimePaths) {
      const task = taskById.get(basename(runtimePath))
      if (task && !this.shouldRemoveRuntimeArtifacts(task)) continue
      try {
        await this.removeManagedPath(runtimePath, this.runtimeRoot)
        if (task) this.store.deleteRuntimeData(task.id)
        runtimeArtifactsRemoved += 1
      } catch (error) {
        warnings.push(`실행 증거 ${basename(runtimePath)}: ${String(error).replace(/^Error:\s*/, '')}`)
      }
    }
    const recordedRuntimeTaskIds = new Set([
      ...this.store.listRuntimeSessions().map((session) => session.taskId),
      ...this.store.listRuntimeEvidence().map((evidence) => evidence.taskId)
    ])
    for (const task of refreshedTasks) {
      if (!this.shouldRemoveRuntimeArtifacts(task) || runtimePathTaskIds.has(task.id) || !recordedRuntimeTaskIds.has(task.id)) {
        continue
      }
      this.store.deleteRuntimeData(task.id)
      runtimeArtifactsRemoved += 1
    }

    if (input.removeLocalBranches) {
      for (const task of this.store.listAllTasks()) {
        if (!TERMINAL_TASK_STATUSES.has(task.status) || task.worktreePath || !task.branchName?.startsWith('agentmonitor/')) {
          continue
        }
        try {
          if (await this.cleanupTaskBranch(task)) branchesRemoved += 1
        } catch (error) {
          warnings.push(`${task.title} 브랜치: ${String(error).replace(/^Error:\s*/, '')}`)
        }
      }
    }

    for (const project of this.store.listProjects()) {
      if (!(await pathExists(project.path))) continue
      await this.runProcess('git', ['worktree', 'prune'], project.path, null)
    }

    const overview = await this.getStorageOverview()
    return {
      worktreesRemoved,
      runtimeArtifactsRemoved,
      branchesRemoved,
      bytesReclaimed: Math.max(0, before.totalBytes - overview.totalBytes),
      warnings,
      overview
    }
  }

  async reconcileStorage(): Promise<StorageCleanupResult> {
    return this.cleanupStorage({ removeLocalBranches: false })
  }

  async approve(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId)
    if (task.status !== 'awaiting_approval') throw new Error('승인 대기 중인 작업만 원본에 적용할 수 있습니다.')
    if (this.activeRuns.has(taskId)) throw new Error('실행 중인 작업을 먼저 중단하세요.')
    if (!task.worktreePath || !task.branchName) throw new Error('적용할 격리 작업공간을 찾을 수 없습니다.')

    await this.stopRuntimeSession(task, 'stopped', '작업 승인으로 Simulator 앱을 정리했습니다.')

    const project = this.store.getProject(task.projectId)
    const projectRoot = resolve(project.path)
    const worktreePath = resolve(task.worktreePath)
    const targetBranch = await this.requireGit(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      projectRoot,
      '원본 저장소가 브랜치를 checkout한 상태인지 확인할 수 없습니다.'
    )
    await this.assertCleanCheckout(projectRoot)

    const worktreeBranch = await this.requireGit(
      ['branch', '--show-current'],
      worktreePath,
      '작업 브랜치를 확인할 수 없습니다.'
    )
    if (worktreeBranch.output.trim() !== task.branchName) {
      throw new Error('격리 작업공간의 현재 브랜치가 등록된 작업 브랜치와 다릅니다.')
    }

    const worktreeStatus = await this.requireGit(
      ['status', '--porcelain', '--untracked-files=normal'],
      worktreePath,
      '작업 변경 상태를 확인할 수 없습니다.'
    )
    if (worktreeStatus.output.trim()) {
      await this.requireGit(['add', '--all'], worktreePath, '작업 변경을 stage할 수 없습니다.')
      await this.requireGit(
        [
          '-c',
          'user.name=AgentMonitoring',
          '-c',
          'user.email=agentmonitoring@localhost',
          'commit',
          '-m',
          `agent: ${task.title}`.slice(0, 120)
        ],
        worktreePath,
        '작업 브랜치 커밋에 실패했습니다.'
      )
      this.emit(task, 'agent', 'git', `작업 변경 커밋 · ${task.branchName}`)
    }

    await this.assertCleanCheckout(projectRoot)
    const mergeResult = await this.runProcess('git', ['merge', '--ff-only', task.branchName], projectRoot, null)
    if (mergeResult.code !== 0) {
      throw new Error(
        `원본 ${targetBranch.output.trim()} 브랜치가 작업 시작 이후 변경되어 fast-forward 적용할 수 없습니다. ` +
          '원본 브랜치와 작업 브랜치를 직접 정리한 뒤 다시 승인하세요.'
      )
    }

    const completed = this.store.transitionTask(taskId, 'completed')
    this.emit(completed, 'task_completed', 'human', `${task.title} 변경을 원본 ${targetBranch.output.trim()} 브랜치에 적용`)

    try {
      await this.cleanupTaskWorktree(completed, false)
      this.emit(completed, 'agent', 'git', '승인된 격리 작업공간 정리 완료')
    } catch (error) {
      this.emit(completed, 'agent', 'git', `격리 작업공간 정리 실패 · ${String(error).slice(-1_000)}`, 'low')
    }
    await this.removeRuntimeArtifactsWhenExpired(this.store.getTask(taskId))
  }

  async discard(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId)
    if (this.activeRuns.has(taskId)) throw new Error('실행 중인 작업을 먼저 중단하세요.')
    await this.stopRuntimeSession(task, 'stopped', '작업 폐기로 Simulator 앱을 정리했습니다.')
    await this.cleanupTaskWorktree(task, true)
    const discarded = this.store.transitionTask(taskId, 'discarded')
    this.emit(discarded, 'task_discarded', 'human', `${task.title} 변경 폐기`)
    await this.removeRuntimeArtifactsWhenExpired(discarded)
  }

  async removeProject(projectId: string): Promise<void> {
    this.store.getProject(projectId)
    const tasks = this.store.listTasks(projectId)
    if (tasks.some((task) => this.activeRuns.has(task.id))) {
      throw new Error('실행 중인 작업이 있는 프로젝트는 제거할 수 없습니다.')
    }

    for (const task of tasks) {
      await this.stopRuntimeSession(task, 'stopped', '프로젝트 연결 삭제로 Simulator 앱을 정리했습니다.')
    }

    for (const task of tasks) {
      if (!task.worktreePath) continue
      await this.cleanupTaskWorktree(task, true)
    }

    for (const task of tasks) {
      await this.removeRuntimeArtifacts(task.id)
      this.store.deleteRuntimeData(task.id)
    }

    this.store.deleteProject(projectId)
  }

  private async removeRuntimeArtifacts(taskId: string): Promise<void> {
    const runtimeRoot = resolve(this.runtimeRoot)
    const sessionPath = resolve(runtimeRoot, taskId)
    if (!isPathInside(runtimeRoot, sessionPath)) {
      throw new Error('안전하지 않은 runtime session 정리 경로입니다.')
    }
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(sessionPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await rm(sessionPath, {
      recursive: stats.isDirectory() && !stats.isSymbolicLink(),
      force: true
    })
  }

  private shouldRemoveRuntimeArtifacts(task: TaskRecord): boolean {
    if (!TERMINAL_TASK_STATUSES.has(task.status)) return false
    const retentionDays = this.store.getRuntimeArtifactRetentionDays()
    if (retentionDays === 0) return true
    return new Date(task.updatedAt).getTime() <= Date.now() - retentionDays * 86_400_000
  }

  private async removeRuntimeArtifactsWhenExpired(task: TaskRecord): Promise<void> {
    if (!this.shouldRemoveRuntimeArtifacts(task)) return
    await this.removeRuntimeArtifacts(task.id)
    this.store.deleteRuntimeData(task.id)
  }

  private async cleanupTaskWorktree(task: TaskRecord, force: boolean): Promise<void> {
    if (!task.worktreePath) return
    const worktreePath = resolve(task.worktreePath)
    if (!isPathInside(this.worktreesRoot, worktreePath)) {
      throw new Error('안전하지 않은 격리 작업공간 정리 경로입니다.')
    }
    if (!(await pathExists(worktreePath))) {
      this.store.clearTaskWorktree(task.id)
      return
    }

    const project = this.store.getProject(task.projectId)
    if (await pathExists(project.path)) {
      const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]
      const result = await this.runProcess('git', args, project.path, null)
      if (result.code !== 0) {
        throw new Error(`격리 작업공간을 정리하지 못했습니다.\n${result.output.slice(-2_000)}`)
      }
    } else {
      await this.removeManagedPath(worktreePath, this.worktreesRoot)
    }

    if (await pathExists(worktreePath)) throw new Error('격리 작업공간이 디스크에 남아 있습니다.')
    this.store.clearTaskWorktree(task.id)
  }

  private async cleanupTaskBranch(task: TaskRecord): Promise<boolean> {
    if (!task.branchName?.startsWith('agentmonitor/')) return false
    const project = this.store.getProject(task.projectId)
    if (!(await pathExists(project.path))) throw new Error('원본 저장소를 찾을 수 없습니다.')
    const exists = await this.runProcess(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${task.branchName}`],
      project.path,
      null
    )
    if (exists.code !== 0) {
      this.store.clearTaskBranch(task.id)
      return false
    }
    const result = await this.runProcess(
      'git',
      ['branch', task.status === 'discarded' ? '-D' : '-d', task.branchName],
      project.path,
      null
    )
    if (result.code !== 0) throw new Error(result.output.slice(-2_000) || '로컬 브랜치를 삭제하지 못했습니다.')
    this.store.clearTaskBranch(task.id)
    return true
  }

  private async listChildren(root: string): Promise<string[]> {
    try {
      return (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => resolve(root, entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async findOrphanWorktrees(tasks: TaskRecord[]): Promise<string[]> {
    const referenced = new Set(tasks.flatMap((task) => task.worktreePath ? [resolve(task.worktreePath)] : []))
    const orphans: string[] = []
    for (const topLevelPath of await this.listChildren(this.worktreesRoot)) {
      if (referenced.has(topLevelPath)) continue
      const descendants = [...referenced].filter((path) => isPathInside(topLevelPath, path))
      if (descendants.length === 0) {
        orphans.push(topLevelPath)
        continue
      }
      for (const childPath of await this.listChildren(topLevelPath)) {
        if (!referenced.has(childPath)) orphans.push(childPath)
      }
    }
    return orphans
  }

  private async removeManagedPath(path: string, root: string): Promise<void> {
    const resolvedPath = resolve(path)
    if (!isPathInside(root, resolvedPath)) throw new Error('안전하지 않은 저장 공간 정리 경로입니다.')
    const stats = await lstat(resolvedPath)
    await rm(resolvedPath, { recursive: stats.isDirectory() && !stats.isSymbolicLink(), force: true })
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
    prompt: string,
    imagePaths: string[] = []
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
        ...imagePaths.flatMap((path) => ['--image', path]),
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
      this.codexHome ? buildCodexEnvironment(this.codexHome, this.codexCommand) : process.env,
      { timeoutMs: this.policy.codexStageTimeoutMs, label: `${actor} 단계` }
    )
    if (result.code !== 0) {
      throw new Error(`${actor} 단계가 종료 코드 ${result.code}로 실패했습니다.\n${result.output.slice(-2_000)}`)
    }
    this.emit(task, 'agent', actor, `${actor} 단계 완료`)
    return result
  }

  private async runConfiguredCommand(commandLine: string, cwd: string, control: ActiveRun): Promise<ProcessResult> {
    const { command, args } = parseConfiguredCommand(commandLine)
    return this.runProcess(command, args, cwd, control, undefined, process.env, {
      timeoutMs: this.policy.testCommandTimeoutMs,
      label: `검증 명령 (${commandLine})`
    })
  }

  private async runRuntimeIfConfigured(
    task: TaskRecord,
    project: ProjectRecord,
    worktreePath: string,
    control: ActiveRun,
    runId: string
  ): Promise<RuntimeRunResult | null> {
    const manifest = task.runtimeContract
      ? { state: 'valid' as const, value: projectCapabilityManifestSchema.parse(task.runtimeContract) }
      : await readProjectCapabilityManifest(project.path)
    if (manifest.state === 'missing') return null
    if (manifest.state === 'invalid') {
      this.emit(
        task,
        'runtime_failed',
        'runtime',
        `Swift runtime 계약 오류로 앱 실행을 건너뜁니다. ${manifest.message}`,
        'low'
      )
      return null
    }
    if (!manifest.value.capabilities.build || !manifest.value.capabilities.run) return null

    const startMessage = '작업 전용 Swift runtime session을 준비합니다.'
    this.store.setRuntimeSession(task.id, 'preparing', {
      deviceId: null,
      deviceName: null,
      bundleIdentifier: null,
      processId: null,
      message: startMessage
    })
    this.managedRuntimeTaskIds.add(task.id)
    this.emit(task, 'runtime_started', 'runtime', startMessage)

    try {
      const uiActions = manifest.value.capabilities.act.includes('ui')
        ? manifest.value.runtimeScenario?.actions ?? []
        : []
      const debugBridge = manifest.value.debugBridge ?? null
      const debugFixture = debugBridge && manifest.value.capabilities.act.includes('fixture')
        ? manifest.value.runtimeScenario?.fixture ?? null
        : null
      const captureState = Boolean(
        debugBridge && manifest.value.capabilities.observe.includes('state')
      )
      const result = await this.runtimeAdapter.launch({
        taskId: task.id,
        worktreePath,
        runtimeRoot: this.runtimeRoot,
        contract: manifest.value.adapter,
        captureScreen: manifest.value.capabilities.observe.includes('screen'),
        captureAccessibility: manifest.value.capabilities.observe.includes('accessibility'),
        captureState,
        uiActions,
        debugBridge,
        debugFixture,
        execute: (request) => this.executeRuntimeCommand(request, control),
        onProgress: (status, message, update = {}) => {
          this.store.setRuntimeSession(task.id, status, { ...update, message })
          this.emit(task, 'runtime_started', 'runtime', message)
        }
      })
      if (manifest.value.capabilities.observe.includes('screen') && !result.screenEvidence) {
        throw new IosRuntimeStageError('observing', '화면 관찰 계약이 활성화됐지만 화면 증거가 생성되지 않았습니다.')
      }
      if (
        manifest.value.capabilities.observe.includes('accessibility') &&
        !result.accessibilityEvidence
      ) {
        throw new IosRuntimeStageError(
          'observing',
          '접근성 관찰 계약이 활성화됐지만 접근성 트리가 생성되지 않았습니다.'
        )
      }
      if (uiActions.length > 0 && !result.uiActionEvidence) {
        throw new IosRuntimeStageError(
          'acting',
          'UI 조작 계약이 활성화됐지만 action 결과가 생성되지 않았습니다.'
        )
      }
      if ((debugFixture || captureState) && !result.debugStateEvidence) {
        throw new IosRuntimeStageError(
          captureState ? 'observing' : 'acting',
          'Debug state·fixture 계약이 활성화됐지만 bridge 증거가 생성되지 않았습니다.'
        )
      }
      const imagePaths: string[] = []
      if (result.screenEvidence) {
        const evidence = this.store.addRuntimeEvidence(task.id, {
          runId,
          kind: 'screen',
          path: result.screenEvidence.path,
          mimeType: result.screenEvidence.mimeType,
          sizeBytes: result.screenEvidence.sizeBytes,
          createdAt: result.screenEvidence.capturedAt,
          summary: '최종 Simulator 화면 캡처'
        })
        imagePaths.push(evidence.path)
        this.emit(
          task,
          'runtime_observed',
          'runtime',
          `Simulator 화면 증거 저장 · ${evidence.sizeBytes.toLocaleString('ko-KR')} bytes`
        )
      }
      const reviewContexts: string[] = []
      if (result.debugStateEvidence) {
        const debugState = result.debugStateEvidence
        const evidence = this.store.addRuntimeEvidence(task.id, {
          runId,
          kind: 'debug-state',
          path: debugState.path,
          mimeType: debugState.mimeType,
          sizeBytes: debugState.sizeBytes,
          createdAt: debugState.capturedAt,
          summary: [
            debugState.fixtureId ? `fixture ${debugState.fixtureId} 적용` : '',
            debugState.hasState ? '최종 Debug 상태 수집' : ''
          ].filter(Boolean).join(' · ')
        })
        if (debugState.fixtureId) {
          this.emit(
            task,
            'runtime_acted',
            'runtime',
            `Simulator Debug fixture 적용 완료 · ${debugState.fixtureId} · ${evidence.sizeBytes.toLocaleString('ko-KR')} bytes`
          )
        }
        if (debugState.hasState) {
          this.emit(
            task,
            'runtime_observed',
            'runtime',
            `Simulator Debug 앱 상태 저장 · ${evidence.sizeBytes.toLocaleString('ko-KR')} bytes`
          )
        }
        const content = debugState.content.slice(0, MAX_DEBUG_STATE_REVIEW_CHARS)
        reviewContexts.push([
          '다음 JSON은 대상 앱의 Debug bridge가 확인한 fixture 적용 결과와 최종 내부 상태입니다. 코드·UI 증거와 함께 요구사항을 검토하세요.',
          '```json',
          content,
          debugState.content.length > content.length ? '\n... Reviewer 입력 크기 제한으로 이하 생략' : '',
          '```'
        ].filter(Boolean).join('\n'))
      }
      if (result.uiActionEvidence) {
        const actions = result.uiActionEvidence
        const evidence = this.store.addRuntimeEvidence(task.id, {
          runId,
          kind: 'ui-actions',
          path: actions.path,
          mimeType: actions.mimeType,
          sizeBytes: actions.sizeBytes,
          createdAt: actions.executedAt,
          summary: `identifier UI 조작 ${actions.actionCount.toLocaleString('ko-KR')}단계 성공`
        })
        this.emit(
          task,
          'runtime_acted',
          'runtime',
          `Simulator identifier UI 조작 완료 · ${actions.actionCount.toLocaleString('ko-KR')}단계 · ${evidence.sizeBytes.toLocaleString('ko-KR')} bytes`
        )
        const content = actions.content.slice(0, MAX_UI_ACTION_REVIEW_CHARS)
        reviewContexts.push([
          `다음 JSON은 accessibility identifier로 순서대로 실행해 모두 성공한 UI 조작 결과입니다. (${actions.actionCount.toLocaleString('ko-KR')}단계)`,
          '```json',
          content,
          actions.content.length > content.length ? '\n... Reviewer 입력 크기 제한으로 이하 생략' : '',
          '```'
        ].filter(Boolean).join('\n'))
      }
      if (result.accessibilityEvidence) {
        const accessibility = result.accessibilityEvidence
        const evidence = this.store.addRuntimeEvidence(task.id, {
          runId,
          kind: 'accessibility',
          path: accessibility.path,
          mimeType: accessibility.mimeType,
          sizeBytes: accessibility.sizeBytes,
          createdAt: accessibility.capturedAt,
          summary: `접근성 요소 ${accessibility.nodeCount.toLocaleString('ko-KR')}개${accessibility.truncated ? ' · 일부 생략' : ''}`
        })
        this.emit(
          task,
          'runtime_observed',
          'runtime',
          `Simulator 접근성 트리 저장 · ${accessibility.nodeCount.toLocaleString('ko-KR')}개 요소 · ${evidence.sizeBytes.toLocaleString('ko-KR')} bytes${accessibility.truncated ? ' · 안전 제한으로 일부 생략' : ''}`
        )
        const content = accessibility.content.slice(0, MAX_ACCESSIBILITY_REVIEW_CHARS)
        reviewContexts.push([
          `다음 JSON은 실행 중인 앱의 접근성 트리입니다. identifier, label, value, frame, enabled·selected 상태와 계층을 이용해 요구사항과 화면 구조를 검토하세요. (${accessibility.nodeCount.toLocaleString('ko-KR')}개 요소${accessibility.truncated ? ', 수집 시 일부 생략' : ''})`,
          '```json',
          content,
          accessibility.content.length > content.length ? '\n... Reviewer 입력 크기 제한으로 이하 생략' : '',
          '```'
        ].filter(Boolean).join('\n'))
      }
      let verificationSummary = ''
      const runtimeAssertions = manifest.value.capabilities.verify.includes('runtime-scenario')
        ? manifest.value.runtimeScenario?.assertions ?? []
        : []
      if (runtimeAssertions.length > 0) {
        const verifyMessage = `runtime acceptance ${runtimeAssertions.length.toLocaleString('ko-KR')}개를 평가합니다.`
        this.store.setRuntimeSession(task.id, 'verifying', {
          deviceId: result.deviceId,
          deviceName: result.deviceName,
          bundleIdentifier: result.bundleIdentifier,
          processId: result.processId,
          message: verifyMessage
        })
        this.emit(task, 'runtime_started', 'runtime', verifyMessage)

        const report = evaluateRuntimeAcceptance(runtimeAssertions, result)
        let verificationEvidence: Awaited<ReturnType<typeof writeRuntimeAcceptanceEvidence>>
        try {
          verificationEvidence = await writeRuntimeAcceptanceEvidence(
            this.runtimeRoot,
            task.id,
            report
          )
        } catch (error) {
          throw new IosRuntimeStageError(
            'verifying',
            `runtime acceptance 결과를 안전하게 저장하지 못했습니다. ${redact(String(error))}`
          )
        }
        verificationSummary = summarizeRuntimeAcceptance(report)
        const storedEvidence = this.store.addRuntimeEvidence(task.id, {
          runId,
          kind: 'runtime-verification',
          path: verificationEvidence.path,
          mimeType: verificationEvidence.mimeType,
          sizeBytes: verificationEvidence.sizeBytes,
          createdAt: verificationEvidence.createdAt,
          outcome: report.passed ? 'passed' : 'failed',
          summary: verificationSummary
        })
        this.emit(
          task,
          'runtime_verified',
          'runtime',
          `${verificationSummary} · ${storedEvidence.sizeBytes.toLocaleString('ko-KR')} bytes`,
          report.passed ? null : 'high'
        )
        const content = verificationEvidence.content.slice(
          0,
          MAX_RUNTIME_VERIFICATION_REVIEW_CHARS
        )
        reviewContexts.push([
          `다음 JSON은 선언된 runtime acceptance assertion을 증거와 결정적으로 비교한 결과입니다. (${report.passedCount.toLocaleString('ko-KR')}/${report.assertionCount.toLocaleString('ko-KR')} 통과)`,
          '```json',
          content,
          verificationEvidence.content.length > content.length
            ? '\n... Reviewer 입력 크기 제한으로 이하 생략'
            : '',
          '```'
        ].filter(Boolean).join('\n'))
        if (!report.passed) {
          const failedReport = JSON.stringify({
            ...report,
            results: report.results.filter((item) => !item.passed)
          }, null, 2)
          const repairEvidence = [
            `runtime 판정: ${verificationSummary}`,
            '실패한 assertion 판정 JSON:',
            failedReport,
            '판정에 사용한 보조 runtime 증거:',
            ...reviewContexts.slice(0, -1)
          ].join('\n\n').slice(0, MAX_RUNTIME_REPAIR_CONTEXT_CHARS)
          throw new RuntimeAcceptanceStageError(
            verificationSummary,
            repairEvidence,
            [...imagePaths]
          )
        }
      }
      const message = [
        `${result.deviceName}에서 ${result.bundleIdentifier} 실행 완료${result.processId ? ` · PID ${result.processId}` : ''}`,
        result.screenEvidence ? '화면 증거 1개 저장' : '',
        result.accessibilityEvidence
          ? `접근성 요소 ${result.accessibilityEvidence.nodeCount.toLocaleString('ko-KR')}개 저장`
          : '',
        result.uiActionEvidence
          ? `identifier UI 조작 ${result.uiActionEvidence.actionCount.toLocaleString('ko-KR')}단계 완료`
          : '',
        result.debugStateEvidence?.fixtureId
          ? `Debug fixture ${result.debugStateEvidence.fixtureId} 적용`
          : '',
        result.debugStateEvidence?.hasState
          ? 'Debug 앱 상태 저장'
          : '',
        verificationSummary
      ].filter(Boolean).join(' · ')
      this.store.setRuntimeSession(task.id, 'running', {
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        bundleIdentifier: result.bundleIdentifier,
        processId: result.processId,
        message
      })
      this.emit(task, 'runtime_ready', 'runtime', message)
      return { summary: message, reviewContext: reviewContexts.join('\n\n'), imagePaths }
    } catch (error) {
      if (error instanceof StoppedError) throw error
      if (error instanceof ProcessTimeoutError) {
        this.emit(task, 'runtime_failed', 'runtime', error.message, 'high')
        throw error
      }
      const runtimeError = error instanceof IosRuntimeStageError
        ? error
        : new IosRuntimeStageError('failed', redact(String(error)))
      this.emit(task, 'runtime_failed', 'runtime', runtimeError.message, 'high')
      throw runtimeError
    }
  }

  private async executeRuntimeCommand(
    request: RuntimeCommandRequest,
    control: ActiveRun | null
  ): Promise<ProcessResult> {
    return this.runProcess(
      request.command,
      request.args,
      request.cwd,
      control,
      undefined,
      process.env,
      { timeoutMs: request.timeoutMs, label: request.label }
    )
  }

  private async stopRuntimeSession(
    task: TaskRecord,
    status: Extract<RuntimeSessionStatus, 'failed' | 'stopped'>,
    message: string
  ): Promise<void> {
    const session = this.store.getRuntimeSession(task.id)
    if (!session || ['failed', 'stopped'].includes(session.status)) {
      this.managedRuntimeTaskIds.delete(task.id)
      return
    }

    let cleanupMessage = message
    if (session.deviceId && session.bundleIdentifier) {
      try {
        await this.runtimeAdapter.stop({
          session,
          cwd: this.runtimeRoot,
          execute: (request) => this.executeRuntimeCommand(request, null)
        })
      } catch (error) {
        cleanupMessage = `${message} 종료 명령 경고: ${redact(String(error))}`
      }
    }

    this.store.setRuntimeSession(task.id, status, { message: cleanupMessage, processId: null })
    this.managedRuntimeTaskIds.delete(task.id)
    this.emit(task, 'runtime_stopped', 'runtime', cleanupMessage, status === 'failed' ? 'high' : null)
  }

  private runProcess(
    command: string,
    args: string[],
    cwd: string,
    control: ActiveRun | null,
    onLine?: (line: string) => void,
    environment: NodeJS.ProcessEnv = process.env,
    deadline?: ProcessDeadline
  ): Promise<ProcessResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: environment,
        detached: Boolean(control && process.platform !== 'win32'),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      if (control) control.child = child

      let output = ''
      let stdout = ''
      let finalMessage = ''
      let stdoutBuffer = ''
      let timedOut = false
      let finished = false
      let timeout: NodeJS.Timeout | null = null

      const clearDeadline = (): void => {
        if (timeout) clearTimeout(timeout)
        timeout = null
      }

      const clearControlChild = (): void => {
        if (control?.child === child) control.child = null
      }

      const consumeLine = (rawLine: string): void => {
        const line = redact(rawLine)
        stdout = `${stdout}${line}\n`.slice(-1_000_000)
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
      child.on('error', (error) => {
        if (finished) return
        finished = true
        clearDeadline()
        clearControlChild()
        reject(error)
      })
      child.on('close', (code) => {
        if (finished) return
        finished = true
        clearDeadline()
        if (stdoutBuffer) consumeLine(stdoutBuffer)
        clearControlChild()
        if (control?.stopped) {
          reject(new StoppedError())
          return
        }
        if (timedOut && deadline) {
          reject(new ProcessTimeoutError(deadline.label, deadline.timeoutMs))
          return
        }
        resolvePromise({ code: code ?? 1, output, stdout, finalMessage })
      })

      if (deadline && deadline.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (finished) return
          timedOut = true
          if (control) void this.terminateControl(control)
          else void this.terminateChild(child)
        }, deadline.timeoutMs)
      }
    })
  }

  private terminateControl(control: ActiveRun): Promise<void> {
    if (control.termination) return control.termination
    const child = control.child
    if (!child) return Promise.resolve()
    const termination = this.terminateChild(child).finally(() => {
      if (control.termination === termination) control.termination = null
    })
    control.termination = termination
    return termination
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (!this.isChildRunning(child)) return
    this.signalProcess(child, 'SIGTERM')
    if (await this.waitForExit(child, this.policy.terminationGraceMs)) return
    this.signalProcess(child, 'SIGKILL')
    await this.waitForExit(child, this.policy.terminationGraceMs)
  }

  private signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!this.isChildRunning(child)) return
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {
        // Fall back to the direct child when a process group is unavailable.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // The child may have exited between the state check and signal delivery.
    }
  }

  private isChildRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (!this.isChildRunning(child)) return Promise.resolve(true)
    return new Promise((resolvePromise) => {
      const onExit = (): void => {
        clearTimeout(timer)
        resolvePromise(true)
      }
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        resolvePromise(!this.isChildRunning(child))
      }, Math.max(1, timeoutMs))
      child.once('exit', onExit)
    })
  }

  private async requireGit(args: string[], cwd: string, failureMessage: string): Promise<ProcessResult> {
    const result = await this.runProcess('git', args, cwd, null)
    if (result.code !== 0) {
      const detail = result.output.trim()
      throw new Error(detail ? `${failureMessage}\n${detail.slice(-2_000)}` : failureMessage)
    }
    return result
  }

  private async assertCleanCheckout(projectRoot: string): Promise<void> {
    const status = await this.requireGit(
      ['status', '--porcelain', '--untracked-files=normal'],
      projectRoot,
      '원본 저장소 상태를 확인할 수 없습니다.'
    )
    if (status.output.trim()) {
      throw new Error('원본 저장소에 커밋되지 않은 변경이 있습니다. 변경을 정리한 뒤 다시 승인하세요.')
    }
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
