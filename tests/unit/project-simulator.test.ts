import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectSimulatorService } from '../../electron/main/project-simulator'
import type { ProjectRecord } from '../../src/shared/types'
import type { RuntimeCommandRequest } from '../../electron/main/ios-simulator-runtime'

const temporaryDirectories: string[] = []

function appBuildSettings(targetBuildDirectory = '/tmp/DerivedData/Build/Products/Debug-iphonesimulator'): string {
  return JSON.stringify([
    {
      target: 'Demo',
      buildSettings: {
        TARGET_BUILD_DIR: targetBuildDirectory,
        WRAPPER_NAME: 'Demo.app',
        WRAPPER_EXTENSION: 'app',
        PRODUCT_BUNDLE_IDENTIFIER: 'com.example.Demo',
        PRODUCT_TYPE: 'com.apple.product-type.application',
        SKIP_INSTALL: 'NO'
      }
    }
  ])
}

function projectRecord(path: string, container = 'Demo.xcodeproj'): ProjectRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Demo',
    path,
    testCommand: '',
    setupCommand: '',
    runtimeAdapter: {
      kind: 'ios-simulator',
      container,
      scheme: 'Demo',
      configuration: 'Debug',
      deviceFamily: 'iphone'
    },
    runtimeConfigSource: 'detected',
    publishStrategy: 'pull-request',
    isDemo: false,
    createdAt: '2026-09-04T00:00:00.000Z'
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('ProjectSimulatorService', () => {
  it('builds, launches, restarts, and stops the configured iPhone app', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-project-simulator-'))
    temporaryDirectories.push(directory)
    const projectPath = join(directory, 'project')
    const runtimeRoot = join(directory, 'runtime')
    await mkdir(join(projectPath, 'Demo.xcodeproj'), { recursive: true })
    const commands: RuntimeCommandRequest[] = []
    const statuses: string[] = []

    const execute = async (request: RuntimeCommandRequest) => {
      commands.push(request)
      if (request.args.join(' ') === 'simctl list devices available --json') {
        return {
          code: 0,
          output: '',
          stdout: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
                {
                  udid: 'IPHONE-UDID',
                  name: 'iPhone 16 Pro',
                  state: 'Shutdown',
                  isAvailable: true
                }
              ]
            }
          })
        }
      }
      if (request.args[0] === 'xcodebuild' && request.args.at(-1) === 'build') {
        const derivedDataPath = request.args[request.args.indexOf('-derivedDataPath') + 1]
        await mkdir(join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator', 'Demo.app'), {
          recursive: true
        })
        return { code: 0, output: 'BUILD SUCCEEDED', stdout: 'BUILD SUCCEEDED' }
      }
      if (request.args[0] === 'xcodebuild' && request.args.includes('-showBuildSettings')) {
        const derivedDataIndex = request.args.indexOf('-derivedDataPath')
        const targetBuildDirectory = derivedDataIndex >= 0
          ? join(request.args[derivedDataIndex + 1], 'Build', 'Products', 'Debug-iphonesimulator')
          : '/tmp/DerivedData/Build/Products/Debug-iphonesimulator'
        return {
          code: 0,
          output: '',
          stdout: appBuildSettings(targetBuildDirectory)
        }
      }
      if (request.args.includes('launch')) {
        return { code: 0, output: 'com.example.Demo: 4242\n', stdout: 'com.example.Demo: 4242\n' }
      }
      return { code: 0, output: '', stdout: '' }
    }

    const service = new ProjectSimulatorService(
      runtimeRoot,
      (session) => statuses.push(session.status),
      execute
    )
    const project = projectRecord(projectPath)

    const launched = await service.launch(project)
    expect(launched).toMatchObject({
      status: 'running',
      deviceId: 'IPHONE-UDID',
      deviceName: 'iPhone 16 Pro',
      bundleIdentifier: 'com.example.Demo',
      processId: 4242
    })
    expect(statuses).toEqual([
      'preparing',
      'preparing',
      'booting',
      'building',
      'installing',
      'running'
    ])
    expect(commands.some((request) => request.args.join(' ') === 'simctl boot IPHONE-UDID')).toBe(true)
    expect(commands.some((request) => request.args[0] === 'xcodebuild' && request.args.at(-1) === 'build')).toBe(true)
    expect(commands.some((request) => request.args.join(' ').includes('simctl install IPHONE-UDID'))).toBe(true)

    const buildCount = commands.filter((request) => request.args[0] === 'xcodebuild').length
    const restarted = await service.restart(project)
    expect(restarted.status).toBe('running')
    expect(commands.filter((request) => request.args[0] === 'xcodebuild')).toHaveLength(buildCount)

    const stopped = await service.stop(project)
    expect(stopped).toMatchObject({ status: 'stopped', processId: null })
    expect(commands.at(-1)?.args).toEqual([
      'simctl',
      'terminate',
      'IPHONE-UDID',
      'com.example.Demo'
    ])
  })

  it('rejects an Xcode container outside the registered repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-project-simulator-path-'))
    temporaryDirectories.push(directory)
    const projectPath = join(directory, 'project')
    await mkdir(projectPath, { recursive: true })
    await mkdir(join(directory, 'Outside.xcodeproj'))
    const service = new ProjectSimulatorService(join(directory, 'runtime'))

    await expect(service.launch(projectRecord(projectPath, '../Outside.xcodeproj')))
      .rejects.toThrow('프로젝트 저장소 밖')
    expect(service.getStatus(projectRecord(projectPath, '../Outside.xcodeproj')).status).toBe('failed')
  })

  it('uses the selected task worktree and reports its branch as the launch source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-project-simulator-worktree-'))
    temporaryDirectories.push(directory)
    const projectPath = join(directory, 'project')
    const worktreePath = join(directory, 'worktree')
    await mkdir(join(projectPath, 'Demo.xcodeproj'), { recursive: true })
    await mkdir(join(worktreePath, 'Demo.xcodeproj'), { recursive: true })
    const commands: RuntimeCommandRequest[] = []
    const execute = async (request: RuntimeCommandRequest) => {
      commands.push(request)
      if (request.args[0] === 'xcodebuild' && request.args.includes('-showBuildSettings')) {
        return { code: 0, output: '', stdout: appBuildSettings() }
      }
      if (request.args.join(' ') === 'simctl list devices available --json') {
        return { code: 0, output: '', stdout: JSON.stringify({ devices: {} }) }
      }
      return { code: 0, output: '', stdout: '' }
    }
    const project = projectRecord(projectPath)
    const service = new ProjectSimulatorService(join(directory, 'runtime'), () => undefined, execute)

    await expect(service.launch(project, {
      path: worktreePath,
      source: {
        kind: 'task-worktree',
        taskId: '22222222-2222-4222-8222-222222222222',
        branchName: 'agentmonitor/task-branch'
      }
    })).rejects.toThrow('사용 가능한 iPhone Simulator가 없습니다')

    const resolvedWorktreePath = await realpath(worktreePath)
    expect(commands).not.toHaveLength(0)
    expect(commands.every((request) => request.cwd === resolvedWorktreePath)).toBe(true)
    expect(commands[0].args).toContain(join(resolvedWorktreePath, 'Demo.xcodeproj'))
    expect(service.getStatus(project).source).toEqual({
      kind: 'task-worktree',
      taskId: '22222222-2222-4222-8222-222222222222',
      branchName: 'agentmonitor/task-branch'
    })
  })

  it('blocks overlapping Simulator commands for the same project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-project-simulator-lock-'))
    temporaryDirectories.push(directory)
    const projectPath = join(directory, 'project')
    await mkdir(join(projectPath, 'Demo.xcodeproj'), { recursive: true })
    let releaseList = (): void => undefined
    const listReleased = new Promise<void>((resolvePromise) => {
      releaseList = resolvePromise
    })
    const execute = async (request: RuntimeCommandRequest) => {
      if (request.args[0] === 'xcodebuild' && request.args.includes('-showBuildSettings')) {
        return { code: 0, output: '', stdout: appBuildSettings() }
      }
      if (request.args.join(' ') === 'simctl list devices available --json') {
        await listReleased
        return { code: 0, output: '', stdout: JSON.stringify({ devices: {} }) }
      }
      return { code: 0, output: '', stdout: '' }
    }
    const service = new ProjectSimulatorService(join(directory, 'runtime'), () => undefined, execute)
    const project = projectRecord(projectPath)
    const first = service.launch(project)
    await Promise.resolve()

    await expect(service.launch(project)).rejects.toThrow('이미 실행 중')
    releaseList()
    await expect(first).rejects.toThrow('사용 가능한 iPhone Simulator가 없습니다')
  })

  it('rejects a framework scheme before booting a Simulator or starting a build', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-project-simulator-scheme-'))
    temporaryDirectories.push(directory)
    const projectPath = join(directory, 'project')
    await mkdir(join(projectPath, 'Demo.xcodeproj'), { recursive: true })
    const commands: RuntimeCommandRequest[] = []
    const execute = async (request: RuntimeCommandRequest) => {
      commands.push(request)
      if (request.args[0] === 'xcodebuild' && request.args.includes('-showBuildSettings')) {
        return {
          code: 0,
          output: '',
          stdout: JSON.stringify([
            {
              target: 'Core',
              buildSettings: {
                WRAPPER_EXTENSION: 'framework',
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.Core',
                PRODUCT_TYPE: 'com.apple.product-type.framework'
              }
            }
          ])
        }
      }
      return { code: 0, output: '', stdout: '' }
    }
    const service = new ProjectSimulatorService(join(directory, 'runtime'), () => undefined, execute)
    const project = projectRecord(projectPath)
    project.runtimeAdapter!.scheme = 'Core'

    await expect(service.launch(project)).rejects.toThrow(
      'Core Scheme은 Simulator에 설치할 수 있는 iOS 앱이 아닙니다'
    )
    expect(commands).toHaveLength(1)
    expect(commands[0].args).toContain('-showBuildSettings')
    expect(commands.some((request) => request.args.includes('build'))).toBe(false)
    expect(commands.some((request) => request.args.includes('simctl'))).toBe(false)
  })
})
