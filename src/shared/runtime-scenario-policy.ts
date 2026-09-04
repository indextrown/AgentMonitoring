import type {
  RuntimePrivacyPermission,
  RuntimeUiAction,
  TaskRuntimeScenario
} from './types'

const legacyPermissionActions = new Map<string, RuntimePrivacyPermission>([
  ['앱을 사용하는 동안 허용', { service: 'location', state: 'granted' }],
  ['한 번 허용', { service: 'location', state: 'granted' }],
  ['allow while using app', { service: 'location', state: 'granted' }],
  ['allow while using the app', { service: 'location', state: 'granted' }],
  ['allow once', { service: 'location', state: 'granted' }]
])

function normalizedIdentifier(identifier: string): string {
  return identifier.trim().toLocaleLowerCase('en-US')
}

export interface NormalizedRuntimeScenarioEnvironment {
  permissions: RuntimePrivacyPermission[]
  actions: RuntimeUiAction[]
  migratedSystemActionIdentifiers: string[]
}

/**
 * Converts legacy iOS system permission button actions into Simulator privacy preconditions.
 * Explicit permission entries always win over a migrated action for the same service.
 */
export function normalizeRuntimeScenarioEnvironment(
  scenario: Pick<TaskRuntimeScenario, 'permissions' | 'actions'> | null | undefined
): NormalizedRuntimeScenarioEnvironment {
  const permissions = [...(scenario?.permissions ?? [])]
  const configuredServices = new Set(permissions.map((permission) => permission.service))
  const actions: RuntimeUiAction[] = []
  const migratedSystemActionIdentifiers: string[] = []

  for (const action of scenario?.actions ?? []) {
    const permission = action.kind === 'tap'
      ? legacyPermissionActions.get(normalizedIdentifier(action.identifier))
      : undefined
    if (!permission) {
      actions.push(action)
      continue
    }

    migratedSystemActionIdentifiers.push(action.identifier)
    if (!configuredServices.has(permission.service)) {
      permissions.push(permission)
      configuredServices.add(permission.service)
    }
  }

  return { permissions, actions, migratedSystemActionIdentifiers }
}
