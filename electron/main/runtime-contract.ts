import { z } from 'zod'
import type {
  ApprovedRuntimeContract,
  ApprovedRuntimeContractV1,
  RuntimeAcceptanceAssertion,
  RuntimeScenarioCase
} from '../../src/shared/types'
import {
  iosRuntimeAdapterSchema,
  projectCapabilityManifestSchema,
  runtimeAcceptanceAssertionSchema,
  runtimePrivacyPermissionSchema,
  runtimeUiActionSchema
} from './project-capabilities'

const environmentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/, '환경 항목 key는 소문자 kebab-case여야 합니다.')

const runtimeEnvironmentRequirementSchema = z.object({
  key: environmentKeySchema,
  label: z.string().trim().min(1).max(120),
  required: z.boolean()
}).strict()

const runtimeScenarioStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    action: runtimeUiActionSchema
  }).strict(),
  z.object({
    kind: z.literal('assert'),
    assertions: z.array(runtimeAcceptanceAssertionSchema).min(1).max(40)
  }).strict()
])

const runtimeScenarioCaseSchema = z.object({
  id: environmentKeySchema,
  name: z.string().trim().min(1).max(160),
  preconditions: z.object({
    permissions: z.array(runtimePrivacyPermissionSchema).max(12).optional(),
    requiredEnvironmentKeys: z.array(environmentKeySchema).max(20).optional(),
    resetAppData: z.boolean().optional()
  }).strict(),
  steps: z.array(runtimeScenarioStepSchema).min(1).max(60)
}).strict()

const contractCapabilitiesSchema = z.object({
  build: z.literal(true),
  run: z.literal(true),
  observe: z.array(z.enum(['screen', 'accessibility'])).max(2),
  act: z.array(z.literal('ui')).max(1),
  verify: z.array(z.enum(['test-command', 'runtime-scenario'])).max(2)
}).strict()

export const taskRuntimeContractV2Schema = z.object({
  version: z.literal(2),
  adapter: iosRuntimeAdapterSchema,
  capabilities: contractCapabilitiesSchema,
  environmentRequirements: z.array(runtimeEnvironmentRequirementSchema).max(20),
  runtimeScenarios: z.object({
    cases: z.array(runtimeScenarioCaseSchema).min(1).max(12)
  }).strict()
}).strict().superRefine((contract, context) => {
  const declaredKeys = new Set<string>()
  contract.environmentRequirements.forEach((requirement, index) => {
    if (declaredKeys.has(requirement.key)) {
      context.addIssue({
        code: 'custom',
        path: ['environmentRequirements', index, 'key'],
        message: `${requirement.key} 환경 항목은 한 번만 선언할 수 있습니다.`
      })
    }
    declaredKeys.add(requirement.key)
  })

  const caseIds = new Set<string>()
  contract.runtimeScenarios.cases.forEach((scenario, caseIndex) => {
    if (caseIds.has(scenario.id)) {
      context.addIssue({
        code: 'custom',
        path: ['runtimeScenarios', 'cases', caseIndex, 'id'],
        message: `${scenario.id} 검증 케이스 id가 중복됐습니다.`
      })
    }
    caseIds.add(scenario.id)

    const permissionServices = new Set<string>()
    ;(scenario.preconditions.permissions ?? []).forEach((permission, permissionIndex) => {
      if (permissionServices.has(permission.service)) {
        context.addIssue({
          code: 'custom',
          path: ['runtimeScenarios', 'cases', caseIndex, 'preconditions', 'permissions', permissionIndex, 'service'],
          message: `${permission.service} 권한은 한 케이스에서 한 번만 설정할 수 있습니다.`
        })
      }
      permissionServices.add(permission.service)
    })

    ;(scenario.preconditions.requiredEnvironmentKeys ?? []).forEach((key, keyIndex) => {
      if (!declaredKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['runtimeScenarios', 'cases', caseIndex, 'preconditions', 'requiredEnvironmentKeys', keyIndex],
          message: `${key} 환경 항목이 environmentRequirements에 선언되지 않았습니다.`
        })
      }
    })

    scenario.steps.forEach((step, stepIndex) => {
      if (step.kind !== 'assert') return
      const expectations = new Map<string, string>()
      step.assertions.forEach((assertion, assertionIndex) => {
        if (assertion.kind !== 'accessibility') return
        const key = `${assertion.identifier}:${assertion.property}`
        const value = JSON.stringify(assertion.expected)
        const previous = expectations.get(key)
        if (previous !== undefined && previous !== value) {
          context.addIssue({
            code: 'custom',
            path: ['runtimeScenarios', 'cases', caseIndex, 'steps', stepIndex, 'assertions', assertionIndex],
            message: `같은 체크포인트의 ${key} 예상값이 서로 충돌합니다.`
          })
        }
        expectations.set(key, value)
      })
    })
  })
})

export const taskRuntimeContractSchema = z.union([
  projectCapabilityManifestSchema,
  taskRuntimeContractV2Schema
])

export function runtimeContractCases(
  contract: ApprovedRuntimeContract
): RuntimeScenarioCase[] {
  if (contract.version === 2) return contract.runtimeScenarios.cases
  return [legacyRuntimeCase(contract)]
}

export function legacyRuntimeCase(
  contract: ApprovedRuntimeContractV1
): RuntimeScenarioCase {
  return {
    id: 'legacy-runtime-scenario',
    name: '기존 Simulator 검증',
    preconditions: {
      permissions: contract.runtimeScenario.permissions ?? []
    },
    steps: [
      ...contract.runtimeScenario.actions.map((action) => ({
        kind: 'action' as const,
        action
      })),
      ...(contract.runtimeScenario.assertions.length > 0
        ? [{ kind: 'assert' as const, assertions: contract.runtimeScenario.assertions }]
        : [])
    ]
  }
}

export function runtimeCaseActions(scenario: RuntimeScenarioCase): ApprovedRuntimeContractV1['runtimeScenario']['actions'] {
  return scenario.steps.flatMap((step) => step.kind === 'action' ? [step.action] : [])
}

export function runtimeCaseAssertions(scenario: RuntimeScenarioCase): RuntimeAcceptanceAssertion[] {
  return scenario.steps.flatMap((step) => step.kind === 'assert' ? step.assertions : [])
}

export function requiredRuntimeEnvironmentKeys(contract: ApprovedRuntimeContract): string[] {
  if (contract.version === 1) return []
  return [...new Set(contract.runtimeScenarios.cases.flatMap(
    (scenario) => scenario.preconditions.requiredEnvironmentKeys ?? []
  ))]
}
