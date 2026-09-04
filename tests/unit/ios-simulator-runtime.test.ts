import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  launchIosSimulatorRuntime,
  parseAccessibilityObserverOutput,
  parseAvailableSimulatorDevices,
  parseUiActionObserverOutput,
  type RuntimeUiAction,
  type RuntimeCommandRequest
} from '../../electron/main/ios-simulator-runtime'

const temporaryDirectories: string[] = []

function accessibilityObserverOutput(bundleIdentifier = 'com.example.PopPang'): string {
  const payload = {
    schemaVersion: 1,
    bundleIdentifier,
    capturedAt: '2026-09-03T00:00:00Z',
    nodeCount: 2,
    truncated: false,
    root: {
      elementType: 'Application',
      identifier: '',
      label: 'PopPang',
      title: '',
      enabled: true,
      selected: false,
      frame: { x: 0, y: 0, width: 440, height: 956 },
      children: [
        {
          elementType: 'Button',
          identifier: 'start-navigation',
          label: '항해 시작',
          title: '',
          enabled: true,
          selected: false,
          frame: { x: 20, y: 800, width: 400, height: 48 },
          children: []
        }
      ]
    }
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64')
  return [
    'AGENTMONITOR_ACCESSIBILITY_BEGIN',
    encoded,
    'AGENTMONITOR_ACCESSIBILITY_END',
    ''
  ].join('\n')
}

function uiActionObserverOutput(
  actions: RuntimeUiAction[],
  bundleIdentifier = 'com.example.PopPang'
): string {
  const payload = {
    schemaVersion: 1,
    bundleIdentifier,
    executedAt: '2026-09-03T00:00:00Z',
    actionCount: actions.length,
    results: actions.map((action, index) => ({
      index,
      kind: action.kind,
      identifier: action.identifier,
      durationMilliseconds: 120 + index
    }))
  }
  return [
    'AGENTMONITOR_UI_ACTIONS_BEGIN',
    Buffer.from(JSON.stringify(payload)).toString('base64'),
    'AGENTMONITOR_UI_ACTIONS_END',
    ''
  ].join('\n')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('iOS Simulator runtime adapter', () => {
  it('selects the configured iPhone and builds, installs, and launches the worktree app', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-ios-runtime-'))
    temporaryDirectories.push(directory)
    const worktree = join(directory, 'worktree')
    const runtimeRoot = join(directory, 'runtime-sessions')
    const appDataContainer = join(directory, 'simulator-app-data')
    const taskId = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(worktree, 'PopPang.xcworkspace'), { recursive: true })
    await mkdir(appDataContainer)

    const commands: RuntimeCommandRequest[] = []
    const progress: string[] = []
    const progressUpdates: Array<Record<string, unknown>> = []
    const uiActions: RuntimeUiAction[] = [
      { kind: 'tap', identifier: 'start-navigation', timeoutSeconds: 10 },
      {
        kind: 'type-text',
        identifier: 'destination-search',
        text: '부산항',
        timeoutSeconds: 12
      }
    ]
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
                  udid: 'IPAD-UDID',
                  name: 'iPad Pro 13-inch',
                  state: 'Booted',
                  isAvailable: true
                },
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
      if (request.command === '/usr/bin/xcrun' && request.args[0] === 'xcodebuild' && request.args.at(-1) === 'build') {
        const derivedDataPath = request.args[request.args.indexOf('-derivedDataPath') + 1]
        await mkdir(join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator', 'PopPang.app'), {
          recursive: true
        })
        return { code: 0, output: 'BUILD SUCCEEDED', stdout: 'BUILD SUCCEEDED\n' }
      }
      if (request.command === '/usr/bin/xcrun' && request.args[0] === 'xcodebuild' && request.args.includes('-showBuildSettings')) {
        const derivedDataPath = request.args[request.args.indexOf('-derivedDataPath') + 1]
        return {
          code: 0,
          output: '',
          stdout: JSON.stringify([
            {
              target: 'PopPangTests',
              buildSettings: {
                TARGET_BUILD_DIR: join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'PopPangTests.xctest',
                WRAPPER_EXTENSION: 'xctest',
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.PopPangTests',
                PRODUCT_TYPE: 'com.apple.product-type.bundle.unit-test'
              }
            },
            {
              target: 'PopPang',
              buildSettings: {
                TARGET_BUILD_DIR: join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator'),
                WRAPPER_NAME: 'PopPang.app',
                WRAPPER_EXTENSION: 'app',
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.PopPang',
                PRODUCT_TYPE: 'com.apple.product-type.application',
                SKIP_INSTALL: 'NO'
              }
            }
          ])
        }
      }
      if (request.args.some((argument) => argument.startsWith('-only-testing:'))) {
        const stdout = `${uiActionObserverOutput(uiActions)}${accessibilityObserverOutput()}`
        return { code: 0, output: stdout, stdout }
      }
      if (request.args.includes('launch')) {
        return { code: 0, output: 'com.example.PopPang: 4242\n', stdout: 'com.example.PopPang: 4242\n' }
      }
      if (request.args[1] === 'get_app_container') {
        return { code: 0, output: appDataContainer, stdout: `${appDataContainer}\n` }
      }
      if (request.args.includes('screenshot')) {
        await writeFile(request.args.at(-1)!, 'fixture-png')
        return { code: 0, output: 'Wrote screenshot', stdout: '' }
      }
      return { code: 0, output: '', stdout: '' }
    }

    const result = await launchIosSimulatorRuntime({
      taskId,
      worktreePath: worktree,
      runtimeRoot,
      contract: {
        kind: 'ios-simulator',
        container: 'PopPang.xcworkspace',
        scheme: 'PopPang',
        configuration: 'Debug',
        deviceFamily: 'iphone'
      },
      captureScreen: true,
      captureAccessibility: true,
      captureState: true,
      privacyPermissions: [{ service: 'location', state: 'granted' }],
      uiActions,
      debugBridge: { protocol: 'file-v1', responseTimeoutSeconds: 10 },
      debugFixture: {
        id: 'signed-in-home',
        payload: { accountID: 'fixture-user', selectedTab: 'home' }
      },
      execute,
      wait: async () => {
        const requests = join(
          appDataContainer,
          'Library',
          'Application Support',
          'AgentMonitoring',
          'Requests'
        )
        const responses = join(
          appDataContainer,
          'Library',
          'Application Support',
          'AgentMonitoring',
          'Responses'
        )
        const requestFiles = await readdir(requests).catch(() => [])
        await Promise.all(requestFiles.map(async (requestFile) => {
          const request = JSON.parse(await readFile(join(requests, requestFile), 'utf8'))
          await writeFile(
            join(responses, `${request.requestId}.json`),
            JSON.stringify({
              schemaVersion: 1,
              requestId: request.requestId,
              completedAt: '2026-09-03T00:00:00Z',
              fixture: request.fixture
                ? { id: request.fixture.id, appliedAt: '2026-09-03T00:00:00Z' }
                : null,
              ...(request.captureState
                ? { state: { route: 'home', selectedTab: 'home', isNavigating: false } }
                : {})
            })
          )
        }))
      },
      onProgress: (status, _message, update) => {
        progress.push(status)
        progressUpdates.push(update ?? {})
      }
    })

    expect(result).toMatchObject({
      deviceId: 'IPHONE-UDID',
      deviceName: 'iPhone 16 Pro',
      bundleIdentifier: 'com.example.PopPang',
      processId: 4242,
      screenEvidence: {
        mimeType: 'image/png',
        sizeBytes: 11
      },
      accessibilityEvidence: {
        mimeType: 'application/json',
        nodeCount: 2,
        truncated: false
      },
      uiActionEvidence: {
        mimeType: 'application/json',
        actionCount: 2
      },
      debugStateEvidence: {
        mimeType: 'application/json',
        hasState: true,
        fixtureId: 'signed-in-home'
      }
    })
    expect(result.screenEvidence?.path).toMatch(/runtime-sessions\/.+\/evidence\/screen-.+\.png$/)
    expect(progress).toEqual([
      'preparing',
      'booting',
      'building',
      'installing',
      'preparing',
      'launching',
      'acting',
      'acting',
      'observing',
      'observing'
    ])
    expect(progressUpdates).toEqual([
      {},
      { deviceId: 'IPHONE-UDID', deviceName: 'iPhone 16 Pro' },
      {},
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      },
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      },
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      },
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      },
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      },
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      },
      {
        deviceId: 'IPHONE-UDID',
        deviceName: 'iPhone 16 Pro',
        bundleIdentifier: 'com.example.PopPang'
      }
    ])
    const resolvedWorktree = await realpath(worktree)
    expect(commands.map((request) => [request.command, ...request.args.slice(0, 3)])).toEqual([
      ['/usr/bin/xcrun', 'simctl', 'list', 'devices'],
      ['/usr/bin/xcrun', 'simctl', 'bootstatus', 'IPHONE-UDID'],
      ['/usr/bin/open', '-a', 'Simulator', '--args'],
      ['/usr/bin/xcrun', 'xcodebuild', '-workspace', join(resolvedWorktree, 'PopPang.xcworkspace')],
      ['/usr/bin/xcrun', 'xcodebuild', '-workspace', join(resolvedWorktree, 'PopPang.xcworkspace')],
      ['/usr/bin/xcrun', 'simctl', 'install', 'IPHONE-UDID'],
      ['/usr/bin/xcrun', 'simctl', 'privacy', 'IPHONE-UDID'],
      ['/usr/bin/xcrun', 'simctl', 'launch', '--terminate-running-process'],
      ['/usr/bin/xcrun', 'simctl', 'get_app_container', 'IPHONE-UDID'],
      ['/usr/bin/xcrun', 'xcodebuild', '-project', expect.stringContaining('AgentMonitoringAccessibility.xcodeproj')],
      ['/usr/bin/xcrun', 'simctl', 'get_app_container', 'IPHONE-UDID'],
      ['/usr/bin/xcrun', 'simctl', 'io', 'IPHONE-UDID']
    ])
    expect(result.accessibilityEvidence?.content).toContain('start-navigation')
    expect(result.uiActionEvidence?.content).toContain('destination-search')
    expect(result.debugStateEvidence?.content).toContain('signed-in-home')
    expect(result.debugStateEvidence?.content).toContain('selectedTab')
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        args: ['simctl', 'privacy', 'IPHONE-UDID', 'grant', 'location', 'com.example.PopPang']
      })
    ]))
    const testPlan = JSON.parse(
      await readFile(
        join(
          runtimeRoot,
          taskId,
          'accessibility-observer',
          'AgentMonitoringAccessibility.xctestplan'
        ),
        'utf8'
      )
    ) as {
      configurations: Array<{
        options: { environmentVariableEntries: Array<{ key: string; value: string }> }
      }>
    }
    const environment = Object.fromEntries(
      testPlan.configurations[0].options.environmentVariableEntries.map((entry) => [
        entry.key,
        entry.value
      ])
    )
    expect(environment.AGENTMONITOR_TARGET_BUNDLE_ID).toBe('com.example.PopPang')
    expect(environment.AGENTMONITOR_CAPTURE_ACCESSIBILITY).toBe('1')
    expect(JSON.parse(Buffer.from(environment.AGENTMONITOR_UI_ACTIONS_BASE64, 'base64').toString('utf8'))).toEqual(uiActions)
  })

  it('reports a clear error when no iPad Simulator is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-ios-runtime-'))
    temporaryDirectories.push(directory)
    const worktree = join(directory, 'worktree')
    await mkdir(join(worktree, 'PopPang.xcodeproj'), { recursive: true })

    await expect(
      launchIosSimulatorRuntime({
        taskId: '22222222-2222-4222-8222-222222222222',
        worktreePath: worktree,
        runtimeRoot: join(directory, 'runtime-sessions'),
        contract: {
          kind: 'ios-simulator',
          container: 'PopPang.xcodeproj',
          scheme: 'PopPang',
          configuration: 'Debug',
          deviceFamily: 'ipad'
        },
        captureScreen: false,
        captureAccessibility: false,
        captureState: false,
        privacyPermissions: [],
        uiActions: [],
        debugBridge: null,
        debugFixture: null,
        execute: async () => ({
          code: 0,
          output: '',
          stdout: JSON.stringify({
            devices: {
              runtime: [
                { udid: 'IPHONE-UDID', name: 'iPhone 16 Pro', state: 'Shutdown', isAvailable: true }
              ]
            }
          })
        }),
        onProgress: () => undefined
      })
    ).rejects.toThrow('사용 가능한 iPad Simulator가 없습니다.')
  })

  it('rejects Xcode containers that escape through a symbolic link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-ios-runtime-'))
    temporaryDirectories.push(directory)
    const worktree = join(directory, 'worktree')
    const external = join(directory, 'external.xcworkspace')
    await mkdir(worktree)
    await mkdir(external)
    await symlink(external, join(worktree, 'PopPang.xcworkspace'))

    await expect(
      launchIosSimulatorRuntime({
        taskId: '33333333-3333-4333-8333-333333333333',
        worktreePath: worktree,
        runtimeRoot: join(directory, 'runtime-sessions'),
        contract: {
          kind: 'ios-simulator',
          container: 'PopPang.xcworkspace',
          scheme: 'PopPang',
          configuration: 'Debug',
          deviceFamily: 'ipad'
        },
        captureScreen: false,
        captureAccessibility: false,
        captureState: false,
        privacyPermissions: [],
        uiActions: [],
        debugBridge: null,
        debugFixture: null,
        execute: async () => ({ code: 0, output: '', stdout: '' }),
        onProgress: () => undefined
      })
    ).rejects.toThrow('심볼릭 링크가 아닌 디렉터리여야 합니다.')
  })

  it('rejects task runtime directories that escape through a symbolic link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-ios-runtime-'))
    temporaryDirectories.push(directory)
    const worktree = join(directory, 'worktree')
    const runtimeRoot = join(directory, 'runtime-sessions')
    const external = join(directory, 'external-runtime')
    const taskId = '44444444-4444-4444-8444-444444444444'
    await mkdir(join(worktree, 'PopPang.xcodeproj'), { recursive: true })
    await mkdir(runtimeRoot)
    await mkdir(external)
    await symlink(external, join(runtimeRoot, taskId))

    await expect(
      launchIosSimulatorRuntime({
        taskId,
        worktreePath: worktree,
        runtimeRoot,
        contract: {
          kind: 'ios-simulator',
          container: 'PopPang.xcodeproj',
          scheme: 'PopPang',
          configuration: 'Debug',
          deviceFamily: 'ipad'
        },
        captureScreen: false,
        captureAccessibility: false,
        captureState: false,
        privacyPermissions: [],
        uiActions: [],
        debugBridge: null,
        debugFixture: null,
        execute: async () => ({ code: 0, output: '', stdout: '' }),
        onProgress: () => undefined
      })
    ).rejects.toThrow('심볼릭 링크가 아닌 디렉터리여야 합니다.')
  })

  it('prefers a booted iPad before newer shutdown devices', () => {
    const devices = parseAvailableSimulatorDevices(
      JSON.stringify({
        devices: {
          'runtime-27': [
            { udid: 'NEW', name: 'iPad Air', state: 'Shutdown', isAvailable: true }
          ],
          'runtime-26': [
            { udid: 'BOOTED', name: 'iPad Pro', state: 'Booted', isAvailable: true }
          ]
        }
      }),
      'ipad'
    )

    expect(devices.map((device) => device.udid)).toEqual(['BOOTED', 'NEW'])
  })

  it('uses device type identifiers to separate iPhone and iPad families', () => {
    const source = JSON.stringify({
      devices: {
        runtime: [
          {
            udid: 'PHONE',
            name: 'Custom phone name',
            state: 'Shutdown',
            isAvailable: true,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro'
          },
          {
            udid: 'TABLET',
            name: 'Custom tablet name',
            state: 'Booted',
            isAvailable: true,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB'
          }
        ]
      }
    })

    expect(parseAvailableSimulatorDevices(source, 'iphone').map((device) => device.udid)).toEqual([
      'PHONE'
    ])
    expect(parseAvailableSimulatorDevices(source, 'ipad').map((device) => device.udid)).toEqual([
      'TABLET'
    ])
  })

  it('rejects accessibility trees from a different bundle identifier', () => {
    expect(() =>
      parseAccessibilityObserverOutput(
        accessibilityObserverOutput('com.example.Other'),
        'com.example.PopPang'
      )
    ).toThrow('bundle identifier가 실행한 앱과 다릅니다')
  })

  it('rejects malformed accessibility observer output', () => {
    expect(() =>
      parseAccessibilityObserverOutput(
        'AGENTMONITOR_ACCESSIBILITY_BEGIN\nnot-base64!\nAGENTMONITOR_ACCESSIBILITY_END',
        'com.example.PopPang'
      )
    ).toThrow('올바른 base64가 아닙니다')
  })

  it('accepts only UI action results that match the requested identifier sequence', () => {
    const actions: RuntimeUiAction[] = [
      { kind: 'tap', identifier: 'start-navigation', timeoutSeconds: 10 }
    ]
    expect(
      parseUiActionObserverOutput(
        uiActionObserverOutput(actions),
        'com.example.PopPang',
        actions
      )
    ).toMatchObject({ actionCount: 1, results: [{ identifier: 'start-navigation' }] })

    expect(() =>
      parseUiActionObserverOutput(
        uiActionObserverOutput(actions),
        'com.example.PopPang',
        [{ kind: 'tap', identifier: 'different-control', timeoutSeconds: 10 }]
      )
    ).toThrow('요청한 action 계약과 다릅니다')
  })
})
