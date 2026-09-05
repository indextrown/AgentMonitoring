import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentRunner,
  codexUsageLimitMessage,
  eventMessage,
  parseConfiguredCommand,
  parseReviewerFindings,
  projectTestFailureDiagnostics,
  projectTestFailureReport,
  runtimeIdentifierRepairContext
} from '../../electron/main/runner'
import {
  IosRuntimeStageError,
  type IosSimulatorRuntimeAdapter
} from '../../electron/main/ios-simulator-runtime'
import { AppStore } from '../../electron/main/store'
import type {
  ApprovedRuntimeContract,
  CodexResolvedModelPlan,
  TaskVerificationPlan
} from '../../src/shared/types'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const activeRunners: AgentRunner[] = []

afterEach(async () => {
  await Promise.all(activeRunners.splice(0).map((runner) => runner.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await delay(20)
    }
  }
  throw new Error(`fixture 파일 생성 시간을 초과했습니다: ${path}`)
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await delay(20)
  }
  throw new Error('조건을 기다리는 시간을 초과했습니다.')
}

async function configureOrigin(directory: string, repository: string): Promise<string> {
  const remote = join(directory, 'github.com', 'example', 'fixture.git')
  await mkdir(dirname(remote), { recursive: true })
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: repository })
  await execFileAsync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repository })
  return remote
}

async function createExecutionFixture(options: {
  codexSource: (directory: string) => string
  makefile?: string
  policy?: ConstructorParameters<typeof AgentRunner>[5]
  withRuntimeManifest?: boolean
  withScreenObservation?: boolean
  withAccessibilityObservation?: boolean
  withUiActions?: boolean
  withDebugState?: boolean
  withDebugFixture?: boolean
  runtimeAssertions?: Array<Record<string, unknown>>
  maxAttempts?: number
  runtimeAdapter?: IosSimulatorRuntimeAdapter
  runtimeContract?: ApprovedRuntimeContract
  verificationPlan?: TaskVerificationPlan
  modelPlan?: CodexResolvedModelPlan
  setupCommand?: string | null
  testCommand?: string | null
  runtimePreparer?: ConstructorParameters<typeof AgentRunner>[10]
}): Promise<{
  directory: string
  repository: string
  store: AppStore
  runner: AgentRunner
  taskId: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runtime-'))
  temporaryDirectories.push(directory)
  const repository = join(directory, 'repository')
  const worktrees = join(directory, 'worktrees')
  await mkdir(repository)
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), '# Runtime fixture\n')
  await writeFile(join(repository, 'Makefile'), options.makefile ?? 'test:\n\t@true\n')
  const trackedFiles = ['README.md', 'Makefile']
  if (options.withRuntimeManifest) {
    await mkdir(join(repository, '.agentmonitor'))
    await mkdir(join(repository, 'App.xcodeproj'))
    await writeFile(
      join(repository, '.agentmonitor', 'project.json'),
      JSON.stringify({
        version: 1,
        adapter: {
          kind: 'ios-simulator',
          container: 'App.xcodeproj',
          scheme: 'App',
          configuration: 'Debug'
        },
        capabilities: {
          build: true,
          run: true,
          observe: [
            ...(options.withScreenObservation ? ['screen'] : []),
            ...(options.withAccessibilityObservation ? ['accessibility'] : []),
            ...(options.withDebugState ? ['state'] : [])
          ],
          act: [
            ...(options.withUiActions ? ['ui'] : []),
            ...(options.withDebugFixture ? ['fixture'] : [])
          ],
          verify: [
            'test-command',
            ...((options.runtimeAssertions?.length ?? 0) > 0 ? ['runtime-scenario'] : [])
          ]
        },
        debugBridge: options.withDebugState || options.withDebugFixture
          ? { protocol: 'file-v1', responseTimeoutSeconds: 10 }
          : undefined,
        runtimeScenario: options.withUiActions || options.withDebugFixture || options.runtimeAssertions?.length
          ? {
              actions: options.withUiActions
                ? [
                    { kind: 'tap', identifier: 'start-navigation', timeoutSeconds: 10 },
                    {
                      kind: 'type-text',
                      identifier: 'destination-search',
                      text: '부산항',
                      timeoutSeconds: 12
                    }
                  ]
                : [],
              fixture: options.withDebugFixture
                ? {
                    id: 'signed-in-home',
                    payload: { accountID: 'fixture-user', selectedTab: 'home' }
                  }
                : undefined,
              assertions: options.runtimeAssertions ?? []
            }
          : undefined
      })
    )
    await writeFile(join(repository, 'App.xcodeproj', 'project.pbxproj'), '// fixture\n')
    trackedFiles.push('.agentmonitor/project.json', 'App.xcodeproj/project.pbxproj')
  }
  await execFileAsync('git', ['add', ...trackedFiles], { cwd: repository })
  await execFileAsync(
    'git',
    ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'init'],
    { cwd: repository }
  )
  await configureOrigin(directory, repository)

  const fakeCodex = join(directory, 'fake-codex.mjs')
  await writeFile(fakeCodex, options.codexSource(directory))
  await chmod(fakeCodex, 0o755)

  const store = new AppStore(join(directory, 'store.sqlite'))
  const project = store.addProject('Runtime fixture', repository)
  store.updateProject({
    projectId: project.id,
    name: project.name,
    setupCommand: options.setupCommand ?? '',
    testCommand: options.testCommand === null ? '' : options.testCommand ?? 'make test',
    publishStrategy: 'direct'
  })
  const task = store.createTask(
    project.id,
    '실행 수명주기',
    '중단과 시간 초과를 안전하게 처리한다.',
    options.maxAttempts ?? 1,
    options.runtimeContract ?? null,
    options.runtimeContract ? '승인된 테스트 시나리오' : null,
    options.verificationPlan ?? null,
    undefined,
    null,
    options.modelPlan ?? null
  )
  const runner = new AgentRunner(
    store,
    worktrees,
    () => undefined,
    fakeCodex,
    undefined,
    options.policy,
    options.runtimeAdapter,
    undefined,
    'gh',
    undefined,
    options.runtimePreparer ?? (async () => ({ containerGenerated: false, simulatorRecovered: false }))
  )
  activeRunners.push(runner)
  return { directory, repository, store, runner, taskId: task.id }
}

async function createApprovalFixture(options: {
  publishStrategy?: 'pull-request' | 'direct'
  githubSource?: string
  policy?: ConstructorParameters<typeof AgentRunner>[5]
} = {}): Promise<{
  repository: string
  remote: string
  worktreePath: string
  store: AppStore
  runner: AgentRunner
  taskId: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-approval-'))
  temporaryDirectories.push(directory)
  const repository = join(directory, 'repository')
  const worktrees = join(directory, 'worktrees')
  const worktreePath = join(worktrees, 'task')
  await mkdir(repository)
  await mkdir(worktrees)
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
  await writeFile(join(repository, 'README.md'), '# Fixture\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repository })
  await execFileAsync('git', ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'init'], {
    cwd: repository
  })
  const remote = await configureOrigin(directory, repository)

  const store = new AppStore(join(directory, 'store.sqlite'))
  const project = store.addProject('Fixture', repository)
  store.updateProject({
    projectId: project.id,
    name: project.name,
    setupCommand: '',
    testCommand: '',
    publishStrategy: options.publishStrategy ?? 'direct'
  })
  const task = store.createTask(project.id, '승인 기능', '작업 변경을 원본 저장소에 안전하게 적용한다.', 2)
  const branchName = 'agentmonitor/approval-fixture'
  const baseCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repository })
  await writeFile(join(worktreePath, 'agent-output.txt'), 'implemented\n')
  store.setTaskWorkspace(task.id, branchName, worktreePath, 'main', baseCommit)
  store.transitionTask(task.id, 'running', 1)
  store.transitionTask(task.id, 'awaiting_approval')

  let githubCommand = 'gh'
  if (options.githubSource) {
    githubCommand = join(directory, 'fake-gh.mjs')
    await writeFile(githubCommand, options.githubSource)
    await chmod(githubCommand, 0o755)
  }

  return {
    repository,
    remote,
    worktreePath,
    store,
    runner: new AgentRunner(
      store,
      worktrees,
      () => undefined,
      'codex',
      undefined,
      options.policy,
      undefined,
      undefined,
      githubCommand
    ),
    taskId: task.id
  }
}

describe('AgentRunner', () => {
  it('reads structured Codex errors without rendering object placeholders', () => {
    expect(eventMessage({
      type: 'turn.failed',
      error: { message: "You've hit your usage limit. Try again later." }
    })).toBe("Codex 오류 · You've hit your usage limit. Try again later.")
    expect(codexUsageLimitMessage("You've hit your usage limit. Try again at Sep 7, 2026 3:22 PM."))
      .toContain('Sep 7, 2026 3:22 PM')
  })

  it('extracts actionable test failures instead of returning only trailing build noise', () => {
    const output = [
      '[2026-09-05T05:27:01Z] [info] [TuistAutomation] Test Suite started',
      '[2026-09-05T05:27:24Z] [info] [TuistAutomation]     ✖ testCurrentLocation, failed - 버튼이 활성화되지 않았습니다.',
      '/tmp/AppTests.swift:42:17: error: main actor-isolated property cannot be mutated',
      ...Array.from({ length: 800 }, (_, index) => `build noise ${index}`),
      '** TEST FAILED **'
    ].join('\n')

    expect(projectTestFailureDiagnostics(output)).toContain(
      '✖ testCurrentLocation, failed - 버튼이 활성화되지 않았습니다.'
    )
    expect(projectTestFailureDiagnostics(output)).toContain(
      '/tmp/AppTests.swift:42:17: error: main actor-isolated property cannot be mutated'
    )
    expect(projectTestFailureReport(output)).not.toContain('build noise 799')
  })

  it('feeds failures located before verbose build output back to the next Implementer', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'diagnostic-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
if (prompt.includes('testCurrentLocation, failed - 버튼이 활성화되지 않았습니다.')) {
  writeFileSync('.diagnostic-fixed', 'fixed\\n')
}
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      makefile: `test:
\t@if [ -f .diagnostic-fixed ]; then exit 0; fi; \\
\t  echo '✖ testCurrentLocation, failed - 버튼이 활성화되지 않았습니다.'; \\
\t  i=0; while [ $$i -lt 800 ]; do echo "verbose build noise $$i"; i=$$((i + 1)); done; \\
\t  exit 1
`,
      maxAttempts: 2,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)

    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({ status: 'awaiting_approval', attempt: 2 })
    expect(prompts.filter((prompt) => prompt.includes('구현 담당자'))).toHaveLength(2)
    expect(prompts.some((prompt) => prompt.includes('testCurrentLocation, failed - 버튼이 활성화되지 않았습니다.')))
      .toBe(true)
    fixture.store.close()
  })

  it('continues a failed task from its latest test diagnostics on the next run', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'resume-diagnostic-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
if (prompt.includes('직전 실행에서 최대 시도 횟수까지') && prompt.includes('testResume, failed - 카메라 상태가 바뀌지 않았습니다.')) {
  writeFileSync('.resume-fixed', 'fixed\\n')
}
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      makefile: `test:
\t@if [ -f .resume-fixed ]; then exit 0; fi; \\
\t  echo '✖ testResume, failed - 카메라 상태가 바뀌지 않았습니다.'; \\
\t  exit 1
`,
      maxAttempts: 1,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'swift-testing',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({ status: 'failed', attempt: 1 })

    await fixture.runner.run(fixture.taskId)

    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({ status: 'awaiting_approval', attempt: 1 })
    expect(prompts.filter((prompt) => prompt.includes('구현 담당자'))).toHaveLength(2)
    expect(prompts.filter((prompt) => prompt.includes('당신은 테스트 설계자입니다.'))).toHaveLength(1)
    expect(prompts.filter((prompt) => prompt.includes('당신은 읽기 전용 테스트 비평가입니다.'))).toHaveLength(1)
    expect(prompts.some((prompt) => (
      prompt.includes('직전 실행에서 최대 시도 횟수까지') &&
      prompt.includes('testResume, failed - 카메라 상태가 바뀌지 않았습니다.')
    ))).toBe(true)
    fixture.store.close()
  })

  it('continues a failed task from unresolved Reviewer findings on the next run', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'resume-reviewer-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
if (prompt.includes('구현 담당자') && prompt.includes('하단 안전영역을 침범합니다.')) {
  writeFileSync('.reviewer-fixed', 'fixed\\n')
}
const message = prompt.includes('최종 읽기 전용 Reviewer')
  ? (existsSync('.reviewer-fixed') ? 'VERDICT: PASS' : '[medium] 하단 안전영역을 침범합니다.')
  : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      maxAttempts: 1,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'swift-testing',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({ status: 'awaiting_approval', attempt: 1 })
    expect(fixture.store.listTaskFindings(fixture.taskId)).toHaveLength(1)

    await fixture.runner.run(fixture.taskId)

    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({ status: 'awaiting_approval', attempt: 1 })
    expect(fixture.store.listTaskFindings(fixture.taskId)).toEqual([])
    expect(prompts.some((prompt) => (
      prompt.includes('구현 담당자') &&
      prompt.includes('직전 Reviewer 검토에서 수정할 문제가 남았습니다.') &&
      prompt.includes('하단 안전영역을 침범합니다.')
    ))).toBe(true)
    fixture.store.close()
  })

  it('queues approval feedback in order and reruns each request in the same worktree', async () => {
    let callsPath = ''
    let firstRevisionStartedPath = ''
    const feedback = '메인 스레드 경고를 제거하고 기존 동작이 유지되는지 다시 검증해 주세요.'
    const queuedFeedback = '수정된 화면의 접근성 레이블도 확인하고 누락된 값을 보완해 주세요.'
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'approval-feedback-calls.jsonl')
        firstRevisionStartedPath = join(directory, 'first-revision-started')
        return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
if (prompt.includes('구현 담당자') && prompt.includes(${JSON.stringify(feedback)})) {
  writeFileSync('.main-thread-warning-fixed', 'fixed\\n')
  if (!prompt.includes(${JSON.stringify(queuedFeedback)})) {
    writeFileSync(${JSON.stringify(firstRevisionStartedPath)}, 'started\\n')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
}
if (prompt.includes('구현 담당자') && prompt.includes(${JSON.stringify(queuedFeedback)})) {
  writeFileSync('.accessibility-label-fixed', 'fixed\\n')
}
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'swift-testing',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)
    const initial = fixture.store.getTask(fixture.taskId)
    expect(initial.status).toBe('awaiting_approval')

    fixture.store.addTaskRevisionRequest(fixture.taskId, feedback)
    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow(
      '큐에 남은 추가 수정 요청을 모두 반영한 뒤 게시하세요.'
    )
    await fixture.runner.continueTask(fixture.taskId, feedback)
    await waitForFile(firstRevisionStartedPath)
    await fixture.runner.continueTask(fixture.taskId, queuedFeedback)
    await waitForCondition(() => {
      const requests = fixture.store.getTask(fixture.taskId).revisionRequests ?? []
      return requests.length === 2 && requests.every((request) => Boolean(request.appliedAt))
    })

    const revised = fixture.store.getTask(fixture.taskId)
    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(revised).toMatchObject({
      status: 'awaiting_approval',
      branchName: initial.branchName,
      worktreePath: initial.worktreePath
    })
    expect(revised.prompt).toBe(initial.prompt)
    expect(revised.revisionRequests?.map((request) => request.instruction)).toEqual([feedback, queuedFeedback])
    expect(revised.revisionRequests?.every((request) => request.startedAt && request.appliedAt)).toBe(true)
    expect(await readFile(join(revised.worktreePath!, '.main-thread-warning-fixed'), 'utf8')).toBe('fixed\n')
    expect(await readFile(join(revised.worktreePath!, '.accessibility-label-fixed'), 'utf8')).toBe('fixed\n')
    expect(prompts.filter((prompt) => prompt.includes('당신은 테스트 설계자입니다.'))).toHaveLength(3)
    for (const role of ['당신은 테스트 설계자입니다.', '당신은 읽기 전용 테스트 비평가입니다.', '당신은 구현 담당자입니다.', '당신은 최종 읽기 전용 Reviewer입니다.']) {
      expect(prompts.some((prompt) => prompt.includes(role) && prompt.includes(feedback))).toBe(true)
      expect(prompts.some((prompt) => prompt.includes(role) && prompt.includes(queuedFeedback))).toBe(true)
    }
    const firstRevisionImplementer = prompts.find((prompt) =>
      prompt.includes('당신은 구현 담당자입니다.') && prompt.includes(feedback)
    )
    expect(firstRevisionImplementer).not.toContain(queuedFeedback)
    expect(fixture.store.getSnapshot().events.some((event) => event.kind === 'task_revision_requested')).toBe(true)
    fixture.store.close()
  })

  it('keeps the active revision queued when its Codex stage is blocked', async () => {
    const feedback = 'Codex가 다시 가능해지면 같은 수정 요청을 이어서 처리해 주세요.'
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? ''
if (prompt.includes(${JSON.stringify(feedback)})) {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }))
  process.exitCode = 1
} else {
  const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
  console.log(JSON.stringify({ type: 'turn.completed' }))
}
`,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)
    await fixture.runner.continueTask(fixture.taskId, feedback)
    await waitForCondition(() => fixture.store.getTask(fixture.taskId).status === 'blocked_agent')

    const blocked = fixture.store.getTask(fixture.taskId)
    expect(blocked.revisionRequests?.[0]).toMatchObject({
      instruction: feedback,
      appliedAt: null
    })
    expect(blocked.revisionRequests?.[0].startedAt).toBeTruthy()
    fixture.store.close()
  })

  it('pauses the revision queue after the current item and can run one item before resuming', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? ''
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)
    fixture.runner.setTaskRevisionQueuePaused(fixture.taskId, true)
    await fixture.runner.continueTask(fixture.taskId, '첫 번째 후속 요청만 먼저 구현하고 검증해 주세요.')
    await fixture.runner.continueTask(fixture.taskId, '두 번째 후속 요청은 확인할 때까지 대기해 주세요.')

    const paused = fixture.store.getTask(fixture.taskId)
    expect(paused.status).toBe('awaiting_approval')
    expect(paused.revisionQueuePaused).toBe(true)
    expect(paused.revisionRequests?.every((request) => request.startedAt === null)).toBe(true)

    await fixture.runner.runNextTaskRevision(fixture.taskId)
    const afterOne = fixture.store.getTask(fixture.taskId)
    expect(afterOne.revisionQueuePaused).toBe(true)
    expect(afterOne.revisionRequests?.[0].appliedAt).toBeTruthy()
    expect(afterOne.revisionRequests?.[1].appliedAt).toBeNull()

    fixture.runner.setTaskRevisionQueuePaused(fixture.taskId, false)
    await waitForCondition(() => fixture.store.getTask(fixture.taskId).revisionRequests?.every((request) => Boolean(request.appliedAt)) ?? false)
    const completed = fixture.store.getTask(fixture.taskId)
    expect(completed.revisionQueuePaused).toBe(false)
    expect(completed.status).toBe('awaiting_approval')
    fixture.store.close()
  })

  it('pauses on a Codex usage limit without consuming an implementation attempt', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again at Sep 7, 2026 3:22 PM." } }))
process.exitCode = 1
`,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('Codex 사용 한도에 도달했습니다.')

    const task = fixture.store.getTask(fixture.taskId)
    const events = fixture.store.getSnapshot(task.projectId).events
    expect(task).toMatchObject({ status: 'blocked_agent', attempt: 0 })
    expect(events.some((event) => event.message.includes('[object Object]'))).toBe(false)
    expect(events.some((event) => event.message.includes('AI 요청 대기'))).toBe(true)
    expect(fixture.store.getSnapshot(task.projectId).findings).toEqual([])
    fixture.store.close()
  })

  it('classifies only exact app identifier action failures as implementation-repairable', () => {
    expect(runtimeIdentifierRepairContext(new IosRuntimeStageError(
      'acting',
      "UI action 1: identifier 'current-location-button' 요소를 찾지 못했습니다."
    ))).toContain("앱 identifier 'current-location-button'")
    expect(runtimeIdentifierRepairContext(new IosRuntimeStageError(
      'acting',
      'Accessibility observer Xcode build failed'
    ))).toBeNull()
    expect(runtimeIdentifierRepairContext(new IosRuntimeStageError(
      'launching',
      "UI action 1: identifier 'current-location-button' 요소를 찾지 못했습니다."
    ))).toBeNull()
  })

  it('parses deduplicated reviewer findings with explicit severities', () => {
    expect(
      parseReviewerFindings('[high] 인증 실패 경로 누락\n- [medium] 빈 입력 검증 부족\n[HIGH] 인증 실패 경로 누락')
    ).toEqual([
      { severity: 'high', title: '인증 실패 경로 누락' },
      { severity: 'medium', title: '빈 입력 검증 부족' }
    ])
    expect(parseReviewerFindings('VERDICT: PASS')).toEqual([])
  })

  it('accepts Tuist validation commands and rejects unknown executables', () => {
    expect(parseConfiguredCommand('tuist test Core')).toEqual({ command: 'tuist', args: ['test', 'Core'] })
    expect(() => parseConfiguredCommand('bash verify.sh')).toThrow('허용되지 않은 테스트 실행 파일입니다: bash')
  })

  it('prepares the isolated environment before running project tests', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? ''
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      makefile: 'setup:\n\t@touch .environment-ready\n\ntest:\n\t@test -f .environment-ready\n',
      setupCommand: 'make setup',
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    expect(task.status).toBe('awaiting_approval')
    expect(task.verificationResult).toMatchObject({
      environmentSetup: { status: 'passed' },
      projectTests: { status: 'passed' }
    })
    expect(await readFile(join(task.worktreePath!, '.environment-ready'), 'utf8')).toBe('')
    expect(fixture.store.getSnapshot(task.projectId).events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['environment_started', 'environment_passed', 'test_passed'])
    )
    fixture.store.close()
  })

  it('makes ignored xcconfig files available to Codex and project tests', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
import { existsSync } from 'node:fs'
if (!existsSync('Config/Secrets.xcconfig')) process.exit(2)
const prompt = process.argv.at(-1) ?? ''
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      makefile: 'test:\n\t@test -f Config/Secrets.xcconfig\n',
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })
    await writeFile(join(fixture.repository, '.git', 'info', 'exclude'), 'Config/Secrets.xcconfig\n')
    await mkdir(join(fixture.repository, 'Config'), { recursive: true })
    await writeFile(join(fixture.repository, 'Config', 'Secrets.xcconfig'), 'MAPBOX_ACCESS_TOKEN = fixture-token\n')

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    const worktreePath = task.worktreePath!
    expect(task.status).toBe('awaiting_approval')
    expect(await readFile(join(worktreePath, 'Config', 'Secrets.xcconfig'), 'utf8'))
      .toBe('MAPBOX_ACCESS_TOKEN = fixture-token\n')
    expect(fixture.store.getSnapshot(task.projectId).events.some(
      (event) => event.message.includes('로컬 xcconfig 1개를 작업공간에 동기화')
    )).toBe(true)

    await fixture.runner.discard(task.id)
    await expect(stat(worktreePath)).rejects.toThrow()
    fixture.store.close()
  })

  it('prepares dependencies again when the Implementer changes a manifest', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
if (prompt.includes('구현 담당자')) writeFileSync('Package.swift', '// dependency changed\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      makefile: 'setup:\n\t@echo prepared >> .setup-count\n\ntest:\n\t@test "$$(wc -l < .setup-count)" -eq 2\n',
      setupCommand: 'make setup',
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    expect(task.status).toBe('awaiting_approval')
    expect((await readFile(join(task.worktreePath!, '.setup-count'), 'utf8')).trim().split('\n')).toHaveLength(2)
    expect(
      fixture.store.getSnapshot(task.projectId).events.filter((event) => event.kind === 'environment_passed')
    ).toHaveLength(2)
    fixture.store.close()
  })

  it('blocks on environment setup failure without consuming an implementation attempt', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'environment-failure-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(callsPath)}, 'called\\n')
`
      },
      makefile: 'setup:\n\t@echo "Could not find external dependencies. Run tuist install before you continue"; false\n\ntest:\n\t@true\n',
      setupCommand: 'make setup',
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('Tuist 외부 의존성이 준비되지 않았습니다.')

    const task = fixture.store.getTask(fixture.taskId)
    expect(task).toMatchObject({ status: 'blocked_environment', attempt: 0 })
    expect(task.verificationResult?.environmentSetup.status).toBe('failed')
    await expect(readFile(callsPath, 'utf8')).rejects.toThrow()
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'environment_failed')).toBe(true)
    fixture.store.close()
  })

  it('classifies dependency resolution test output without repeating the Implementer', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'dependency-failure-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      makefile: 'test:\n\t@echo "MapboxMaps is not a valid configured external dependency"; false\n',
      maxAttempts: 3,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('Tuist 외부 의존성이 준비되지 않았습니다.')

    const task = fixture.store.getTask(fixture.taskId)
    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(task).toMatchObject({ status: 'blocked_environment', attempt: 1 })
    expect(prompts.filter((prompt) => prompt.includes('구현 담당자'))).toHaveLength(1)
    fixture.store.close()
  })

  it('retries environment and verification without running the Implementer again', async () => {
    let callsPath = ''
    let sentinelPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'verification-retry-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      makefile: 'setup:\n\t@test -f "$(SENTINEL)"\n\ntest:\n\t@true\n',
      setupCommand: 'make setup',
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })
    sentinelPath = join(fixture.directory, 'environment-ready')
    const project = fixture.store.getProject(fixture.store.getTask(fixture.taskId).projectId)
    fixture.store.updateProject({
      projectId: project.id,
      name: project.name,
      setupCommand: `make setup SENTINEL=${sentinelPath}`,
      testCommand: project.testCommand,
      runtimeAdapter: project.runtimeAdapter
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('프로젝트 검증 환경을 준비하지 못했습니다.')
    expect(fixture.store.getTask(fixture.taskId).status).toBe('blocked_environment')
    await writeFile(sentinelPath, 'ready\n')

    await fixture.runner.retryVerification(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(task).toMatchObject({ status: 'awaiting_approval', attempt: 0 })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('최종 읽기 전용 Reviewer')
    expect(prompts[0]).not.toContain('구현 담당자')
    fixture.store.close()
  })

  it('requires a validation command before creating a worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runner-'))
    temporaryDirectories.push(directory)
    const repository = join(directory, 'repository')
    await mkdir(repository)
    const store = new AppStore(join(directory, 'store.sqlite'))
    const project = store.addProject('Fixture', repository)
    const task = store.createTask(project.id, '검증 없는 작업', '검증 명령 없이는 실행하지 않아야 한다.', 2)
    const runner = new AgentRunner(store, join(directory, 'worktrees'), () => undefined)

    await expect(runner.run(task.id)).rejects.toThrow('검증 명령을 등록한 뒤 작업을 실행하세요.')
    expect(store.getTask(task.id).status).toBe('queued')
    store.close()
  })

  it('runs a manual-review task without a project test command and waits for human validation', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'manual-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      testCommand: null,
      verificationPlan: {
        version: 1,
        mode: 'manual-review',
        testDesign: 'skip',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(prompts).toHaveLength(2)
    expect(prompts.some((prompt) => prompt.includes('테스트 설계자'))).toBe(false)
    expect(task.status).toBe('awaiting_manual_validation')
    expect(task.verificationResult).toMatchObject({
      testDesign: { status: 'skipped' },
      projectTests: { status: 'skipped' },
      simulatorRuntime: { status: 'skipped' },
      reviewer: { status: 'passed' }
    })
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'test_started')).toBe(false)
    await fixture.runner.dispose()
    fixture.store.close()
  })

  it('passes the task model and reasoning effort to each Codex role', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'model-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      testCommand: null,
      verificationPlan: {
        version: 1,
        mode: 'manual-review',
        testDesign: 'skip',
        runtimeSource: 'off'
      },
      modelPlan: {
        version: 1,
        source: 'task',
        resolvedAt: '2026-09-05T00:00:00.000Z',
        roles: {
          planning: { model: 'gpt-planning', reasoningEffort: 'medium' },
          'test-designer': { model: 'gpt-test-designer', reasoningEffort: 'high' },
          critic: { model: 'gpt-critic', reasoningEffort: 'high' },
          implementer: { model: 'gpt-implementer', reasoningEffort: 'high' },
          reviewer: { model: 'gpt-reviewer', reasoningEffort: 'xhigh' }
        }
      }
    })

    await fixture.runner.run(fixture.taskId)

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(expect.arrayContaining([
      '--model',
      'gpt-implementer',
      '--config',
      'model_reasoning_effort="high"'
    ]))
    expect(calls[1]).toEqual(expect.arrayContaining([
      '--model',
      'gpt-reviewer',
      '--config',
      'model_reasoning_effort="xhigh"'
    ]))
    fixture.store.close()
  })

  it('runs hierarchical stages with the planning root and one configured role subagent', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'hierarchical-model-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      testCommand: null,
      verificationPlan: {
        version: 1,
        mode: 'manual-review',
        testDesign: 'skip',
        runtimeSource: 'off'
      },
      modelPlan: {
        version: 1,
        source: 'task',
        executionMode: 'root-subagents',
        resolvedAt: '2026-09-05T00:00:00.000Z',
        roles: {
          planning: { model: 'gpt-root', reasoningEffort: 'high' },
          'test-designer': { model: 'gpt-test-designer', reasoningEffort: 'high' },
          critic: { model: 'gpt-critic', reasoningEffort: 'high' },
          implementer: { model: 'gpt-implementer', reasoningEffort: 'medium' },
          reviewer: { model: 'gpt-reviewer', reasoningEffort: 'xhigh' }
        }
      }
    })

    await fixture.runner.run(fixture.taskId)

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      args: string[]
      prompt: string
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toEqual(expect.arrayContaining([
      '--model',
      'gpt-root',
      '--config',
      'model_reasoning_effort="high"',
      'agents.enabled=true',
      'agents.max_concurrent_threads_per_session=1',
      'agents.default_subagent_model="gpt-implementer"',
      'agents.default_subagent_reasoning_effort="medium"'
    ]))
    expect(calls[0].prompt).toContain('Implementer 역할의 Codex 서브에이전트를 정확히 한 명 생성해 위임하세요.')
    expect(calls[0].prompt).toContain('다른 쓰기 에이전트를 만들거나 동시에 파일을 수정하지 마세요.')
    expect(calls[1].args).toEqual(expect.arrayContaining([
      '--model',
      'gpt-root',
      'agents.default_subagent_model="gpt-reviewer"',
      'agents.default_subagent_reasoning_effort="xhigh"'
    ]))
    expect(calls[1].prompt).toContain('Reviewer 역할의 Codex 서브에이전트를 정확히 한 명 생성해 위임하세요.')
    expect(calls[1].prompt).toContain('루트 모두 읽기 전용')
    fixture.store.close()
  })

  it('runs a Simulator-only task without invoking Test Designer or the project test command', async () => {
    let callsPath = ''
    let launchCount = 0
    const runtimeContract: ApprovedRuntimeContract = {
      version: 1,
      adapter: {
        kind: 'ios-simulator',
        container: 'App.xcodeproj',
        scheme: 'App',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      capabilities: { build: true, run: true, observe: [], act: [], verify: [] },
      runtimeScenario: { actions: [], assertions: [] }
    }
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'runtime-only-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      testCommand: null,
      runtimeContract,
      verificationPlan: {
        version: 1,
        mode: 'simulator-runtime',
        testDesign: 'skip',
        runtimeSource: 'task-scenario'
      },
      runtimeAdapter: {
        launch: async (input) => {
          launchCount += 1
          return {
            deviceId: 'IPHONE-UDID',
            deviceName: 'iPhone 16 Pro',
            bundleIdentifier: 'com.example.App',
            processId: 101,
            appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
            screenEvidence: null,
            accessibilityEvidence: null,
            uiActionEvidence: null,
            debugStateEvidence: null
          }
        },
        stop: async () => undefined
      }
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    expect(prompts).toHaveLength(2)
    expect(launchCount).toBe(1)
    expect(task.status).toBe('awaiting_approval')
    expect(task.verificationResult).toMatchObject({
      testDesign: { status: 'skipped' },
      projectTests: { status: 'skipped' },
      simulatorRuntime: { status: 'passed' },
      reviewer: { status: 'passed' }
    })
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'test_started')).toBe(false)
    await fixture.runner.dispose()
    fixture.store.close()
  })

  it('recovers a disconnected Simulator service and reruns runtime verification in the same attempt', async () => {
    let launchCount = 0
    let preflightCount = 0
    const runtimeContract: ApprovedRuntimeContract = {
      version: 1,
      adapter: {
        kind: 'ios-simulator',
        container: 'App.xcodeproj',
        scheme: 'App',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      capabilities: { build: true, run: true, observe: [], act: [], verify: [] },
      runtimeScenario: { actions: [], assertions: [] }
    }
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? ''
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      testCommand: null,
      runtimeContract,
      verificationPlan: {
        version: 1,
        mode: 'simulator-runtime',
        testDesign: 'skip',
        runtimeSource: 'task-scenario'
      },
      runtimePreparer: async () => {
        preflightCount += 1
        return { containerGenerated: false, simulatorRecovered: preflightCount === 3 }
      },
      runtimeAdapter: {
        launch: async (input) => {
          launchCount += 1
          if (launchCount === 1) {
            throw new IosRuntimeStageError(
              'preparing',
              'CoreSimulatorService connection became invalid'
            )
          }
          return {
            deviceId: 'IPHONE-UDID',
            deviceName: 'iPhone 16 Pro',
            bundleIdentifier: 'com.example.App',
            processId: 101,
            appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
            screenEvidence: null,
            accessibilityEvidence: null,
            uiActionEvidence: null,
            debugStateEvidence: null
          }
        },
        stop: async () => undefined
      }
    })

    await fixture.runner.run(fixture.taskId)

    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({
      status: 'awaiting_approval',
      attempt: 1
    })
    expect(launchCount).toBe(2)
    expect(preflightCount).toBe(3)
    expect(fixture.store.getSnapshot().events.some(
      (event) => event.message.includes('같은 검증을 한 번 다시 실행합니다')
    )).toBe(true)
    await fixture.runner.dispose()
    fixture.store.close()
  })

  it('uses the task approval snapshot even when the repository has no project manifest', async () => {
    let launchCount = 0
    const runtimeContract: ApprovedRuntimeContract = {
      version: 1,
      adapter: {
        kind: 'ios-simulator',
        container: 'App.xcodeproj',
        scheme: 'App',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      capabilities: {
        build: true,
        run: true,
        observe: ['screen', 'accessibility'],
        act: ['ui'],
        verify: ['test-command', 'runtime-scenario']
      },
      runtimeScenario: {
        actions: [{ kind: 'tap', identifier: 'save-profile', timeoutSeconds: 10 }],
        assertions: [
          {
            kind: 'accessibility',
            name: '저장 완료 표시',
            identifier: 'profile-saved',
            property: 'exists',
            expected: true
          }
        ]
      }
    }
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      runtimeContract,
      runtimeAdapter: {
        launch: async (input) => {
          launchCount += 1
          expect(input.contract).toMatchObject({ deviceFamily: 'iphone', scheme: 'App' })
          expect(input.uiActions).toEqual([
            { kind: 'tap', identifier: 'save-profile', timeoutSeconds: 10 }
          ])
          throw new IosRuntimeStageError('launching', '승인 스냅샷 사용 확인')
        },
        stop: async () => undefined
      }
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('승인 스냅샷 사용 확인')
    expect(launchCount).toBe(1)
    expect(fixture.store.getTask(fixture.taskId).runtimeContract).toEqual(runtimeContract)
    fixture.store.close()
  })

  it('times out a Codex process group and records a distinct failure', async () => {
    let pidPath = ''
    let heartbeatPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        pidPath = join(directory, 'codex-pids.json')
        heartbeatPath = join(directory, 'grandchild-heartbeat.txt')
        const childSource = [
          "const { appendFileSync } = require('node:fs')",
          `const heartbeat = ${JSON.stringify(heartbeatPath)}`,
          "process.on('SIGTERM', () => undefined)",
          "setInterval(() => appendFileSync(heartbeat, 'x'), 20)"
        ].join(';')
        return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, child: child.pid }))
process.on('SIGTERM', () => undefined)
setInterval(() => undefined, 1_000)
`
      },
      policy: { codexStageTimeoutMs: 2_000, testCommandTimeoutMs: 2_000, terminationGraceMs: 50 }
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('test-designer 단계 제한 시간 초과 (2초)')

    const pids = JSON.parse(await waitForFile(pidPath)) as { parent: number; child: number }
    const heartbeatBefore = await waitForFile(heartbeatPath)
    await delay(120)
    const heartbeatAfter = await readFile(heartbeatPath, 'utf8')
    expect(heartbeatAfter).toBe(heartbeatBefore)
    expect(() => process.kill(pids.parent, 0)).toThrow()
    expect(fixture.store.getTask(fixture.taskId).status).toBe('failed')
    expect(fixture.store.getSnapshot().events.some((event) => event.kind === 'task_timed_out')).toBe(true)
    expect(fixture.store.getSnapshot().findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('test-designer 단계 시간 초과') })])
    )
    fixture.store.close()
  })

  it('times out a hanging project validation command', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      makefile: "test:\n\t@trap '' TERM; while :; do sleep 1; done\n",
      policy: { codexStageTimeoutMs: 2_000, testCommandTimeoutMs: 300, terminationGraceMs: 50 }
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow(
      '검증 명령 (make test) 제한 시간 초과 (1초)'
    )
    expect(fixture.store.getTask(fixture.taskId).status).toBe('failed')
    expect(fixture.store.getSnapshot().findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining('검증 명령 (make test) 시간 초과') })])
    )
    fixture.store.close()
  })

  it('keeps a user-initiated stop distinct from a timeout', async () => {
    let startedPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        startedPath = join(directory, 'codex-started.txt')
        return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, String(process.pid))
setInterval(() => undefined, 1_000)
`
      },
      policy: { codexStageTimeoutMs: 5_000, testCommandTimeoutMs: 2_000, terminationGraceMs: 50 }
    })

    const runPromise = fixture.runner.run(fixture.taskId)
    const stopped = expect(runPromise).rejects.toThrow('사용자가 작업을 중단했습니다.')
    await waitForFile(startedPath)
    await fixture.runner.stop(fixture.taskId)
    await stopped

    expect(fixture.store.getTask(fixture.taskId).status).toBe('stopped')
    expect(fixture.store.getSnapshot().events.some((event) => event.kind === 'task_stopped')).toBe(true)
    expect(fixture.store.getSnapshot().findings.some((finding) => finding.title.includes('시간 초과'))).toBe(false)
    fixture.store.close()
  })

  it('waits for active runs to stop when the runner is disposed', async () => {
    let startedPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        startedPath = join(directory, 'dispose-started.txt')
        return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(startedPath)}, String(process.pid))
setInterval(() => undefined, 1_000)
`
      },
      policy: { codexStageTimeoutMs: 5_000, testCommandTimeoutMs: 2_000, terminationGraceMs: 50 }
    })

    const runPromise = fixture.runner.run(fixture.taskId)
    const stopped = expect(runPromise).rejects.toThrow('사용자가 작업을 중단했습니다.')
    await waitForFile(startedPath)
    await fixture.runner.dispose()
    await stopped

    expect(fixture.runner.isRunning(fixture.taskId)).toBe(false)
    expect(fixture.store.getTask(fixture.taskId).status).toBe('stopped')
    fixture.store.close()
  })

  it('feeds Reviewer findings back to the Implementer before stopping for approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runner-'))
    temporaryDirectories.push(directory)
    const repository = join(directory, 'repository')
    const worktrees = join(directory, 'worktrees')
    await mkdir(repository)
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), '# Fixture\n')
    await writeFile(join(repository, 'Makefile'), 'test:\n\t@true\n')
    await execFileAsync('git', ['add', 'README.md', 'Makefile'], { cwd: repository })
    await execFileAsync('git', ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'init'], {
      cwd: repository
    })
    await configureOrigin(directory, repository)

    const fakeCodex = join(directory, 'fake-codex.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
  import { existsSync, writeFileSync } from 'node:fs'
  const prompt = process.argv.at(-1) ?? ''
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }))
  if (prompt.includes('구현 담당자')) {
    writeFileSync('agent-output.txt', 'implemented\\n')
    writeFileSync('agent-codex-home.txt', process.env.CODEX_HOME ?? '')
    if (prompt.includes('직전 Reviewer')) writeFileSync('review-fix.txt', 'reviewed\\n')
  }
  const message = prompt.includes('최종 읽기 전용 Reviewer')
    ? existsSync('review-fix.txt') ? 'VERDICT: PASS' : '[medium] 빈 입력 회귀 검토 필요'
    : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
    )
    await chmod(fakeCodex, 0o755)

    const store = new AppStore(join(directory, 'store.sqlite'))
    const project = store.addProject('Fixture', repository)
    store.updateProject({
      projectId: project.id,
      name: project.name,
      setupCommand: '',
      testCommand: 'make test',
      publishStrategy: 'direct'
    })
    const task = store.createTask(project.id, '기능 구현', 'fixture 파일을 생성하고 검토한다.', 2)
    const published: Array<{ actor: string; message: string }> = []
    const codexHome = join(directory, 'codex-home')
    const runner = new AgentRunner(store, worktrees, (event) => published.push(event), fakeCodex, codexHome)

    await runner.run(task.id)

    const awaitingApproval = store.getTask(task.id)
    expect(awaitingApproval.status).toBe('awaiting_approval')
    expect(awaitingApproval.worktreePath).toBeTruthy()
    expect(await readFile(join(awaitingApproval.worktreePath!, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    expect(await readFile(join(awaitingApproval.worktreePath!, 'agent-codex-home.txt'), 'utf8')).toBe(codexHome)
    expect(await readFile(join(awaitingApproval.worktreePath!, 'review-fix.txt'), 'utf8')).toBe('reviewed\n')
    expect(awaitingApproval.attempt).toBe(2)
    expect(published.some((event) => event.actor === 'test-designer')).toBe(true)
    expect(published.some((event) => event.actor === 'critic')).toBe(true)
    expect(
      published.filter((event) => event.actor === 'reviewer' && event.message.startsWith('reviewer 단계 시작 · '))
    ).toHaveLength(2)
    expect(store.getSnapshot(project.id).findings).toMatchObject([
      { severity: 'medium', title: '빈 입력 회귀 검토 필요', resolved: true }
    ])

    const changes = await runner.getChanges(task.id)
    expect(changes.available).toBe(true)
    expect(changes.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'agent-output.txt', status: '??', additions: 1, deletions: 0 })
    ]))
    expect(changes.patch).toContain("diff --git a/agent-output.txt b/agent-output.txt")

    await runner.approve(task.id)
    const completed = store.getTask(task.id)
    expect(completed.status).toBe('completed')
    expect(completed.worktreePath).toBeNull()
    expect(await readFile(join(repository, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    expect(await readFile(join(repository, 'agent-codex-home.txt'), 'utf8')).toBe(codexHome)
    store.close()
  })

  it('keeps cumulative Reviewer findings so later repairs cannot reintroduce earlier regressions', async () => {
    let callsPath = ''
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'cumulative-reviewer-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
let message = 'stage complete'
if (prompt.includes('최종 읽기 전용 Reviewer')) {
  if (!existsSync('.reviewed-once')) {
    writeFileSync('.reviewed-once', 'true\\n')
    message = '[medium] MapKit과 Mapbox 버튼 위치가 다릅니다.'
  } else if (!existsSync('.reviewed-twice')) {
    writeFileSync('.reviewed-twice', 'true\\n')
    message = '[high] Mapbox 지도 정보 버튼과 겹칩니다.'
  } else {
    message = prompt.includes('MapKit과 Mapbox 버튼 위치가 다릅니다.') &&
      prompt.includes('Mapbox 지도 정보 버튼과 겹칩니다.')
      ? 'VERDICT: PASS'
      : '[high] 이전 Reviewer 조건이 누락됐습니다.'
  }
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      maxAttempts: 3,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })

    await fixture.runner.run(fixture.taskId)

    const prompts = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
    const finalImplementerPrompt = prompts.filter((prompt) => prompt.includes('구현 담당자')).at(-1) ?? ''
    const finalReviewerPrompt = prompts.filter((prompt) => prompt.includes('최종 읽기 전용 Reviewer')).at(-1) ?? ''
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({ status: 'awaiting_approval', attempt: 3 })
    expect(finalImplementerPrompt).toContain('MapKit과 Mapbox 버튼 위치가 다릅니다.')
    expect(finalImplementerPrompt).toContain('Mapbox 지도 정보 버튼과 겹칩니다.')
    expect(finalImplementerPrompt).toContain('테스트 전용 가짜 credential로 대체하지 말고')
    expect(finalReviewerPrompt).toContain('MapKit과 Mapbox 버튼 위치가 다릅니다.')
    expect(finalReviewerPrompt).toContain('Mapbox 지도 정보 버튼과 겹칩니다.')
    expect(finalReviewerPrompt).toContain('Git에서 제외된 로컬 xcconfig')
    expect(finalReviewerPrompt).toContain('비밀값 없는 깨끗한 checkout에서도 동일 분기가 실행돼야 한다고 요구하지 마세요.')
    expect(finalReviewerPrompt).toContain('테스트 전용 가짜·placeholder credential')
    expect(fixture.store.listTaskFindings(fixture.taskId)).toEqual([])
    fixture.store.close()
  })

  it('keeps final Reviewer findings for human judgment after the implementation limit', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? ''
const message = prompt.includes('최종 읽기 전용 Reviewer')
  ? '[high] 사용자 승인 전에 확인할 회귀 위험'
  : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      maxAttempts: 1
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    const snapshot = fixture.store.getSnapshot(task.projectId)
    expect(task).toMatchObject({ status: 'awaiting_approval', attempt: 1 })
    expect(snapshot.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '사용자 승인 전에 확인할 회귀 위험',
          severity: 'high',
          resolved: false
        })
      ])
    )
    expect(snapshot.events.some((event) => event.message.includes('사람의 판단을 기다립니다.'))).toBe(true)
    fixture.store.close()
  })

  it('launches an iPad runtime and gives UI action, screen, and accessibility evidence to the reviewer', async () => {
    const launchedWorktrees: string[] = []
    const stoppedBundles: string[] = []
    let screenEvidencePath = ''
    let accessibilityEvidencePath = ''
    let uiActionEvidencePath = ''
    let debugStateEvidencePath = ''
    const runtimeAdapter: IosSimulatorRuntimeAdapter = {
      launch: async (input) => {
        launchedWorktrees.push(input.worktreePath)
        expect(input.captureScreen).toBe(true)
        expect(input.captureAccessibility).toBe(true)
        expect(input.captureState).toBe(true)
        expect(input.debugBridge).toEqual({ protocol: 'file-v1', responseTimeoutSeconds: 10 })
        expect(input.debugFixture).toEqual({
          id: 'signed-in-home',
          payload: { accountID: 'fixture-user', selectedTab: 'home' }
        })
        expect(input.uiActions).toMatchObject([
          { kind: 'tap', identifier: 'start-navigation' },
          { kind: 'type-text', identifier: 'destination-search', text: '부산항' }
        ])
        expect(input.contract.deviceFamily).toBe('ipad')
        input.onProgress('booting', 'iPad 부팅')
        input.onProgress('building', 'Swift 앱 빌드')
        const evidenceDirectory = join(input.runtimeRoot, input.taskId, 'evidence')
        await mkdir(evidenceDirectory, { recursive: true })
        screenEvidencePath = join(evidenceDirectory, 'screen-fixture.png')
        await writeFile(screenEvidencePath, 'fixture-png')
        accessibilityEvidencePath = join(evidenceDirectory, 'accessibility-fixture.json')
        const accessibilityContent = '{"schemaVersion":1,"root":{"label":"항해 시작"}}\n'
        await writeFile(accessibilityEvidencePath, accessibilityContent)
        uiActionEvidencePath = join(evidenceDirectory, 'ui-actions-fixture.json')
        const uiActionContent = '{"schemaVersion":1,"actionCount":2,"results":[{"identifier":"start-navigation"},{"identifier":"destination-search"}]}\n'
        await writeFile(uiActionEvidencePath, uiActionContent)
        debugStateEvidencePath = join(evidenceDirectory, 'debug-state-fixture.json')
        const debugStateContent = '{"schemaVersion":1,"fixture":{"id":"signed-in-home"},"state":{"route":"home","selectedTab":"home"}}\n'
        await writeFile(debugStateEvidencePath, debugStateContent)
        return {
          deviceId: 'IPAD-UDID',
          deviceName: 'iPad Pro 13-inch',
          bundleIdentifier: 'com.example.App',
          processId: 4242,
          appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
          screenEvidence: {
            path: screenEvidencePath,
            mimeType: 'image/png',
            sizeBytes: 11,
            capturedAt: new Date().toISOString()
          },
          accessibilityEvidence: {
            path: accessibilityEvidencePath,
            mimeType: 'application/json',
            sizeBytes: Buffer.byteLength(accessibilityContent),
            capturedAt: new Date().toISOString(),
            nodeCount: 2,
            truncated: false,
            content: accessibilityContent
          },
          uiActionEvidence: {
            path: uiActionEvidencePath,
            mimeType: 'application/json',
            sizeBytes: Buffer.byteLength(uiActionContent),
            executedAt: new Date().toISOString(),
            actionCount: 2,
            content: uiActionContent
          },
          debugStateEvidence: {
            path: debugStateEvidencePath,
            mimeType: 'application/json',
            sizeBytes: Buffer.byteLength(debugStateContent),
            capturedAt: new Date().toISOString(),
            hasState: true,
            fixtureId: 'signed-in-home',
            content: debugStateContent
          }
        }
      },
      stop: async ({ session }) => {
        stoppedBundles.push(session.bundleIdentifier ?? '')
      }
    }
    const fixture = await createExecutionFixture({
      codexSource: (directory) => `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(directory, 'codex-argv.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      withRuntimeManifest: true,
      withScreenObservation: true,
      withAccessibilityObservation: true,
      withUiActions: true,
      withDebugState: true,
      withDebugFixture: true,
      runtimeAssertions: [
        {
          kind: 'state',
          name: '선택 탭 확인',
          path: ['selectedTab'],
          operator: 'equals',
          expected: 'home'
        },
        { kind: 'evidence', target: 'screen' }
      ],
      runtimeAdapter
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    expect(task.status).toBe('awaiting_approval')
    expect(launchedWorktrees).toEqual([task.worktreePath])
    expect(fixture.store.getRuntimeSession(task.id)).toMatchObject({
      status: 'running',
      deviceName: 'iPad Pro 13-inch',
      bundleIdentifier: 'com.example.App',
      processId: 4242
    })
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'runtime_ready')).toBe(true)
    expect(fixture.store.getSnapshot(task.projectId).runtimeEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: task.id,
          kind: 'screen',
          path: screenEvidencePath,
          mimeType: 'image/png',
          sizeBytes: 11
        }),
        expect.objectContaining({
          taskId: task.id,
          kind: 'accessibility',
          path: accessibilityEvidencePath,
          mimeType: 'application/json'
        }),
        expect.objectContaining({
          taskId: task.id,
          kind: 'ui-actions',
          path: uiActionEvidencePath,
          mimeType: 'application/json'
        }),
        expect.objectContaining({
          taskId: task.id,
          kind: 'debug-state',
          path: debugStateEvidencePath,
          mimeType: 'application/json'
        }),
        expect.objectContaining({
          taskId: task.id,
          kind: 'runtime-verification',
          attempt: 1,
          outcome: 'passed',
          summary: 'runtime acceptance 2/2 통과',
          mimeType: 'application/json'
        })
      ])
    )
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'runtime_observed')).toBe(true)
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'runtime_acted')).toBe(true)
    expect(fixture.store.getSnapshot(task.projectId).events.some((event) => event.kind === 'runtime_verified')).toBe(true)
    const codexCalls = (await readFile(join(fixture.directory, 'codex-argv.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    expect(codexCalls.at(-1)).toEqual(expect.arrayContaining(['--image', screenEvidencePath]))
    expect(codexCalls.at(-1)?.join('\n')).toContain('항해 시작')
    expect(codexCalls.at(-1)?.join('\n')).toContain('destination-search')
    expect(codexCalls.at(-1)?.join('\n')).toContain('signed-in-home')
    expect(codexCalls.at(-1)?.join('\n')).toContain('selectedTab')
    expect(codexCalls.at(-1)?.join('\n')).toContain('runtime acceptance assertion')

    await fixture.runner.discard(task.id)
    expect(stoppedBundles).toEqual(['com.example.App'])
    expect(fixture.store.getRuntimeSession(task.id)).toMatchObject({ status: 'stopped', processId: null })
    fixture.store.close()
  })

  it('stores failed runtime assertions and stops before reviewer approval', async () => {
    const accessibilityContent = JSON.stringify({
      schemaVersion: 1,
      root: { identifier: 'root', children: [] }
    })
    const runtimeAdapter: IosSimulatorRuntimeAdapter = {
      launch: async (input) => {
        const evidenceDirectory = join(input.runtimeRoot, input.taskId, 'evidence')
        await mkdir(evidenceDirectory, { recursive: true })
        const accessibilityPath = join(evidenceDirectory, 'accessibility-fixture.json')
        await writeFile(accessibilityPath, accessibilityContent)
        return {
          deviceId: 'IPAD-UDID',
          deviceName: 'iPad Pro 13-inch',
          bundleIdentifier: 'com.example.App',
          processId: 4242,
          appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
          screenEvidence: null,
          accessibilityEvidence: {
            path: accessibilityPath,
            mimeType: 'application/json',
            sizeBytes: Buffer.byteLength(accessibilityContent),
            capturedAt: new Date().toISOString(),
            nodeCount: 1,
            truncated: false,
            content: accessibilityContent
          },
          uiActionEvidence: null,
          debugStateEvidence: null
        }
      },
      stop: async () => undefined
    }
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      withRuntimeManifest: true,
      withAccessibilityObservation: true,
      runtimeAssertions: [
        {
          kind: 'accessibility',
          name: '오류 배너 표시',
          identifier: 'error-banner',
          property: 'exists',
          expected: true
        }
      ],
      runtimeAdapter
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toMatchObject({
      status: 'verifying'
    })

    const task = fixture.store.getTask(fixture.taskId)
    const snapshot = fixture.store.getSnapshot(task.projectId)
    const verification = snapshot.runtimeEvidence.find(
      (item) => item.kind === 'runtime-verification'
    )
    expect(task.status).toBe('failed')
    expect(fixture.store.getRuntimeSession(task.id)).toMatchObject({ status: 'failed' })
    expect(verification).toBeDefined()
    expect(verification).toMatchObject({
      attempt: 1,
      outcome: 'failed',
      summary: expect.stringContaining('runtime acceptance 0/1 통과')
    })
    expect(JSON.parse(await readFile(verification!.path, 'utf8'))).toMatchObject({
      passed: false,
      assertionCount: 1,
      passedCount: 0,
      results: [expect.objectContaining({ description: '오류 배너 표시', passed: false })]
    })
    expect(snapshot.events.some((event) => event.kind === 'runtime_verified')).toBe(true)
    expect(snapshot.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: expect.stringContaining('Swift runtime verifying 단계 실패') })
      ])
    )
    fixture.store.close()
  })

  it('returns failed runtime evidence to the implementer and verifies the repaired app again', async () => {
    let launchCount = 0
    const stoppedBundles: string[] = []
    const runtimeAdapter: IosSimulatorRuntimeAdapter = {
      launch: async (input) => {
        launchCount += 1
        const evidenceDirectory = join(input.runtimeRoot, input.taskId, 'evidence')
        await mkdir(evidenceDirectory, { recursive: true })
        const screenPath = join(evidenceDirectory, `screen-${launchCount}.png`)
        await writeFile(screenPath, `screen-${launchCount}`)
        const accessibilityPath = join(
          evidenceDirectory,
          `accessibility-${launchCount}.json`
        )
        const accessibilityContent = JSON.stringify({
          schemaVersion: 1,
          root: {
            identifier: 'root',
            children: launchCount === 1
              ? []
              : [{ identifier: 'error-banner', label: '연결 실패', children: [] }]
          }
        })
        await writeFile(accessibilityPath, accessibilityContent)
        return {
          deviceId: 'IPHONE-UDID',
          deviceName: 'iPhone 17 Pro',
          bundleIdentifier: 'com.example.App',
          processId: 4242 + launchCount,
          appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
          screenEvidence: {
            path: screenPath,
            mimeType: 'image/png',
            sizeBytes: Buffer.byteLength(`screen-${launchCount}`),
            capturedAt: new Date().toISOString()
          },
          accessibilityEvidence: {
            path: accessibilityPath,
            mimeType: 'application/json',
            sizeBytes: Buffer.byteLength(accessibilityContent),
            capturedAt: new Date().toISOString(),
            nodeCount: launchCount === 1 ? 1 : 2,
            truncated: false,
            content: accessibilityContent
          },
          uiActionEvidence: null,
          debugStateEvidence: null
        }
      },
      stop: async ({ session }) => {
        stoppedBundles.push(session.bundleIdentifier ?? '')
      }
    }
    const fixture = await createExecutionFixture({
      codexSource: (directory) => `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(join(directory, 'repair-codex-argv.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      withRuntimeManifest: true,
      withScreenObservation: true,
      withAccessibilityObservation: true,
      runtimeAssertions: [
        {
          kind: 'accessibility',
          name: '오류 배너 표시',
          identifier: 'error-banner',
          property: 'exists',
          expected: true
        }
      ],
      maxAttempts: 2,
      runtimeAdapter
    })

    await fixture.runner.run(fixture.taskId)

    const task = fixture.store.getTask(fixture.taskId)
    const snapshot = fixture.store.getSnapshot(task.projectId)
    const verificationRecords = snapshot.runtimeEvidence.filter(
      (item) => item.kind === 'runtime-verification'
    )
    const reports = await Promise.all(
      verificationRecords
        .map(async (item) => JSON.parse(await readFile(item.path, 'utf8')) as { passed: boolean })
    )
    expect(task).toMatchObject({ status: 'awaiting_approval', attempt: 2 })
    expect(launchCount).toBe(2)
    expect(reports.map((report) => report.passed).sort()).toEqual([false, true])
    expect(new Set(verificationRecords.map((item) => item.runId)).size).toBe(1)
    expect(verificationRecords.map(({ attempt, outcome }) => ({ attempt, outcome }))).toEqual([
      { attempt: 2, outcome: 'passed' },
      { attempt: 1, outcome: 'failed' }
    ])
    expect(snapshot.events.some((event) => event.kind === 'runtime_repair_started')).toBe(true)
    expect(snapshot.events.filter((event) => event.kind === 'runtime_verified')).toHaveLength(2)
    expect(snapshot.findings).toEqual([])

    const codexCalls = (await readFile(join(fixture.directory, 'repair-codex-argv.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const repairCall = codexCalls.find((call) =>
      call.join('\n').includes('직전 runtime acceptance 검증이 실패했습니다.')
    )
    expect(repairCall).toEqual(expect.arrayContaining(['--image']))
    expect(repairCall?.join('\n')).toContain('오류 배너 표시')
    expect(repairCall?.join('\n')).toContain('"actual": "false"')

    await fixture.runner.discard(task.id)
    expect(stoppedBundles).toEqual(['com.example.App', 'com.example.App'])
    fixture.store.close()
  })

  it('returns a missing app identifier action to the implementer instead of failing immediately', async () => {
    let launchCount = 0
    let callsPath = ''
    const runtimeContract: ApprovedRuntimeContract = {
      version: 1,
      adapter: {
        kind: 'ios-simulator',
        container: 'App.xcodeproj',
        scheme: 'App',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      capabilities: {
        build: true,
        run: true,
        observe: [],
        act: ['ui'],
        verify: ['runtime-scenario']
      },
      runtimeScenario: {
        actions: [{ kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }],
        assertions: []
      }
    }
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'identifier-repair-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      testCommand: null,
      runtimeContract,
      verificationPlan: {
        version: 1,
        mode: 'simulator-runtime',
        testDesign: 'skip',
        runtimeSource: 'task-scenario'
      },
      maxAttempts: 2,
      runtimeAdapter: {
        launch: async (input) => {
          launchCount += 1
          expect(input.privacyPermissions).toEqual([])
          if (launchCount === 1) {
            throw new IosRuntimeStageError(
              'acting',
              "Simulator identifier UI 조작 실패\nUI action 1: identifier 'map-current-location-button' 요소를 찾지 못했습니다."
            )
          }
          const evidenceDirectory = join(input.runtimeRoot, input.taskId, 'evidence')
          await mkdir(evidenceDirectory, { recursive: true })
          const actionPath = join(evidenceDirectory, 'ui-actions.json')
          const actionContent = JSON.stringify({
            schemaVersion: 1,
            actionCount: 1,
            results: [{ index: 0, kind: 'tap', identifier: 'map-current-location-button' }]
          })
          await writeFile(actionPath, actionContent)
          return {
            deviceId: 'IPHONE-UDID',
            deviceName: 'iPhone 17 Pro',
            bundleIdentifier: 'com.example.App',
            processId: 4242,
            appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
            screenEvidence: null,
            accessibilityEvidence: null,
            uiActionEvidence: {
              path: actionPath,
              mimeType: 'application/json',
              sizeBytes: Buffer.byteLength(actionContent),
              executedAt: new Date().toISOString(),
              actionCount: 1,
              content: actionContent
            },
            debugStateEvidence: null
          }
        },
        stop: async () => undefined
      }
    })

    await fixture.runner.run(fixture.taskId)

    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({
      status: 'awaiting_approval',
      attempt: 2
    })
    expect(launchCount).toBe(2)
    const prompts = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string)
    expect(prompts.some((prompt) => (
      prompt.includes("앱 identifier 'map-current-location-button'") &&
      prompt.includes('직전 runtime acceptance 검증이 실패했습니다.')
    ))).toBe(true)
    expect(fixture.store.getSnapshot().events.some(
      (event) => event.kind === 'runtime_repair_started'
    )).toBe(true)
    await fixture.runner.dispose()
    fixture.store.close()
  })

  it('converts a legacy iOS location prompt action before implementation and runtime', async () => {
    let receivedPermissions: unknown = null
    let receivedActions: unknown = null
    let callsPath = ''
    const runtimeContract: ApprovedRuntimeContract = {
      version: 1,
      adapter: {
        kind: 'ios-simulator',
        container: 'App.xcodeproj',
        scheme: 'App',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      capabilities: { build: true, run: true, observe: [], act: ['ui'], verify: [] },
      runtimeScenario: {
        actions: [
          { kind: 'tap', identifier: '앱을 사용하는 동안 허용', timeoutSeconds: 10 },
          { kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }
        ],
        assertions: []
      }
    }
    const fixture = await createExecutionFixture({
      codexSource: (directory) => {
        callsPath = join(directory, 'legacy-permission-calls.jsonl')
        return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(prompt) + '\\n')
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
      },
      testCommand: null,
      runtimeContract,
      verificationPlan: {
        version: 1,
        mode: 'simulator-runtime',
        testDesign: 'skip',
        runtimeSource: 'task-scenario'
      },
      runtimeAdapter: {
        launch: async (input) => {
          receivedPermissions = input.privacyPermissions
          receivedActions = input.uiActions
          const evidenceDirectory = join(input.runtimeRoot, input.taskId, 'evidence')
          await mkdir(evidenceDirectory, { recursive: true })
          const actionPath = join(evidenceDirectory, 'ui-actions.json')
          const actionContent = JSON.stringify({
            schemaVersion: 1,
            actionCount: 1,
            results: [{ index: 0, kind: 'tap', identifier: 'map-current-location-button' }]
          })
          await writeFile(actionPath, actionContent)
          return {
            deviceId: 'IPHONE-UDID',
            deviceName: 'iPhone 17 Pro',
            bundleIdentifier: 'com.example.App',
            processId: 4242,
            appPath: join(input.runtimeRoot, input.taskId, 'App.app'),
            screenEvidence: null,
            accessibilityEvidence: null,
            uiActionEvidence: {
              path: actionPath,
              mimeType: 'application/json',
              sizeBytes: Buffer.byteLength(actionContent),
              executedAt: new Date().toISOString(),
              actionCount: 1,
              content: actionContent
            },
            debugStateEvidence: null
          }
        },
        stop: async () => undefined
      }
    })

    await fixture.runner.run(fixture.taskId)

    const prompts = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string)
    const implementerPrompt = prompts.find((prompt) => prompt.includes('당신은 구현 담당자입니다.')) ?? ''
    expect(receivedPermissions).toEqual([{ service: 'location', state: 'granted' }])
    expect(receivedActions).toEqual([
      { kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }
    ])
    expect(implementerPrompt).toContain('"permissions"')
    expect(implementerPrompt).not.toContain('"identifier": "앱을 사용하는 동안 허용"')
    expect(fixture.store.getTask(fixture.taskId).runtimeContract).toEqual(runtimeContract)
    await fixture.runner.dispose()
    fixture.store.close()
  })

  it('fails the task with a runtime finding when a required Swift build cannot launch', async () => {
    const stoppedBundles: string[] = []
    const runtimeAdapter: IosSimulatorRuntimeAdapter = {
      launch: async (input) => {
        expect(input.captureScreen).toBe(false)
        expect(input.captureAccessibility).toBe(false)
        expect(input.captureState).toBe(false)
        expect(input.debugBridge).toBeNull()
        expect(input.debugFixture).toBeNull()
        expect(input.uiActions).toEqual([])
        input.onProgress('launching', 'fixture 앱 실행 중', {
          deviceId: 'IPAD-UDID',
          deviceName: 'iPad Pro 13-inch',
          bundleIdentifier: 'com.example.App'
        })
        throw new IosRuntimeStageError('launching', 'fixture Swift 앱 실행 실패')
      },
      stop: async ({ session }) => {
        stoppedBundles.push(session.bundleIdentifier ?? '')
      }
    }
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      withRuntimeManifest: true,
      runtimeAdapter
    })

    await expect(fixture.runner.run(fixture.taskId)).rejects.toThrow('fixture Swift 앱 실행 실패')

    const task = fixture.store.getTask(fixture.taskId)
    expect(task.status).toBe('failed')
    expect(fixture.store.getRuntimeSession(task.id)).toMatchObject({
      status: 'failed',
      message: 'fixture Swift 앱 실행 실패',
      processId: null
    })
    expect(stoppedBundles).toEqual(['com.example.App'])
    expect(fixture.store.getSnapshot(task.projectId).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: expect.stringContaining('Swift runtime launching 단계 실패') })
      ])
    )
    fixture.store.close()
  })

  it('keeps the task awaiting approval when the original checkout is dirty', async () => {
    const fixture = await createApprovalFixture()
    await writeFile(join(fixture.repository, 'local-change.txt'), 'keep me\n')

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow(
      '원본 저장소에 커밋되지 않은 변경이 있습니다.'
    )
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    expect(fixture.store.getTask(fixture.taskId).worktreePath).toBe(fixture.worktreePath)
    await expect(readFile(join(fixture.repository, 'agent-output.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(fixture.worktreePath, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    fixture.store.close()
  })

  it('blocks publishing when an ignored xcconfig was force-added in the worktree', async () => {
    const fixture = await createApprovalFixture()
    await writeFile(join(fixture.repository, '.git', 'info', 'exclude'), 'Config/Secrets.xcconfig\n')
    await mkdir(join(fixture.repository, 'Config'), { recursive: true })
    await writeFile(join(fixture.repository, 'Config', 'Secrets.xcconfig'), 'MAPBOX_ACCESS_TOKEN = source-token\n')
    await mkdir(join(fixture.worktreePath, 'Config'), { recursive: true })
    await writeFile(join(fixture.worktreePath, 'Config', 'Secrets.xcconfig'), 'MAPBOX_ACCESS_TOKEN = staged-token\n')
    await execFileAsync('git', ['add', '--force', 'Config/Secrets.xcconfig'], { cwd: fixture.worktreePath })

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow(
      'Git 제외 상태가 아닌 xcconfig'
    )
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    expect(await readFile(join(fixture.repository, 'Config', 'Secrets.xcconfig'), 'utf8'))
      .toBe('MAPBOX_ACCESS_TOKEN = source-token\n')
    fixture.store.close()
  })

  it('publishes the existing task branch, opens a PR, and completes after the remote merge', async () => {
    const fixture = await createApprovalFixture({
      publishStrategy: 'pull-request',
      githubSource: `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
const headBranch = 'agentmonitor/approval-fixture'
const head = execFileSync('git', ['rev-parse', headBranch], { encoding: 'utf8' }).trim()
const remoteBase = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).trim().split(/\\s+/)[0]
const merged = remoteBase === head
const pullRequest = {
  state: merged ? 'MERGED' : 'OPEN',
  mergedAt: merged ? '2026-09-04T00:00:00Z' : null,
  url: 'https://github.com/example/fixture/pull/42',
  baseRefName: 'main',
  headRefName: headBranch,
  headRefOid: head,
  mergeCommit: merged ? { oid: head } : null
}
if (args[0] === 'auth' && args[1] === 'status') console.log('github.com authenticated')
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]')
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/example/fixture/pull/42')
else if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(pullRequest))
else process.exit(1)
`
    })

    await expect(fixture.runner.approve(fixture.taskId)).resolves.toMatchObject({ outcome: 'pr_opened' })
    const awaitingMerge = fixture.store.getTask(fixture.taskId)
    expect(awaitingMerge).toMatchObject({
      status: 'awaiting_merge',
      publication: {
        strategy: 'pull-request',
        status: 'awaiting_merge',
        pullRequestUrl: 'https://github.com/example/fixture/pull/42'
      }
    })
    const remoteTaskHead = await execFileAsync(
      'git',
      ['--git-dir', fixture.remote, 'rev-parse', `refs/heads/${awaitingMerge.branchName}`]
    )
    await execFileAsync(
      'git',
      ['--git-dir', fixture.remote, 'update-ref', 'refs/heads/main', remoteTaskHead.stdout.trim()]
    )

    await expect(fixture.runner.refreshPublication(fixture.taskId)).resolves.toMatchObject({ outcome: 'published' })
    const completed = fixture.store.getTask(fixture.taskId)
    expect(completed).toMatchObject({ status: 'completed', worktreePath: null, publication: { status: 'published' } })
    expect(await readFile(join(fixture.repository, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    fixture.store.close()
  })

  it('does not complete when the PR head changes after publication', async () => {
    const fixture = await createApprovalFixture({
      publishStrategy: 'pull-request',
      githubSource: `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
const headBranch = 'agentmonitor/approval-fixture'
const head = execFileSync('git', ['rev-parse', headBranch], { encoding: 'utf8' }).trim()
const statePath = fileURLToPath(import.meta.url) + '.state'
if (args[0] === 'auth' && args[1] === 'status') console.log('github.com authenticated')
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]')
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/example/fixture/pull/42')
else if (args[0] === 'pr' && args[1] === 'view') {
  const count = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0
  writeFileSync(statePath, String(count + 1))
  console.log(JSON.stringify({
    state: 'OPEN',
    mergedAt: null,
    url: 'https://github.com/example/fixture/pull/42',
    baseRefName: 'main',
    headRefName: headBranch,
    headRefOid: count === 0 ? head : '0000000000000000000000000000000000000000',
    mergeCommit: null
  }))
} else process.exit(1)
`
    })

    await expect(fixture.runner.approve(fixture.taskId)).resolves.toMatchObject({ outcome: 'pr_opened' })
    await expect(fixture.runner.refreshPublication(fixture.taskId)).resolves.toMatchObject({
      outcome: 'awaiting_merge',
      message: expect.stringContaining('PR head가 사람이 승인하고 검증한 commit에서 변경됐습니다.')
    })
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({
      status: 'awaiting_approval',
      publication: { status: 'failed' }
    })
    fixture.store.close()
  })

  it('accepts a verified squash or rebase merge commit that differs from the PR head', async () => {
    const fixture = await createApprovalFixture({
      publishStrategy: 'pull-request',
      githubSource: `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
const headBranch = 'agentmonitor/approval-fixture'
const head = execFileSync('git', ['rev-parse', headBranch], { encoding: 'utf8' }).trim()
const remoteBase = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).trim().split(/\\s+/)[0]
const statePath = fileURLToPath(import.meta.url) + '.state'
if (args[0] === 'auth' && args[1] === 'status') console.log('github.com authenticated')
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]')
else if (args[0] === 'pr' && args[1] === 'create') console.log('https://github.com/example/fixture/pull/42')
else if (args[0] === 'pr' && args[1] === 'view') {
  const count = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0
  writeFileSync(statePath, String(count + 1))
  console.log(JSON.stringify({
    state: count === 0 ? 'OPEN' : 'MERGED',
    mergedAt: count === 0 ? null : '2026-09-04T00:00:00Z',
    url: 'https://github.com/example/fixture/pull/42',
    baseRefName: 'main',
    headRefName: headBranch,
    headRefOid: head,
    mergeCommit: count === 0 ? null : { oid: remoteBase }
  }))
} else process.exit(1)
`
    })

    await expect(fixture.runner.approve(fixture.taskId)).resolves.toMatchObject({ outcome: 'pr_opened' })
    const publishedHead = fixture.store.getTask(fixture.taskId).publication?.publishedCommit
    await writeFile(join(fixture.repository, 'agent-output.txt'), 'implemented\n')
    await execFileAsync('git', ['add', 'agent-output.txt'], { cwd: fixture.repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Merge Test', '-c', 'user.email=merge@example.com', 'commit', '-m', 'squash agent output'],
      { cwd: fixture.repository }
    )
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.repository })
    const mergeCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.repository })).stdout.trim()
    expect(mergeCommit).not.toBe(publishedHead)

    await expect(fixture.runner.refreshPublication(fixture.taskId)).resolves.toMatchObject({ outcome: 'published' })
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({
      status: 'completed',
      publication: { status: 'published', publishedCommit: publishedHead, mergeCommit }
    })
    fixture.store.close()
  })

  it('rejects an existing PR that targets a different base branch', async () => {
    const fixture = await createApprovalFixture({
      publishStrategy: 'pull-request',
      githubSource: `#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
const headBranch = 'agentmonitor/approval-fixture'
const head = execFileSync('git', ['rev-parse', headBranch], { encoding: 'utf8' }).trim()
if (args[0] === 'auth' && args[1] === 'status') console.log('github.com authenticated')
else if (args[0] === 'pr' && args[1] === 'list') console.log(JSON.stringify([{
  state: 'OPEN',
  url: 'https://github.com/example/fixture/pull/41',
  baseRefName: 'develop',
  headRefName: headBranch,
  headRefOid: head
}]))
else process.exit(1)
`
    })

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow('PR 기준 브랜치가 main이 아닙니다.')
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    fixture.store.close()
  })

  it('times out an unresponsive GitHub CLI operation without changing the task state', async () => {
    const fixture = await createApprovalFixture({
      publishStrategy: 'pull-request',
      policy: { remoteOperationTimeoutMs: 50 },
      githubSource: `#!/usr/bin/env node
setInterval(() => undefined, 1_000)
`
    })

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow('GitHub CLI 원격 작업 제한 시간 초과')
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    fixture.store.close()
  })

  it('does not synchronize a remote branch that does not contain the published commit', async () => {
    const fixture = await createApprovalFixture()
    await execFileAsync('git', ['add', 'agent-output.txt'], { cwd: fixture.worktreePath })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'agent output'],
      { cwd: fixture.worktreePath }
    )
    const publishedCommit = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: fixture.worktreePath })
    ).stdout.trim()
    fixture.store.setTaskPublication(fixture.taskId, {
      strategy: 'direct',
      status: 'awaiting_local_sync',
      remoteName: 'origin',
      baseBranch: 'main',
      remoteBranch: 'main',
      pullRequestUrl: null,
      publishedCommit,
      mergeCommit: null,
      message: '원격 게시 완료 · 로컬 동기화 대기',
      updatedAt: new Date().toISOString()
    })

    await expect(fixture.runner.refreshPublication(fixture.taskId)).resolves.toMatchObject({
      outcome: 'awaiting_merge',
      message: expect.stringContaining('검증한 게시 결과가 포함되지 않았습니다.')
    })
    expect(fixture.store.getTask(fixture.taskId)).toMatchObject({
      status: 'awaiting_approval',
      publication: { status: 'failed' }
    })
    await expect(readFile(join(fixture.repository, 'agent-output.txt'), 'utf8')).rejects.toThrow()
    fixture.store.close()
  })

  it('blocks publishing when local main contains commits that are not on the remote', async () => {
    const fixture = await createApprovalFixture()
    await writeFile(join(fixture.repository, 'local-only.txt'), 'not published\n')
    await execFileAsync('git', ['add', 'local-only.txt'], { cwd: fixture.repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'local only'],
      { cwd: fixture.repository }
    )

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow('원격에 없는 커밋이 1개 있습니다')
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    const remoteFiles = await execFileAsync('git', ['--git-dir', fixture.remote, 'ls-tree', '--name-only', 'main'])
    expect(remoteFiles.stdout).not.toContain('local-only.txt')
    fixture.store.close()
  })

  it('removes DerivedData immediately after approval and keeps runtime evidence', async () => {
    const fixture = await createApprovalFixture()
    const runtimeSessionPath = join(fixture.repository, '..', 'runtime-sessions', fixture.taskId)
    const appDerivedDataPath = join(runtimeSessionPath, 'DerivedData')
    const observerDerivedDataPath = join(runtimeSessionPath, 'accessibility-observer', 'DerivedData')
    const evidencePath = join(runtimeSessionPath, 'evidence', 'screen.png')
    await mkdir(appDerivedDataPath, { recursive: true })
    await mkdir(observerDerivedDataPath, { recursive: true })
    await mkdir(join(runtimeSessionPath, 'evidence'), { recursive: true })
    await writeFile(join(appDerivedDataPath, 'App.app'), 'build-output')
    await writeFile(join(observerDerivedDataPath, 'Observer.xctest'), 'observer-output')
    await writeFile(evidencePath, 'runtime-evidence')

    await fixture.runner.approve(fixture.taskId)

    expect(fixture.store.getTask(fixture.taskId).status).toBe('completed')
    await expect(stat(appDerivedDataPath)).rejects.toThrow()
    await expect(stat(observerDerivedDataPath)).rejects.toThrow()
    expect((await stat(evidencePath)).isFile()).toBe(true)
    fixture.store.close()
  })

  it('rebases an agent task onto a newer source commit and re-verifies before approval', async () => {
    const fixture = await createExecutionFixture({
      codexSource: (directory) => `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
appendFileSync(${JSON.stringify(join(directory, 'review-prompts.jsonl'))}, JSON.stringify(prompt) + '\\n')
if (prompt.includes('구현 담당자')) writeFileSync('agent-output.txt', 'implemented\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })
    await fixture.runner.run(fixture.taskId)
    const beforeApproval = fixture.store.getTask(fixture.taskId)
    expect(beforeApproval).toMatchObject({ status: 'awaiting_approval', sourceBranch: 'main' })

    await writeFile(join(fixture.repository, 'main-change.txt'), 'advanced\n')
    await execFileAsync('git', ['add', 'main-change.txt'], { cwd: fixture.repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'advance main'],
      { cwd: fixture.repository }
    )
    await execFileAsync('git', ['config', '--local', 'user.name', ''], { cwd: fixture.repository })
    await execFileAsync('git', ['config', '--local', 'user.email', ''], { cwd: fixture.repository })
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.repository })

    await expect(fixture.runner.approve(fixture.taskId)).resolves.toMatchObject({ outcome: 'reverified' })
    const reverified = fixture.store.getTask(fixture.taskId)
    expect(reverified.status).toBe('awaiting_approval')
    await expect(readFile(join(fixture.repository, 'agent-output.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(fixture.repository, 'main-change.txt'), 'utf8')).toBe('advanced\n')
    expect(await readFile(join(reverified.worktreePath!, 'main-change.txt'), 'utf8')).toBe('advanced\n')
    const remoteHead = (await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd: fixture.repository })).stdout.trim()
    expect(reverified.verificationBaseCommit).toBe(remoteHead)
    const committedChanges = await fixture.runner.getChanges(fixture.taskId)
    expect(committedChanges.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'agent-output.txt', status: 'M', additions: 1, deletions: 0 })
    ]))
    expect(committedChanges.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'main-change.txt' })
    ]))
    expect(committedChanges.patch).toContain('agent-output.txt')
    expect(committedChanges.patch).not.toContain('main-change.txt')
    const reviewerPrompts = (await readFile(join(fixture.directory, 'review-prompts.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string)
      .filter((prompt) => prompt.includes('최종 읽기 전용 Reviewer'))
    expect(reviewerPrompts.at(-1)).toContain(`git diff ${remoteHead} --`)

    await expect(fixture.runner.approve(fixture.taskId)).resolves.toMatchObject({ outcome: 'published' })
    expect(fixture.store.getTask(fixture.taskId).status).toBe('completed')
    expect(await readFile(join(fixture.repository, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    fixture.store.close()
  })

  it('aborts a conflicting rebase and leaves the source checkout unchanged', async () => {
    const fixture = await createExecutionFixture({
      codexSource: () => `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
if (prompt.includes('구현 담당자')) writeFileSync('README.md', '# Agent version\\n')
const message = prompt.includes('최종 읽기 전용 Reviewer') ? 'VERDICT: PASS' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`,
      verificationPlan: {
        version: 1,
        mode: 'project-tests',
        testDesign: 'existing-tests',
        runtimeSource: 'off'
      }
    })
    await fixture.runner.run(fixture.taskId)
    const worktreePath = fixture.store.getTask(fixture.taskId).worktreePath!
    await writeFile(join(fixture.repository, 'README.md'), '# Human version\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: fixture.repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'edit source'],
      { cwd: fixture.repository }
    )
    await execFileAsync('git', ['push', 'origin', 'main'], { cwd: fixture.repository })

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow('충돌 파일: README.md')
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    expect(await readFile(join(fixture.repository, 'README.md'), 'utf8')).toBe('# Human version\n')
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('# Agent version\n')
    const rebaseState = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath })
    expect(rebaseState.stdout).toBe('')
    fixture.store.close()
  })

  it('removes managed worktrees and monitoring data without deleting the source repository', async () => {
    const fixture = await createApprovalFixture()
    const runtimeSessionPath = join(fixture.repository, '..', 'runtime-sessions', fixture.taskId)
    await mkdir(join(runtimeSessionPath, 'evidence'), { recursive: true })
    await writeFile(join(runtimeSessionPath, 'evidence', 'screen.png'), 'fixture-png')

    await fixture.runner.removeProject(fixture.store.getTask(fixture.taskId).projectId)

    await expect(stat(fixture.worktreePath)).rejects.toThrow()
    await expect(stat(runtimeSessionPath)).rejects.toThrow()
    expect((await stat(fixture.repository)).isDirectory()).toBe(true)
    expect(fixture.store.getSnapshot().projects).toEqual([])
    fixture.store.close()
  })

  it('discards worktree and DerivedData immediately while keeping evidence until retention expires', async () => {
    const fixture = await createApprovalFixture()
    const task = fixture.store.getTask(fixture.taskId)
    const runtimeSessionPath = join(fixture.repository, '..', 'runtime-sessions', fixture.taskId)
    const appDerivedDataPath = join(runtimeSessionPath, 'DerivedData')
    const observerDerivedDataPath = join(runtimeSessionPath, 'accessibility-observer', 'DerivedData')
    const evidencePath = join(runtimeSessionPath, 'evidence', 'screen.png')
    await mkdir(appDerivedDataPath, { recursive: true })
    await mkdir(observerDerivedDataPath, { recursive: true })
    await mkdir(join(runtimeSessionPath, 'evidence'), { recursive: true })
    await writeFile(join(appDerivedDataPath, 'App.app'), 'build-output')
    await writeFile(join(observerDerivedDataPath, 'Observer.xctest'), 'observer-output')
    await writeFile(evidencePath, 'runtime-evidence')
    fixture.store.setRuntimeSession(task.id, 'stopped', { message: '검증 증거 보관 중' })
    fixture.store.addRuntimeEvidence(task.id, {
      kind: 'screen',
      path: evidencePath,
      mimeType: 'image/png',
      sizeBytes: 16,
      createdAt: new Date().toISOString()
    })

    await fixture.runner.discard(task.id)

    expect(fixture.store.getTask(task.id)).toMatchObject({ status: 'discarded', worktreePath: null })
    await expect(stat(fixture.worktreePath)).rejects.toThrow()
    await expect(stat(appDerivedDataPath)).rejects.toThrow()
    await expect(stat(observerDerivedDataPath)).rejects.toThrow()
    expect((await stat(evidencePath)).isFile()).toBe(true)
    expect(fixture.store.getRuntimeSession(task.id)).not.toBeNull()

    const branchBeforeCleanup = await execFileAsync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${task.branchName}`],
      { cwd: fixture.repository }
    )
    expect(branchBeforeCleanup.stderr).toBe('')

    await fixture.runner.setStoragePolicy({ runtimeArtifactRetentionDays: 0 })
    const cleanup = await fixture.runner.cleanupStorage({ removeLocalBranches: true })

    expect(cleanup.runtimeArtifactsRemoved).toBe(1)
    expect(cleanup.branchesRemoved).toBe(1)
    expect(cleanup.bytesReclaimed).toBeGreaterThan(0)
    await expect(stat(runtimeSessionPath)).rejects.toThrow()
    expect(fixture.store.getRuntimeSession(task.id)).toBeNull()
    expect(fixture.store.listRuntimeEvidence(task.projectId)).toEqual([])
    expect(fixture.store.getTask(task.id).branchName).toBeNull()
    await expect(
      execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${task.branchName}`], {
        cwd: fixture.repository
      })
    ).rejects.toThrow()
    fixture.store.close()
  })

  it('reconciles missing database pointers and unreferenced managed worktrees', async () => {
    const fixture = await createApprovalFixture()
    const worktreesRoot = dirname(fixture.worktreePath)
    const missingTask = fixture.store.createTask(
      fixture.store.getTask(fixture.taskId).projectId,
      '사라진 작업공간',
      '앱 재시작 시 남은 경로 정보를 안전하게 복구한다.',
      1
    )
    fixture.store.setTaskWorkspace(
      missingTask.id,
      'agentmonitor/missing-worktree',
      join(worktreesRoot, 'missing-worktree')
    )
    const orphanPath = join(worktreesRoot, 'orphan-project', 'orphan-task')
    await mkdir(orphanPath, { recursive: true })
    await writeFile(join(orphanPath, 'orphan.txt'), 'orphan')

    const cleanup = await fixture.runner.reconcileStorage()

    expect(cleanup.worktreesRemoved).toBe(1)
    expect(fixture.store.getTask(missingTask.id).worktreePath).toBeNull()
    await expect(stat(orphanPath)).rejects.toThrow()
    expect((await stat(fixture.worktreePath)).isDirectory()).toBe(true)
    fixture.store.close()
  })
})
