import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRunner, parseConfiguredCommand, parseReviewerFindings } from '../../electron/main/runner'
import {
  IosRuntimeStageError,
  type IosSimulatorRuntimeAdapter
} from '../../electron/main/ios-simulator-runtime'
import { AppStore } from '../../electron/main/store'

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
  runtimeAdapter?: IosSimulatorRuntimeAdapter
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

  const fakeCodex = join(directory, 'fake-codex.mjs')
  await writeFile(fakeCodex, options.codexSource(directory))
  await chmod(fakeCodex, 0o755)

  const store = new AppStore(join(directory, 'store.sqlite'))
  const project = store.addProject('Runtime fixture', repository)
  store.updateProject({ projectId: project.id, name: project.name, testCommand: 'make test' })
  const task = store.createTask(project.id, '실행 수명주기', '중단과 시간 초과를 안전하게 처리한다.', 1)
  const runner = new AgentRunner(
    store,
    worktrees,
    () => undefined,
    fakeCodex,
    undefined,
    options.policy,
    options.runtimeAdapter
  )
  activeRunners.push(runner)
  return { directory, repository, store, runner, taskId: task.id }
}

async function createApprovalFixture(): Promise<{
  repository: string
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

  const store = new AppStore(join(directory, 'store.sqlite'))
  const project = store.addProject('Fixture', repository)
  const task = store.createTask(project.id, '승인 기능', '작업 변경을 원본 저장소에 안전하게 적용한다.', 2)
  const branchName = 'agentmonitor/approval-fixture'
  await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: repository })
  await writeFile(join(worktreePath, 'agent-output.txt'), 'implemented\n')
  store.setTaskWorkspace(task.id, branchName, worktreePath)
  store.transitionTask(task.id, 'running', 1)
  store.transitionTask(task.id, 'awaiting_approval')

  return {
    repository,
    worktreePath,
    store,
    runner: new AgentRunner(store, worktrees, () => undefined),
    taskId: task.id
  }
}

describe('AgentRunner', () => {
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

  it('runs role-separated stages inside a git worktree and stops for approval', async () => {
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

    const fakeCodex = join(directory, 'fake-codex.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const prompt = process.argv.at(-1) ?? ''
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }))
if (prompt.includes('구현 담당자')) {
  writeFileSync('agent-output.txt', 'implemented\\n')
  writeFileSync('agent-codex-home.txt', process.env.CODEX_HOME ?? '')
}
const message = prompt.includes('최종 읽기 전용 Reviewer') ? '[medium] 빈 입력 회귀 검토 필요' : 'stage complete'
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
console.log(JSON.stringify({ type: 'turn.completed' }))
`
    )
    await chmod(fakeCodex, 0o755)

    const store = new AppStore(join(directory, 'store.sqlite'))
    const project = store.addProject('Fixture', repository)
    store.updateProject({ projectId: project.id, name: project.name, testCommand: 'make test' })
    const task = store.createTask(project.id, '기능 구현', 'fixture 파일을 생성하고 검토한다.', 2)
    const published: string[] = []
    const codexHome = join(directory, 'codex-home')
    const runner = new AgentRunner(store, worktrees, (event) => published.push(event.actor), fakeCodex, codexHome)

    await runner.run(task.id)

    const awaitingApproval = store.getTask(task.id)
    expect(awaitingApproval.status).toBe('awaiting_approval')
    expect(awaitingApproval.worktreePath).toBeTruthy()
    expect(await readFile(join(awaitingApproval.worktreePath!, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    expect(await readFile(join(awaitingApproval.worktreePath!, 'agent-codex-home.txt'), 'utf8')).toBe(codexHome)
    expect(published).toContain('test-designer')
    expect(published).toContain('critic')
    expect(published).toContain('reviewer')
    expect(store.getSnapshot(project.id).findings).toMatchObject([
      { severity: 'medium', title: '빈 입력 회귀 검토 필요', resolved: false }
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

  it('refuses a non-fast-forward approval without changing the original branch', async () => {
    const fixture = await createApprovalFixture()
    await writeFile(join(fixture.repository, 'main-change.txt'), 'advanced\n')
    await execFileAsync('git', ['add', 'main-change.txt'], { cwd: fixture.repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'advance main'],
      { cwd: fixture.repository }
    )

    await expect(fixture.runner.approve(fixture.taskId)).rejects.toThrow('fast-forward 적용할 수 없습니다.')
    expect(fixture.store.getTask(fixture.taskId).status).toBe('awaiting_approval')
    expect(fixture.store.getTask(fixture.taskId).worktreePath).toBe(fixture.worktreePath)
    await expect(readFile(join(fixture.repository, 'agent-output.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(fixture.repository, 'main-change.txt'), 'utf8')).toBe('advanced\n')
    const committedChanges = await fixture.runner.getChanges(fixture.taskId)
    expect(committedChanges.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'agent-output.txt', status: 'M', additions: 1, deletions: 0 })
    ]))
    expect(committedChanges.patch).toContain('agent-output.txt')
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
})
