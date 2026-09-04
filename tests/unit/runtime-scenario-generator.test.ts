import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverProjectRuntimeConfig,
  findXcodeContainersOnDisk,
  findTrackedXcodeContainers,
  parseIosAppTargets,
  parseXcodeSchemes,
  selectAppSchemeCandidates,
  selectXcodeContainer
} from '../../electron/main/project-runtime-config'
import {
  buildApprovedRuntimeContract,
  RuntimeScenarioGenerator
} from '../../electron/main/runtime-scenario-generator'

const adapter = {
  kind: 'ios-simulator' as const,
  container: 'Demo.xcodeproj',
  scheme: 'Demo',
  configuration: 'Debug' as const,
  deviceFamily: 'iphone' as const
}

describe('runtime scenario generation', () => {
  it('recovers a generated scenario from Codex JSON events when the result file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-monitoring-scenario-fallback-'))
    const fakeCodex = join(root, 'fake-codex.mjs')
    try {
      const payload = {
        summary: '저장 버튼을 누른 뒤 완료 화면을 확인합니다.',
        permissions: [],
        actions: [{
          kind: 'tap',
          identifier: 'save-profile',
          text: null,
          timeoutSeconds: 10
        }],
        assertions: [{
          name: '완료 화면 표시',
          identifier: 'profile-complete-screen',
          property: 'exists',
          expected: true
        }]
      }
      await writeFile(fakeCodex, [
        '#!/usr/bin/env node',
        "if (!process.argv.includes('--json')) process.exit(2)",
        `console.log(${JSON.stringify(JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(payload) }
        }))})`
      ].join('\n'), 'utf8')
      await chmod(fakeCodex, 0o700)

      const generated = await new RuntimeScenarioGenerator(fakeCodex).generate({
        projectPath: root,
        title: '프로필 저장',
        prompt: '저장 후 완료 화면을 표시합니다.',
        adapter
      })

      expect(generated.summary).toBe(payload.summary)
      expect(generated.contract.runtimeScenario.actions).toEqual([
        { kind: 'tap', identifier: 'save-profile', timeoutSeconds: 10 }
      ])
      expect(generated.contract.runtimeScenario.assertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ identifier: 'profile-complete-screen', expected: true })
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers a tracked workspace and ignores the project-internal workspace', () => {
    expect(findTrackedXcodeContainers([
      'Demo.xcodeproj/project.pbxproj',
      'Demo.xcodeproj/project.xcworkspace/contents.xcworkspacedata',
      'AppWorkspace.xcworkspace/contents.xcworkspacedata'
    ])).toEqual(['AppWorkspace.xcworkspace', 'Demo.xcodeproj'])
  })

  it('finds generated Xcode containers without traversing build dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-monitoring-xcode-discovery-'))
    try {
      await mkdir(join(root, 'Generated', 'Demo.xcodeproj'), { recursive: true })
      await writeFile(join(root, 'Generated', 'Demo.xcodeproj', 'project.pbxproj'), '// generated')
      await mkdir(join(root, 'Demo.xcworkspace'), { recursive: true })
      await writeFile(join(root, 'Demo.xcworkspace', 'contents.xcworkspacedata'), '<Workspace />')
      await mkdir(join(root, 'Pods', 'Ignored.xcodeproj'), { recursive: true })
      await writeFile(join(root, 'Pods', 'Ignored.xcodeproj', 'project.pbxproj'), '// dependency')

      await expect(findXcodeContainersOnDisk(root)).resolves.toEqual([
        'Demo.xcworkspace',
        'Generated/Demo.xcodeproj'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers Git-tracked containers over generated disk candidates', () => {
    expect(selectXcodeContainer(
      ['TrackedApp.xcodeproj'],
      ['GeneratedApp.xcworkspace']
    )).toBe('TrackedApp.xcodeproj')
    expect(selectXcodeContainer(
      [],
      ['GeneratedApp.xcodeproj', 'GeneratedApp.xcworkspace']
    )).toBe('GeneratedApp.xcworkspace')
  })

  it('parses schemes from Xcode project and workspace output', () => {
    expect(parseXcodeSchemes(JSON.stringify({ project: { schemes: ['Demo', 'DemoTests'] } }))).toEqual([
      'Demo',
      'DemoTests'
    ])
    expect(parseXcodeSchemes(JSON.stringify({ workspace: { schemes: ['WorkspaceApp'] } }))).toEqual([
      'WorkspaceApp'
    ])
    expect(parseXcodeSchemes('not-json')).toEqual([])
  })

  it('keeps only installable iOS app products from Xcode build settings', () => {
    expect(parseIosAppTargets(JSON.stringify([
      {
        target: 'Core',
        buildSettings: {
          PRODUCT_TYPE: 'com.apple.product-type.framework',
          WRAPPER_EXTENSION: 'framework',
          PRODUCT_BUNDLE_IDENTIFIER: 'com.example.Core'
        }
      },
      {
        target: 'YeobaekApp',
        buildSettings: {
          PRODUCT_TYPE: 'com.apple.product-type.application',
          WRAPPER_EXTENSION: 'app',
          PRODUCT_BUNDLE_IDENTIFIER: 'com.example.Yeobaek',
          SUPPORTED_PLATFORMS: 'iphoneos iphonesimulator'
        }
      }
    ]))).toEqual(['YeobaekApp'])
  })

  it('prefers a direct app scheme over workspace schemes that only include the app target', () => {
    expect(selectAppSchemeCandidates([
      { scheme: 'Yeobaek-Workspace', targets: ['YeobaekApp'] },
      { scheme: 'YeobaekApp', targets: ['YeobaekApp'] }
    ])).toEqual([{ scheme: 'YeobaekApp', targets: ['YeobaekApp'] }])
  })

  it('detects the app scheme instead of the first framework scheme in a Tuist workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-monitoring-tuist-runtime-'))
    try {
      await mkdir(join(root, 'Yeobaek.xcworkspace'), { recursive: true })
      await writeFile(join(root, 'Yeobaek.xcworkspace', 'contents.xcworkspacedata'), '<Workspace />')
      const execute = async (_command: string, args: string[]) => {
        if (args[0] === '-C') return { stdout: '' }
        if (args.includes('-list')) {
          return { stdout: JSON.stringify({ workspace: { schemes: ['Core', 'Yeobaek-Workspace', 'YeobaekApp'] } }) }
        }
        const scheme = args[args.indexOf('-scheme') + 1]
        if (scheme === 'Core') {
          return {
            stdout: JSON.stringify([{
              target: 'Core',
              buildSettings: {
                PRODUCT_TYPE: 'com.apple.product-type.framework',
                WRAPPER_EXTENSION: 'framework',
                PRODUCT_BUNDLE_IDENTIFIER: 'com.example.Core'
              }
            }])
          }
        }
        return {
          stdout: JSON.stringify([{
            target: 'YeobaekApp',
            buildSettings: {
              PRODUCT_TYPE: 'com.apple.product-type.application',
              WRAPPER_EXTENSION: 'app',
              PRODUCT_BUNDLE_IDENTIFIER: 'com.example.Yeobaek',
              SUPPORTED_PLATFORMS: 'iphoneos iphonesimulator'
            }
          }])
        }
      }

      await expect(discoverProjectRuntimeConfig(root, { execute })).resolves.toEqual({
        state: 'ready',
        container: 'Yeobaek.xcworkspace',
        appSchemes: [{ scheme: 'YeobaekApp', targets: ['YeobaekApp'] }],
        selectedScheme: 'YeobaekApp',
        message: 'YeobaekApp iOS 앱 Scheme을 찾았습니다.'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires selection when a workspace has multiple direct app schemes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-monitoring-multiple-apps-'))
    try {
      await mkdir(join(root, 'Multi.xcworkspace'), { recursive: true })
      await writeFile(join(root, 'Multi.xcworkspace', 'contents.xcworkspacedata'), '<Workspace />')
      const execute = async (_command: string, args: string[]) => {
        if (args[0] === '-C') return { stdout: '' }
        if (args.includes('-list')) {
          return { stdout: JSON.stringify({ workspace: { schemes: ['Consumer', 'Enterprise'] } }) }
        }
        const scheme = args[args.indexOf('-scheme') + 1]
        return {
          stdout: JSON.stringify([{
            target: scheme,
            buildSettings: {
              PRODUCT_TYPE: 'com.apple.product-type.application',
              WRAPPER_EXTENSION: 'app',
              PRODUCT_BUNDLE_IDENTIFIER: `com.example.${scheme}`,
              SUPPORTED_PLATFORMS: 'iphonesimulator'
            }
          }])
        }
      }

      const discovery = await discoverProjectRuntimeConfig(root, { execute })
      expect(discovery.state).toBe('selection-required')
      expect(discovery.selectedScheme).toBeNull()
      expect(discovery.appSchemes.map((candidate) => candidate.scheme)).toEqual(['Consumer', 'Enterprise'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds a frozen contract with UI actions, acceptance checks, and evidence', () => {
    const contract = buildApprovedRuntimeContract(adapter, {
      summary: '항목을 입력하고 추가 결과를 확인합니다.',
      permissions: [],
      actions: [
        {
          kind: 'type-text',
          identifier: 'shopping-item-input',
          text: '우유',
          timeoutSeconds: 10
        },
        {
          kind: 'tap',
          identifier: 'add-shopping-item',
          text: null,
          timeoutSeconds: 10
        }
      ],
      assertions: [
        {
          name: '추가한 항목 표시',
          identifier: 'shopping-item-row',
          property: 'exists',
          expected: true
        }
      ]
    })

    expect(contract.adapter).toEqual(adapter)
    expect(contract.capabilities.act).toEqual(['ui'])
    expect(contract.runtimeScenario.actions).toHaveLength(2)
    expect(contract.runtimeScenario.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'accessibility', identifier: 'shopping-item-row' }),
        expect.objectContaining({ kind: 'evidence', target: 'screen' }),
        expect.objectContaining({ kind: 'evidence', target: 'accessibility' }),
        expect.objectContaining({ kind: 'evidence', target: 'ui-actions' })
      ])
    )
  })

  it('does not request UI action evidence for a display-only scenario', () => {
    const contract = buildApprovedRuntimeContract(adapter, {
      summary: '새 화면이 표시되는지 확인합니다.',
      permissions: [],
      actions: [],
      assertions: [
        {
          name: '화면 표시',
          identifier: 'profile-screen',
          property: 'exists',
          expected: true
        }
      ]
    })

    expect(contract.capabilities.act).toEqual([])
    expect(contract.runtimeScenario.assertions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'ui-actions' })])
    )
  })

  it('moves a legacy location permission button into a Simulator precondition', () => {
    const contract = buildApprovedRuntimeContract(adapter, {
      summary: '위치 권한을 준비하고 현재 위치로 이동합니다.',
      permissions: [],
      actions: [
        {
          kind: 'tap',
          identifier: '앱을 사용하는 동안 허용',
          text: null,
          timeoutSeconds: 10
        },
        {
          kind: 'tap',
          identifier: 'map-current-location-button',
          text: null,
          timeoutSeconds: 10
        }
      ],
      assertions: [
        {
          name: '현재 위치 표시',
          identifier: 'current-location-marker',
          property: 'exists',
          expected: true
        }
      ]
    })

    expect(contract.runtimeScenario.permissions).toEqual([
      { service: 'location', state: 'granted' }
    ])
    expect(contract.runtimeScenario.actions).toEqual([
      { kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }
    ])
  })
})
