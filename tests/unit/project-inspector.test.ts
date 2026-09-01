import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectProject, parseGitStatus } from '../../electron/main/project-inspector'
import type { ProjectRecord } from '../../src/shared/types'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('inspectProject', () => {
  it('classifies porcelain status codes and keeps the renamed destination path', () => {
    const status = [
      ' M Sources/App.swift',
      'A  Sources/New.swift',
      ' D Sources/Old.swift',
      'R  Sources/Renamed.swift',
      'Sources/Previous.swift',
      '?? fastlane/screenshots/0.png',
      'UU Project.swift',
      ''
    ].join('\0')

    expect(parseGitStatus(status)).toEqual([
      { kind: 'modified', path: 'Sources/App.swift' },
      { kind: 'added', path: 'Sources/New.swift' },
      { kind: 'deleted', path: 'Sources/Old.swift' },
      { kind: 'renamed', path: 'Sources/Renamed.swift' },
      { kind: 'untracked', path: 'fastlane/screenshots/0.png' },
      { kind: 'conflicted', path: 'Project.swift' }
    ])
  })

  it('classifies every changed file without returning tracked secret contents', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-inspection-'))
    temporaryDirectories.push(repository)
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
    await mkdir(join(repository, 'Sources'))
    await mkdir(join(repository, 'Tests'))
    await writeFile(join(repository, 'Tuist.swift'), 'import ProjectDescription\n')
    await writeFile(join(repository, 'Workspace.swift'), 'import ProjectDescription\n')
    await writeFile(join(repository, 'Sources', 'App.swift'), 'struct App {}\n')
    await writeFile(join(repository, 'Tests', 'AppTests.swift'), 'struct AppTests {}\n')
    await writeFile(join(repository, '.env'), 'DO_NOT_READ=fixture-secret\n')
    await execFileAsync('git', ['add', 'Tuist.swift', 'Workspace.swift', 'Sources', 'Tests', '.env'], { cwd: repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'fixture'],
      { cwd: repository }
    )
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repository })
    await writeFile(join(repository, 'Sources', 'App.swift'), 'struct App { let changed = true }\n')
    await mkdir(join(repository, 'fastlane', 'screenshots'), { recursive: true })
    await writeFile(join(repository, 'fastlane', 'screenshots', '0.png'), 'fixture-image-0\n')
    await writeFile(join(repository, 'fastlane', 'screenshots', '1.png'), 'fixture-image-1\n')

    const project: ProjectRecord = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Fixture',
      path: repository,
      testCommand: '',
      isDemo: false,
      createdAt: new Date().toISOString()
    }
    const inspection = await inspectProject(project)

    expect(inspection).toMatchObject({
      projectId: project.id,
      branch: 'main',
      clean: false,
      changeCount: 3,
      changeSummary: {
        modified: 1,
        added: 0,
        deleted: 0,
        renamed: 0,
        untracked: 2,
        conflicted: 0
      },
      changePreview: [
        { kind: 'modified', path: 'Sources/App.swift' },
        { kind: 'untracked', path: 'fastlane/screenshots/0.png' },
        { kind: 'untracked', path: 'fastlane/screenshots/1.png' }
      ],
      hasRemote: true,
      primaryLanguage: 'Swift',
      tools: ['Tuist'],
      trackedFileCount: 5,
      testFileCount: 1,
      suggestedTestCommands: ['tuist test']
    })
    expect(inspection.manifests).toEqual(['Tuist.swift', 'Workspace.swift'])
    expect(JSON.stringify(inspection)).not.toContain('fixture-secret')
  })
})
