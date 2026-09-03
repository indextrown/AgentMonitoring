import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IosSimulatorLaunchResult } from '../../electron/main/ios-simulator-runtime'
import {
  evaluateRuntimeAcceptance,
  summarizeRuntimeAcceptance,
  writeRuntimeAcceptanceEvidence,
  type RuntimeAcceptanceAssertion
} from '../../electron/main/runtime-acceptance'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

function launchResult(options: {
  accessibilityContent?: string
  debugStateContent?: string
  includeScreen?: boolean
} = {}): IosSimulatorLaunchResult {
  const accessibilityContent = options.accessibilityContent ?? JSON.stringify({
    schemaVersion: 1,
    root: {
      identifier: 'root',
      children: [
        {
          identifier: 'start-navigation',
          label: '항해 시작',
          title: '',
          elementType: 'Button',
          enabled: true,
          selected: false,
          children: []
        }
      ]
    }
  })
  const debugStateContent = options.debugStateContent ?? JSON.stringify({
    schemaVersion: 1,
    state: {
      navigation: { route: 'active' },
      waypoints: [{ name: '부산항' }]
    }
  })
  return {
    deviceId: 'IPHONE-UDID',
    deviceName: 'iPhone 17 Pro',
    bundleIdentifier: 'com.example.App',
    processId: 4242,
    appPath: '/tmp/App.app',
    screenEvidence: options.includeScreen === false
      ? null
      : {
          path: '/tmp/screen.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          capturedAt: '2026-09-03T00:00:00.000Z'
        },
    accessibilityEvidence: {
      path: '/tmp/accessibility.json',
      mimeType: 'application/json',
      sizeBytes: Buffer.byteLength(accessibilityContent),
      capturedAt: '2026-09-03T00:00:00.000Z',
      nodeCount: 2,
      truncated: false,
      content: accessibilityContent
    },
    uiActionEvidence: null,
    debugStateEvidence: {
      path: '/tmp/debug-state.json',
      mimeType: 'application/json',
      sizeBytes: Buffer.byteLength(debugStateContent),
      capturedAt: '2026-09-03T00:00:00.000Z',
      hasState: true,
      fixtureId: null,
      content: debugStateContent
    }
  }
}

describe('runtime acceptance', () => {
  it('evaluates state, accessibility, and evidence assertions without executing code', () => {
    const assertions: RuntimeAcceptanceAssertion[] = [
      {
        kind: 'state',
        name: '활성 경로 확인',
        path: ['navigation', 'route'],
        operator: 'equals',
        expected: 'active'
      },
      {
        kind: 'state',
        path: ['waypoints', 0, 'name'],
        operator: 'equals',
        expected: '부산항'
      },
      {
        kind: 'accessibility',
        identifier: 'start-navigation',
        property: 'enabled',
        expected: true
      },
      {
        kind: 'accessibility',
        identifier: 'missing-alert',
        property: 'exists',
        expected: false
      },
      { kind: 'evidence', target: 'screen' }
    ]

    const report = evaluateRuntimeAcceptance(
      assertions,
      launchResult(),
      '2026-09-03T00:00:01.000Z'
    )

    expect(report).toMatchObject({
      schemaVersion: 1,
      evaluatedAt: '2026-09-03T00:00:01.000Z',
      passed: true,
      assertionCount: 5,
      passedCount: 5
    })
    expect(report.results[0]).toMatchObject({
      description: '활성 경로 확인',
      expected: '"active"',
      actual: '"active"'
    })
    expect(summarizeRuntimeAcceptance(report)).toBe('runtime acceptance 5/5 통과')
  })

  it('fails missing state paths, duplicate identifiers, and missing evidence deterministically', () => {
    const duplicateAccessibility = JSON.stringify({
      schemaVersion: 1,
      root: {
        identifier: 'root',
        children: [
          { identifier: 'status', label: '준비', children: [] },
          { identifier: 'status', label: '완료', children: [] }
        ]
      }
    })
    const assertions: RuntimeAcceptanceAssertion[] = [
      {
        kind: 'state',
        path: ['navigation', 'missing'],
        operator: 'not-equals',
        expected: 'error'
      },
      {
        kind: 'accessibility',
        identifier: 'status',
        property: 'label',
        expected: '완료'
      },
      { kind: 'evidence', target: 'screen' }
    ]

    const report = evaluateRuntimeAcceptance(
      assertions,
      launchResult({ accessibilityContent: duplicateAccessibility, includeScreen: false })
    )

    expect(report).toMatchObject({ passed: false, assertionCount: 3, passedCount: 0 })
    expect(report.results.map((item) => item.actual)).toEqual([
      '"(경로 없음)"',
      '"(identifier 2개 중복)"',
      'false'
    ])
    expect(summarizeRuntimeAcceptance(report)).toContain('runtime acceptance 0/3 통과 · 실패:')
  })

  it('stores a bounded JSON report inside the task evidence directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-acceptance-'))
    temporaryDirectories.push(directory)
    const taskId = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(directory, taskId, 'evidence'), { recursive: true })
    const report = evaluateRuntimeAcceptance(
      [{ kind: 'evidence', target: 'screen' }],
      launchResult(),
      '2026-09-03T00:00:01.000Z'
    )

    const evidence = await writeRuntimeAcceptanceEvidence(directory, taskId, report)

    expect(evidence.path.startsWith(await realpath(join(directory, taskId, 'evidence')))).toBe(true)
    expect(evidence.mimeType).toBe('application/json')
    expect(JSON.parse(await readFile(evidence.path, 'utf8'))).toMatchObject({
      passed: true,
      assertionCount: 1,
      passedCount: 1
    })
  })
})
