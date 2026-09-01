import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRunner } from '../../electron/main/runner'
import { AppStore } from '../../electron/main/store'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AgentRunner', () => {
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
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'stage complete' } }))
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

    const completed = store.getTask(task.id)
    expect(completed.status).toBe('awaiting_approval')
    expect(completed.worktreePath).toBeTruthy()
    expect(await readFile(join(completed.worktreePath!, 'agent-output.txt'), 'utf8')).toBe('implemented\n')
    expect(await readFile(join(completed.worktreePath!, 'agent-codex-home.txt'), 'utf8')).toBe(codexHome)
    expect(published).toContain('test-designer')
    expect(published).toContain('critic')
    expect(published).toContain('reviewer')

    runner.approve(task.id)
    expect(store.getTask(task.id).status).toBe('completed')
    store.close()
  })
})
