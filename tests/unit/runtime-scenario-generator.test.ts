import { describe, expect, it } from 'vitest'
import {
  findTrackedXcodeContainers,
  parseXcodeSchemes
} from '../../electron/main/project-runtime-config'
import { buildApprovedRuntimeContract } from '../../electron/main/runtime-scenario-generator'

const adapter = {
  kind: 'ios-simulator' as const,
  container: 'Demo.xcodeproj',
  scheme: 'Demo',
  configuration: 'Debug' as const,
  deviceFamily: 'iphone' as const
}

describe('runtime scenario generation', () => {
  it('prefers a tracked workspace and ignores the project-internal workspace', () => {
    expect(findTrackedXcodeContainers([
      'Demo.xcodeproj/project.pbxproj',
      'Demo.xcodeproj/project.xcworkspace/contents.xcworkspacedata',
      'AppWorkspace.xcworkspace/contents.xcworkspacedata'
    ])).toEqual(['AppWorkspace.xcworkspace', 'Demo.xcodeproj'])
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

  it('builds a frozen contract with UI actions, acceptance checks, and evidence', () => {
    const contract = buildApprovedRuntimeContract(adapter, {
      summary: '항목을 입력하고 추가 결과를 확인합니다.',
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
})
