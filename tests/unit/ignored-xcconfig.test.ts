import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { syncIgnoredXcconfigFiles } from '../../electron/main/ignored-xcconfig'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createFixture(): Promise<{ repository: string; worktree: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-xcconfig-'))
  temporaryDirectories.push(directory)
  const repository = join(directory, 'repository')
  const worktree = join(directory, 'worktree')
  await mkdir(join(repository, 'Config'), { recursive: true })
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
  await writeFile(join(repository, '.gitignore'), 'Config/Secrets.xcconfig\n')
  await writeFile(join(repository, 'README.md'), '# Fixture\n')
  await execFileAsync('git', ['add', '.gitignore', 'README.md'], { cwd: repository })
  await execFileAsync(
    'git',
    ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'init'],
    { cwd: repository }
  )
  await execFileAsync('git', ['worktree', 'add', '-b', 'agentmonitor/test', worktree, 'HEAD'], { cwd: repository })
  await writeFile(join(repository, 'Config', 'Secrets.xcconfig'), 'MAPBOX_ACCESS_TOKEN = fixture-token\n')
  return { repository, worktree }
}

describe('ignored xcconfig synchronization', () => {
  it('ignores dependency checkout directories returned by Git', async () => {
    const fixture = await createFixture()
    const checkout = join(fixture.repository, 'Tuist', '.build', 'checkouts', 'mapbox-common-ios')
    await writeFile(join(fixture.repository, '.git', 'info', 'exclude'), 'Tuist/.build/\n')
    await mkdir(checkout, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: checkout })

    const result = await syncIgnoredXcconfigFiles(fixture.repository, fixture.worktree)

    expect(result.paths).toEqual(['Config/Secrets.xcconfig'])
    expect(await readFile(join(fixture.worktree, 'Config', 'Secrets.xcconfig'), 'utf8'))
      .toBe('MAPBOX_ACCESS_TOKEN = fixture-token\n')
  })

  it('copies ignored xcconfig files into the same worktree path and refreshes them', async () => {
    const fixture = await createFixture()

    const first = await syncIgnoredXcconfigFiles(fixture.repository, fixture.worktree)

    expect(first.paths).toEqual(['Config/Secrets.xcconfig'])
    expect(await readFile(join(fixture.worktree, 'Config', 'Secrets.xcconfig'), 'utf8'))
      .toBe('MAPBOX_ACCESS_TOKEN = fixture-token\n')
    expect((await stat(join(fixture.worktree, 'Config', 'Secrets.xcconfig'))).mode & 0o777).toBe(0o600)
    expect((await execFileAsync('git', ['status', '--short'], { cwd: fixture.worktree })).stdout).toBe('')

    await writeFile(join(fixture.repository, 'Config', 'Secrets.xcconfig'), 'MAPBOX_ACCESS_TOKEN = refreshed-token\n')
    await syncIgnoredXcconfigFiles(fixture.repository, fixture.worktree)

    expect(await readFile(join(fixture.worktree, 'Config', 'Secrets.xcconfig'), 'utf8'))
      .toBe('MAPBOX_ACCESS_TOKEN = refreshed-token\n')
  })

  it('refuses to copy a file when the worktree no longer ignores its path', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.worktree, '.gitignore'), '')

    await expect(syncIgnoredXcconfigFiles(fixture.repository, fixture.worktree))
      .rejects.toThrow('Git 제외 상태가 아닌 xcconfig')
  })

  it('refuses to overwrite a destination symlink', async () => {
    const fixture = await createFixture()
    const externalFile = join(fixture.repository, 'external.xcconfig')
    await writeFile(externalFile, 'DO_NOT_OVERWRITE = true\n')
    await mkdir(join(fixture.worktree, 'Config'), { recursive: true })
    await symlink(externalFile, join(fixture.worktree, 'Config', 'Secrets.xcconfig'))

    await expect(syncIgnoredXcconfigFiles(fixture.repository, fixture.worktree))
      .rejects.toThrow('기존 xcconfig가 일반 파일이 아닙니다')
    expect(await readFile(externalFile, 'utf8')).toBe('DO_NOT_OVERWRITE = true\n')
  })

  it('refuses to copy through a parent directory symlink', async () => {
    const fixture = await createFixture()
    const externalDirectory = join(fixture.repository, 'external-config')
    await mkdir(externalDirectory)
    await symlink(externalDirectory, join(fixture.worktree, 'Config'))

    await expect(syncIgnoredXcconfigFiles(fixture.repository, fixture.worktree))
      .rejects.toThrow('작업공간 밖을 가리키는 xcconfig 경로')
    await expect(readFile(join(externalDirectory, 'Secrets.xcconfig'), 'utf8')).rejects.toThrow()
  })
})
