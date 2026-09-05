import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IosRuntimePreflightError,
  isCoreSimulatorServiceFailureOutput,
  prepareIosRuntimeEnvironment
} from '../../electron/main/ios-runtime-preflight'
import type { RuntimeCommandRequest } from '../../electron/main/ios-simulator-runtime'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('iOS runtime preflight', () => {
  it('generates a missing Tuist workspace and reopens a disconnected Simulator service', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'agent-monitoring-ios-preflight-'))
    temporaryDirectories.push(worktreePath)
    await writeFile(join(worktreePath, 'Workspace.swift'), '// Tuist workspace\n')
    const requests: RuntimeCommandRequest[] = []
    let simulatorProbeCount = 0

    const result = await prepareIosRuntimeEnvironment({
      worktreePath,
      adapter: {
        kind: 'ios-simulator',
        container: 'Demo.xcworkspace',
        scheme: 'Demo',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      execute: async (request) => {
        requests.push(request)
        if (request.command === 'tuist') {
          await mkdir(join(worktreePath, 'Demo.xcworkspace'))
          await writeFile(
            join(worktreePath, 'Demo.xcworkspace', 'contents.xcworkspacedata'),
            '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="1.0"></Workspace>\n'
          )
          return { code: 0, output: 'Generated workspace', stdout: 'Generated workspace' }
        }
        if (request.command === '/usr/bin/open') {
          return { code: 0, output: '', stdout: '' }
        }
        simulatorProbeCount += 1
        return simulatorProbeCount === 1
          ? {
              code: 1,
              output: 'CoreSimulatorService connection became invalid',
              stdout: ''
            }
          : { code: 0, output: '{"devices":{}}', stdout: '{"devices":{}}' }
      },
      wait: async () => undefined
    })

    expect(result).toEqual({ containerGenerated: true, simulatorRecovered: true })
    expect(requests.map(({ command, args }) => [command, ...args])).toEqual([
      ['tuist', 'generate', '--no-open'],
      ['/usr/bin/xcrun', 'simctl', 'list', 'devices', 'available', '--json'],
      ['/usr/bin/open', '-a', 'Simulator'],
      ['/usr/bin/xcrun', 'simctl', 'list', 'devices', 'available', '--json']
    ])
  })

  it('stops before AI work when a missing container cannot be generated', async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), 'agent-monitoring-ios-preflight-'))
    temporaryDirectories.push(worktreePath)

    await expect(prepareIosRuntimeEnvironment({
      worktreePath,
      adapter: {
        kind: 'ios-simulator',
        container: 'Demo.xcodeproj',
        scheme: 'Demo',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      execute: async () => ({ code: 0, output: '', stdout: '' })
    })).rejects.toBeInstanceOf(IosRuntimePreflightError)
  })

  it('recognizes CoreSimulator service failures without matching product test failures', () => {
    expect(isCoreSimulatorServiceFailureOutput('Failed to initialize simulator device set')).toBe(true)
    expect(isCoreSimulatorServiceFailureOutput('XCTAssertEqual failed: expected 1, got 2')).toBe(false)
  })
})
