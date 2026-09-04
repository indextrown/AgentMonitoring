import { describe, expect, it } from 'vitest'
import {
  requiredRuntimeEnvironmentKeys,
  runtimeContractCases,
  taskRuntimeContractSchema
} from '../../electron/main/runtime-contract'
import type { ApprovedRuntimeContract, ApprovedRuntimeContractV1 } from '../../src/shared/types'

const adapter = {
  kind: 'ios-simulator' as const,
  container: 'Demo.xcodeproj',
  scheme: 'Demo',
  configuration: 'Debug' as const,
  deviceFamily: 'iphone' as const
}

describe('task runtime contract', () => {
  it('converts version 1 contracts into one legacy case', () => {
    const contract: ApprovedRuntimeContractV1 = {
      version: 1,
      adapter,
      capabilities: { build: true, run: true, observe: ['accessibility'], act: ['ui'], verify: ['runtime-scenario'] },
      runtimeScenario: {
        permissions: [{ service: 'location', state: 'granted' }],
        actions: [{ kind: 'tap', identifier: 'current-location', timeoutSeconds: 10 }],
        assertions: [{ kind: 'accessibility', identifier: 'map-screen', property: 'exists', expected: true }]
      }
    }
    expect(runtimeContractCases(contract)).toEqual([
      expect.objectContaining({
        id: 'legacy-runtime-scenario',
        preconditions: { permissions: [{ service: 'location', state: 'granted' }] }
      })
    ])
  })

  it('rejects contradictory expectations in the same checkpoint', () => {
    const contract = {
      version: 2,
      adapter,
      capabilities: { build: true, run: true, observe: ['accessibility'], act: [], verify: ['runtime-scenario'] },
      environmentRequirements: [],
      runtimeScenarios: {
        cases: [{
          id: 'map-screen',
          name: '지도 화면',
          preconditions: {},
          steps: [{
            kind: 'assert',
            assertions: [
              { kind: 'accessibility', identifier: 'map-screen', property: 'exists', expected: true },
              { kind: 'accessibility', identifier: 'map-screen', property: 'exists', expected: false }
            ]
          }]
        }]
      }
    }
    expect(() => taskRuntimeContractSchema.parse(contract)).toThrow('예상값이 서로 충돌')
  })

  it('rejects undeclared environment keys', () => {
    const contract = {
      version: 2,
      adapter,
      capabilities: { build: true, run: true, observe: ['screen'], act: [], verify: ['runtime-scenario'] },
      environmentRequirements: [],
      runtimeScenarios: {
        cases: [{
          id: 'token-path',
          name: '토큰 경로',
          preconditions: { requiredEnvironmentKeys: ['mapbox-token'] },
          steps: [{ kind: 'assert', assertions: [{ kind: 'evidence', target: 'screen' }] }]
        }]
      }
    }
    expect(() => taskRuntimeContractSchema.parse(contract)).toThrow('environmentRequirements')
  })

  it('preflights every environment key required by a case', () => {
    const contract = taskRuntimeContractSchema.parse({
      version: 2,
      adapter,
      capabilities: { build: true, run: true, observe: ['screen'], act: [], verify: ['runtime-scenario'] },
      environmentRequirements: [{ key: 'mapbox-token', label: 'Mapbox token', required: false }],
      runtimeScenarios: {
        cases: [{
          id: 'token-path',
          name: '토큰 경로',
          preconditions: { requiredEnvironmentKeys: ['mapbox-token'] },
          steps: [{ kind: 'assert', assertions: [{ kind: 'evidence', target: 'screen' }] }]
        }]
      }
    }) as ApprovedRuntimeContract

    expect(requiredRuntimeEnvironmentKeys(contract)).toEqual(['mapbox-token'])
  })
})
