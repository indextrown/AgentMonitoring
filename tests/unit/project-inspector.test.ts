import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectProjectCapabilities } from '../../electron/main/project-capabilities'
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
      suggestedTestCommands: ['tuist test'],
      capabilityManifest: {
        path: '.agentmonitor/project.json',
        state: 'missing',
        adapterKind: null,
        message: 'manifest가 없어 기존 코드 작업 모드로 동작합니다.'
      }
    })
    expect(inspection.capabilities).toEqual([
      { key: 'code', status: 'ready', detail: 'Git 추적 파일 5개에 접근 가능' },
      { key: 'build', status: 'missing', detail: '프로젝트 계약에 빌드 방식이 없습니다.' },
      { key: 'run', status: 'missing', detail: '프로젝트 계약에 앱 실행 방식이 없습니다.' },
      { key: 'observe', status: 'missing', detail: '화면·접근성·상태 관찰이 선언되지 않았습니다.' },
      { key: 'act', status: 'missing', detail: 'UI·fixture 조작이 선언되지 않았습니다.' },
      { key: 'verify', status: 'missing', detail: '프로젝트 검증 명령이 설정되지 않았습니다.' }
    ])
    expect(inspection.manifests).toEqual(['Tuist.swift', 'Workspace.swift'])
    expect(JSON.stringify(inspection)).not.toContain('fixture-secret')
  })

  it('reads a bounded declarative iOS capability contract without executing commands', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-capability-'))
    temporaryDirectories.push(repository)
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
    await mkdir(join(repository, '.agentmonitor'))
    await writeFile(join(repository, 'App.swift'), 'struct App {}\n')
    await writeFile(
      join(repository, '.agentmonitor', 'project.json'),
      JSON.stringify({
        version: 1,
        adapter: {
          kind: 'ios-simulator',
          container: 'PopPang.xcworkspace',
          scheme: 'PopPang',
          configuration: 'Debug',
          deviceFamily: 'iphone'
        },
        capabilities: {
          build: true,
          run: true,
          observe: ['screen', 'accessibility', 'state'],
          act: ['ui', 'fixture'],
          verify: ['test-command', 'runtime-scenario']
        }
      })
    )
    await execFileAsync('git', ['add', 'App.swift'], { cwd: repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'fixture'],
      { cwd: repository }
    )

    const project: ProjectRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'PopPang',
      path: repository,
      testCommand: 'tuist test',
      isDemo: false,
      createdAt: new Date().toISOString()
    }
    const inspection = await inspectProject(project)

    expect(inspection.capabilityManifest).toEqual({
      path: '.agentmonitor/project.json',
      state: 'valid',
      adapterKind: 'ios-simulator',
      message: 'PopPang.xcworkspace · PopPang · Debug · iPhone'
    })
    expect(inspection.capabilities.map(({ key, status }) => ({ key, status }))).toEqual([
      { key: 'code', status: 'ready' },
      { key: 'build', status: 'ready' },
      { key: 'run', status: 'ready' },
      { key: 'observe', status: 'ready' },
      { key: 'act', status: 'declared' },
      { key: 'verify', status: 'ready' }
    ])
    expect(inspection.capabilities.find(({ key }) => key === 'run')?.detail).toBe(
      'iPhone Simulator 실행 adapter 사용 가능'
    )
  })

  it('reports invalid capability contracts without failing repository inspection', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-invalid-capability-'))
    temporaryDirectories.push(repository)
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repository })
    await mkdir(join(repository, '.agentmonitor'))
    await writeFile(join(repository, 'App.swift'), 'struct App {}\n')
    await writeFile(join(repository, '.agentmonitor', 'project.json'), '{ invalid json')
    await execFileAsync('git', ['add', 'App.swift'], { cwd: repository })
    await execFileAsync(
      'git',
      ['-c', 'user.name=Agent Test', '-c', 'user.email=agent@example.com', 'commit', '-m', 'fixture'],
      { cwd: repository }
    )

    const inspection = await inspectProject({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Invalid',
      path: repository,
      testCommand: '',
      isDemo: false,
      createdAt: new Date().toISOString()
    })

    expect(inspection.capabilityManifest).toMatchObject({
      state: 'invalid',
      message: 'JSON 문법이 올바르지 않습니다.'
    })
    expect(inspection.capabilities.find((capability) => capability.key === 'code')?.status).toBe('ready')
  })

  it('rejects capability manifests larger than the inspection boundary', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-large-capability-'))
    temporaryDirectories.push(repository)
    await mkdir(join(repository, '.agentmonitor'))
    await writeFile(join(repository, '.agentmonitor', 'project.json'), 'x'.repeat(64 * 1024 + 1))

    const result = await inspectProjectCapabilities(
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Large',
        path: repository,
        testCommand: '',
        isDemo: false,
        createdAt: new Date().toISOString()
      },
      0
    )

    expect(result.manifest).toMatchObject({
      state: 'invalid',
      message: 'manifest 크기는 64KB를 넘을 수 없습니다.'
    })
  })
})
