import { describe, expect, it } from 'vitest'
import { normalizeRuntimeScenarioEnvironment } from '../../src/shared/runtime-scenario-policy'

describe('runtime scenario environment policy', () => {
  it('converts the Korean iOS location prompt into a granted location precondition', () => {
    expect(normalizeRuntimeScenarioEnvironment({
      actions: [
        { kind: 'tap', identifier: '앱을 사용하는 동안 허용', timeoutSeconds: 10 },
        { kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }
      ]
    })).toEqual({
      permissions: [{ service: 'location', state: 'granted' }],
      actions: [{ kind: 'tap', identifier: 'map-current-location-button', timeoutSeconds: 10 }],
      migratedSystemActionIdentifiers: ['앱을 사용하는 동안 허용']
    })
  })

  it('keeps an explicit permission state when a legacy action requests the same service', () => {
    expect(normalizeRuntimeScenarioEnvironment({
      permissions: [{ service: 'location', state: 'reset' }],
      actions: [{ kind: 'tap', identifier: 'Allow While Using App', timeoutSeconds: 10 }]
    })).toEqual({
      permissions: [{ service: 'location', state: 'reset' }],
      actions: [],
      migratedSystemActionIdentifiers: ['Allow While Using App']
    })
  })
})
