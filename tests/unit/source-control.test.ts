import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../../src/shared/types'
import { GitOperationCoordinator } from '../../electron/main/git-operation-coordinator'
import { parseSourceControlStatus, SourceControlService } from '../../electron/main/source-control'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', repository, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function createRepository(): Promise<{ project: ProjectRecord; repository: string }> {
  const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-source-control-'))
  temporaryDirectories.push(repository)
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'user.name', 'Source Control Test'])
  await git(repository, ['config', 'user.email', 'source-control@example.com'])
  await writeFile(join(repository, 'tracked.txt'), 'before\n')
  await git(repository, ['add', 'tracked.txt'])
  await git(repository, ['commit', '-m', 'initial'])
  return {
    repository,
    project: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'source-control-fixture',
      path: repository,
      setupCommand: '',
      testCommand: '',
      runtimeAdapter: null,
      runtimeConfigSource: null,
      isDemo: false,
      createdAt: new Date().toISOString()
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('parseSourceControlStatus', () => {
  it('separates staged, working, untracked and renamed states', () => {
    const status = [
      'M  staged.txt',
      ' M working.txt',
      '?? new.txt',
      'R  renamed.txt',
      'old.txt',
      ''
    ].join('\0')

    expect(parseSourceControlStatus(status)).toEqual([
      { path: 'new.txt', originalPath: null, staged: null, working: 'untracked', conflicted: false },
      { path: 'renamed.txt', originalPath: 'old.txt', staged: 'renamed', working: null, conflicted: false },
      { path: 'staged.txt', originalPath: null, staged: 'modified', working: null, conflicted: false },
      { path: 'working.txt', originalPath: null, staged: null, working: 'modified', conflicted: false }
    ])
  })
})

describe('SourceControlService', () => {
  it('serializes mutating Git operations for the same project', async () => {
    const coordinator = new GitOperationCoordinator()
    let releaseFirst = (): void => undefined
    const first = coordinator.runExclusive(
      'project',
      () => new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise
      })
    )

    await expect(coordinator.runExclusive('project', async () => undefined)).rejects.toThrow(
      '다른 Git 작업이 진행 중입니다.'
    )
    await expect(coordinator.runExclusive('another-project', async () => 'done')).resolves.toBe('done')
    releaseFirst()
    await first
  })

  it('stages and commits selected files while preserving the remaining work', async () => {
    const { project, repository } = await createRepository()
    const service = new SourceControlService(new GitOperationCoordinator())
    await writeFile(join(repository, 'tracked.txt'), 'after\n')
    await writeFile(join(repository, 'untracked.txt'), 'keep for later\n')

    let status = await service.getStatus(project)
    expect(status.workingCount).toBe(2)
    expect(status.stagedCount).toBe(0)

    const diff = await service.getDiff(project, 'tracked.txt', 'working')
    expect(diff.patch).toContain('+after')

    status = await service.stage(project, ['tracked.txt'])
    expect(status.stagedCount).toBe(1)
    expect(status.workingCount).toBe(1)

    const result = await service.commit(project, 'update tracked file')
    expect(result.commit).toHaveLength(7)
    expect(result.status.stagedCount).toBe(0)
    expect(result.status.files).toEqual([
      expect.objectContaining({ path: 'untracked.txt', working: 'untracked' })
    ])
    expect(await git(repository, ['show', '--format=', '--name-only', 'HEAD'])).toBe('tracked.txt')
  })

  it('stages, unstages and commits every changed file', async () => {
    const { project, repository } = await createRepository()
    const service = new SourceControlService(new GitOperationCoordinator())
    await writeFile(join(repository, 'tracked.txt'), 'after\n')
    await mkdir(join(repository, 'Sources'))
    await writeFile(join(repository, 'Sources', 'new.swift'), 'let value = 1\n')

    let status = await service.stageAll(project)
    expect(status.stagedCount).toBe(2)
    expect(status.workingCount).toBe(0)

    status = await service.unstage(project, ['Sources/new.swift'])
    expect(status.stagedCount).toBe(1)
    expect(status.workingCount).toBe(1)

    const result = await service.commit(project, 'commit all files', true)
    expect(result.status.files).toEqual([])
    expect((await git(repository, ['show', '--format=', '--name-only', 'HEAD'])).split('\n').sort()).toEqual([
      'Sources/new.swift',
      'tracked.txt'
    ])
  })

  it('supports staging and unstaging before the first commit', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-unborn-source-control-'))
    temporaryDirectories.push(repository)
    await git(repository, ['init', '-b', 'main'])
    await git(repository, ['config', 'user.name', 'Source Control Test'])
    await git(repository, ['config', 'user.email', 'source-control@example.com'])
    await writeFile(join(repository, 'first.txt'), 'first commit\n')
    const project: ProjectRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'unborn-source-control-fixture',
      path: repository,
      setupCommand: '',
      testCommand: '',
      runtimeAdapter: null,
      runtimeConfigSource: null,
      isDemo: false,
      createdAt: new Date().toISOString()
    }
    const service = new SourceControlService(new GitOperationCoordinator())

    expect((await service.getStatus(project)).headCommit).toBeNull()
    expect((await service.stageAll(project)).stagedCount).toBe(1)
    const unstaged = await service.unstageAll(project)
    expect(unstaged).toMatchObject({ stagedCount: 0, workingCount: 1 })
    await service.stage(project, ['first.txt'])
    const committed = await service.commit(project, 'initial commit')
    expect(committed.status.files).toEqual([])
  })

  it('rejects paths outside the current change list', async () => {
    const { project } = await createRepository()
    const service = new SourceControlService(new GitOperationCoordinator())

    await expect(service.stage(project, ['../outside.txt'])).rejects.toThrow('안전하지 않은 저장소 파일 경로')
    await expect(service.stage(project, ['missing.txt'])).rejects.toThrow('현재 변경 목록에 없는 파일')
  })
})
