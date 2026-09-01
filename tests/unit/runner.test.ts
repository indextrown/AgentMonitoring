import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRunner, parseReviewerFindings } from '../../electron/main/runner'
import { AppStore } from '../../electron/main/store'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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

  it('runs role-separated stages inside a git worktree and stops for approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runner-'))
    temporaryDirectories.push(directory)
    const repository = join(directory, 'repository')
    const worktrees = join(directory, 'worktrees')
    await mkdir(repository)
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), '# Fixture\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repository })
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

    await fixture.runner.removeProject(fixture.store.getTask(fixture.taskId).projectId)

    await expect(stat(fixture.worktreePath)).rejects.toThrow()
    expect((await stat(fixture.repository)).isDirectory()).toBe(true)
    expect(fixture.store.getSnapshot().projects).toEqual([])
    fixture.store.close()
  })
})
