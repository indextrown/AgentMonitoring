import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ApprovedRuntimeContract,
  ApprovedRuntimeContractV1,
  GeneratedRuntimeScenario,
  IosRuntimeAdapterConfig,
  RuntimeAcceptanceAssertion,
  RuntimeEnvironmentRequirement,
  RuntimeScenarioCase,
  RuntimeScenarioStep,
  RuntimeUiAction,
  TaskTechSpecDraft
} from '../../src/shared/types'
import { buildCodexEnvironment, CODEX_AUTH_ARGUMENTS } from './codex-auth'
import { execCodexFile } from './codex-exec'
import { readCodexStructuredOutput } from './codex-structured-output'
import { projectCapabilityManifestSchema } from './project-capabilities'
import { normalizeRuntimeScenarioEnvironment } from '../../src/shared/runtime-scenario-policy'
import { taskRuntimeContractV2Schema } from './runtime-contract'

const GENERATION_TIMEOUT_MS = 3 * 60_000

const generatedScenarioSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
    permissions: z.array(z.object({
      service: z.enum([
        'calendar',
        'contacts-limited',
        'contacts',
        'location',
        'location-always',
        'photos-add',
        'photos',
        'media-library',
        'microphone',
        'motion',
        'reminders',
        'siri'
      ]),
      state: z.enum(['granted', 'denied', 'reset'])
    }).strict()).max(12),
    actions: z.array(z.object({
      kind: z.enum(['tap', 'type-text']),
      identifier: z.string().trim().min(1).max(256),
      text: z.string().max(2_000).nullable(),
      timeoutSeconds: z.number().int().min(1).max(30)
    }).strict()).max(20),
    assertions: z.array(z.object({
      name: z.string().trim().min(1).max(160),
      identifier: z.string().trim().min(1).max(256),
      property: z.enum(['exists', 'label', 'title', 'value', 'placeholderValue', 'elementType', 'enabled', 'selected']),
      expected: z.union([z.string().max(2_000), z.boolean()])
    }).strict()).min(1).max(40)
  })
  .strict()
  .superRefine((scenario, context) => {
    scenario.actions.forEach((action, index) => {
      if (action.kind === 'type-text' && !action.text?.length) {
        context.addIssue({ code: 'custom', path: ['actions', index, 'text'], message: '텍스트 입력에는 text가 필요합니다.' })
      }
      if (action.kind === 'tap' && action.text !== null) {
        context.addIssue({ code: 'custom', path: ['actions', index, 'text'], message: '탭 동작의 text는 null이어야 합니다.' })
      }
    })
    scenario.assertions.forEach((assertion, index) => {
      const expectsBoolean = ['exists', 'enabled', 'selected'].includes(assertion.property)
      if (expectsBoolean !== (typeof assertion.expected === 'boolean')) {
        context.addIssue({
          code: 'custom',
          path: ['assertions', index, 'expected'],
          message: `${assertion.property} 속성의 예상값 형식이 올바르지 않습니다.`
        })
      }
    })
  })

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'permissions', 'actions', 'assertions'],
  properties: {
    summary: { type: 'string' },
    permissions: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['service', 'state'],
        properties: {
          service: {
            type: 'string',
            enum: [
              'calendar',
              'contacts-limited',
              'contacts',
              'location',
              'location-always',
              'photos-add',
              'photos',
              'media-library',
              'microphone',
              'motion',
              'reminders',
              'siri'
            ]
          },
          state: { type: 'string', enum: ['granted', 'denied', 'reset'] }
        }
      }
    },
    actions: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'identifier', 'text', 'timeoutSeconds'],
        properties: {
          kind: { type: 'string', enum: ['tap', 'type-text'] },
          identifier: { type: 'string' },
          text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30 }
        }
      }
    },
    assertions: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'identifier', 'property', 'expected'],
        properties: {
          name: { type: 'string' },
          identifier: { type: 'string' },
          property: {
            type: 'string',
            enum: ['exists', 'label', 'title', 'value', 'placeholderValue', 'elementType', 'enabled', 'selected']
          },
          expected: { anyOf: [{ type: 'string' }, { type: 'boolean' }] }
        }
      }
    }
  }
} as const

const generatedAssertionSchema = z.object({
  name: z.string().trim().min(1).max(160),
  identifier: z.string().trim().min(1).max(256),
  property: z.enum(['exists', 'label', 'title', 'value', 'placeholderValue', 'elementType', 'enabled', 'selected']),
  expected: z.union([z.string().max(2_000), z.boolean()])
}).strict().superRefine((assertion, context) => {
  const expectsBoolean = ['exists', 'enabled', 'selected'].includes(assertion.property)
  if (expectsBoolean !== (typeof assertion.expected === 'boolean')) {
    context.addIssue({ code: 'custom', path: ['expected'], message: `${assertion.property} 속성의 예상값 형식이 올바르지 않습니다.` })
  }
})

const generatedActionSchema = z.object({
  kind: z.enum(['tap', 'type-text']),
  identifier: z.string().trim().min(1).max(256),
  text: z.string().max(2_000).nullable(),
  timeoutSeconds: z.number().int().min(1).max(30)
}).strict().superRefine((action, context) => {
  if (action.kind === 'type-text' && !action.text?.length) {
    context.addIssue({ code: 'custom', path: ['text'], message: '텍스트 입력에는 text가 필요합니다.' })
  }
  if (action.kind === 'tap' && action.text !== null) {
    context.addIssue({ code: 'custom', path: ['text'], message: '탭 동작의 text는 null이어야 합니다.' })
  }
})

const generatedScenarioV2Schema = z.object({
  summary: z.string().trim().min(1).max(500),
  environmentRequirements: z.array(z.object({
    key: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().trim().min(1).max(120),
    required: z.boolean()
  }).strict()).max(20),
  cases: z.array(z.object({
    id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().trim().min(1).max(160),
    permissions: z.array(z.object({
      service: z.enum([
        'calendar', 'contacts-limited', 'contacts', 'location', 'location-always',
        'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri'
      ]),
      state: z.enum(['granted', 'denied', 'reset'])
    }).strict()).max(12),
    requiredEnvironmentKeys: z.array(z.string().trim().regex(/^[a-z][a-z0-9-]*$/)).max(20),
    resetAppData: z.boolean(),
    steps: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('action'), action: generatedActionSchema }).strict(),
      z.object({ kind: z.literal('assert'), assertions: z.array(generatedAssertionSchema).min(1).max(40) }).strict()
    ])).min(1).max(60)
  }).strict()).min(1).max(12)
}).strict()

const ASSERTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'identifier', 'property', 'expected'],
  properties: {
    name: { type: 'string' },
    identifier: { type: 'string' },
    property: { type: 'string', enum: ['exists', 'label', 'title', 'value', 'placeholderValue', 'elementType', 'enabled', 'selected'] },
    expected: { anyOf: [{ type: 'string' }, { type: 'boolean' }] }
  }
} as const

const ACTION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'identifier', 'text', 'timeoutSeconds'],
  properties: {
    kind: { type: 'string', enum: ['tap', 'type-text'] },
    identifier: { type: 'string' },
    text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30 }
  }
} as const

const OUTPUT_SCHEMA_V2 = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'environmentRequirements', 'cases'],
  properties: {
    summary: { type: 'string' },
    environmentRequirements: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'required'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          required: { type: 'boolean' }
        }
      }
    },
    cases: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'permissions', 'requiredEnvironmentKeys', 'resetAppData', 'steps'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          permissions: OUTPUT_SCHEMA.properties.permissions,
          requiredEnvironmentKeys: { type: 'array', maxItems: 20, items: { type: 'string' } },
          resetAppData: { type: 'boolean' },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 60,
            items: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'action'],
                  properties: { kind: { const: 'action' }, action: ACTION_OUTPUT_SCHEMA }
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'assertions'],
                  properties: {
                    kind: { const: 'assert' },
                    assertions: { type: 'array', minItems: 1, maxItems: 40, items: ASSERTION_OUTPUT_SCHEMA }
                  }
                }
              ]
            }
          }
        }
      }
    }
  }
} as const

function normalizeActions(actions: z.infer<typeof generatedScenarioSchema>['actions']): RuntimeUiAction[] {
  return actions.map((action) => action.kind === 'tap'
    ? { kind: 'tap', identifier: action.identifier, timeoutSeconds: action.timeoutSeconds }
    : {
        kind: 'type-text',
        identifier: action.identifier,
        text: action.text!,
        timeoutSeconds: action.timeoutSeconds
      })
}

function normalizeAssertions(
  assertions: z.infer<typeof generatedScenarioSchema>['assertions'],
  hasActions: boolean
): RuntimeAcceptanceAssertion[] {
  const normalized = assertions.map((assertion) => ({
    kind: 'accessibility' as const,
    name: assertion.name,
    identifier: assertion.identifier,
    property: assertion.property,
    expected: assertion.expected
  })) as RuntimeAcceptanceAssertion[]
  normalized.push(
    { kind: 'evidence', name: '최종 화면 저장', target: 'screen' },
    { kind: 'evidence', name: '접근성 트리 저장', target: 'accessibility' }
  )
  if (hasActions) {
    normalized.push({ kind: 'evidence', name: 'UI 조작 결과 저장', target: 'ui-actions' })
  }
  return normalized
}

export function buildApprovedRuntimeContract(
  adapter: IosRuntimeAdapterConfig,
  generated: z.infer<typeof generatedScenarioSchema>
): ApprovedRuntimeContractV1 {
  const normalizedEnvironment = normalizeRuntimeScenarioEnvironment({
    permissions: generated.permissions,
    actions: normalizeActions(generated.actions)
  })
  const actions = normalizedEnvironment.actions
  const contract: ApprovedRuntimeContractV1 = {
    version: 1,
    adapter,
    capabilities: {
      build: true,
      run: true,
      observe: ['screen', 'accessibility'],
      act: actions.length > 0 ? ['ui'] : [],
      verify: ['test-command', 'runtime-scenario']
    },
    runtimeScenario: {
      permissions: normalizedEnvironment.permissions,
      actions,
      assertions: normalizeAssertions(generated.assertions, actions.length > 0)
    }
  }
  projectCapabilityManifestSchema.parse(contract)
  return contract
}

export function buildApprovedRuntimeContractV2(
  adapter: IosRuntimeAdapterConfig,
  generated: z.infer<typeof generatedScenarioV2Schema>
): ApprovedRuntimeContract {
  const environmentRequirements: RuntimeEnvironmentRequirement[] = generated.environmentRequirements
  const cases: RuntimeScenarioCase[] = generated.cases.map((scenario) => {
    const steps: RuntimeScenarioStep[] = scenario.steps.map((step) => {
      if (step.kind === 'action') {
        const [action] = normalizeActions([step.action])
        return { kind: 'action', action }
      }
      return {
        kind: 'assert',
        assertions: normalizeAssertions(step.assertions, false).filter(
          (assertion) => assertion.kind === 'accessibility'
        )
      }
    })
    const normalized = normalizeRuntimeScenarioEnvironment({
      permissions: scenario.permissions,
      actions: steps.flatMap((step) => step.kind === 'action' ? [step.action] : [])
    })
    let actionIndex = 0
    const normalizedSteps: RuntimeScenarioStep[] = []
    for (const step of steps) {
      if (step.kind === 'assert') {
        normalizedSteps.push(step)
        continue
      }
      const action = normalized.actions[actionIndex]
      actionIndex += 1
      if (action) normalizedSteps.push({ kind: 'action', action })
    }
    return {
      id: scenario.id,
      name: scenario.name,
      preconditions: {
        permissions: normalized.permissions,
        requiredEnvironmentKeys: scenario.requiredEnvironmentKeys,
        resetAppData: scenario.resetAppData
      },
      steps: normalizedSteps
    }
  })
  const hasActions = cases.some((scenario) => scenario.steps.some((step) => step.kind === 'action'))
  const contract: ApprovedRuntimeContract = {
    version: 2,
    adapter,
    capabilities: {
      build: true,
      run: true,
      observe: ['screen', 'accessibility'],
      act: hasActions ? ['ui'] : [],
      verify: ['test-command', 'runtime-scenario']
    },
    environmentRequirements,
    runtimeScenarios: { cases }
  }
  taskRuntimeContractV2Schema.parse(contract)
  return contract
}

export class RuntimeScenarioGenerator {
  constructor(
    private readonly codexCommand = 'codex',
    private readonly codexHome?: string
  ) {}

  async generate(input: {
    projectPath: string
    title: string
    prompt: string
    techSpec?: TaskTechSpecDraft | null
    adapter: IosRuntimeAdapterConfig
  }): Promise<GeneratedRuntimeScenario> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-monitoring-scenario-'))
    const schemaPath = join(temporaryDirectory, 'schema.json')
    const outputPath = join(temporaryDirectory, 'scenario.json')
    try {
      await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA_V2), { encoding: 'utf8', mode: 0o600 })
      const instructions = [
        '당신은 iOS 앱의 작업별 인수 검증 시나리오 설계자입니다.',
        `작업 제목: ${input.title}`,
        `작업 목표와 완료 조건:\n${input.prompt}`,
        input.techSpec
          ? `사람이 승인한 테크스펙 revision ${input.techSpec.revision}:\n${input.techSpec.markdown}`
          : '이 작업에는 별도로 승인된 테크스펙이 없습니다.',
        `실행 대상: ${input.adapter.container} / ${input.adapter.scheme} / ${input.adapter.deviceFamily}`,
        '저장소를 읽기 전용으로 확인하고, 이 작업의 사용자 동작과 관찰 가능한 성공 조건만 JSON으로 설계하세요.',
        '서로 다른 권한, 토큰 유무, fixture, 성공·실패 상태는 반드시 별도 cases로 나누세요. 각 케이스는 앱을 새로 실행합니다.',
        'iOS 개인정보 권한은 시스템 팝업 문구를 action identifier로 사용하지 말고 각 케이스 permissions에 선언하세요.',
        '저장소 밖의 토큰이나 로컬 설정이 필요하면 실제 값을 쓰지 말고 environmentRequirements와 requiredEnvironmentKeys에 소문자 kebab-case key만 선언하세요.',
        '하나의 케이스에 환경값이 있는 상태와 없는 상태를 동시에 기대하지 마세요.',
        '기존 화면의 accessibilityIdentifier는 코드에 있는 값을 사용하세요.',
        '새 화면이나 새 요소는 구현자가 그대로 추가할 수 있는 소문자 kebab-case identifier를 제안하세요.',
        'steps에는 action과 그 직후 확인할 assert 체크포인트를 실제 사용자 순서대로 배치하세요.',
        'assertions는 구현 세부사항이 아니라 그 시점에 사용자에게 보이는 결과를 검사하세요.',
        '한 assertion의 property가 exists/enabled/selected면 expected는 boolean이고, 나머지는 string이어야 합니다.',
        'tap action의 text는 null, type-text action의 text는 실제 입력 예시여야 합니다.',
        '코드를 수정하지 마세요. 저장소를 이해하기 위한 읽기 전용 명령만 사용할 수 있습니다.'
      ].join('\n\n')
      const { stdout } = await execCodexFile(
        this.codexCommand,
        [
          ...(this.codexHome ? CODEX_AUTH_ARGUMENTS : []),
          'exec',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--json',
          '--cd',
          input.projectPath,
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          instructions
        ],
        {
          cwd: input.projectPath,
          env: this.codexHome ? buildCodexEnvironment(this.codexHome, this.codexCommand) : process.env,
          encoding: 'utf8',
          maxBuffer: 16_000_000,
          timeout: GENERATION_TIMEOUT_MS
        }
      )
      const generated = generatedScenarioV2Schema.parse(
        await readCodexStructuredOutput(outputPath, stdout, '검증 시나리오')
      )
      return {
        summary: generated.summary,
        contract: buildApprovedRuntimeContractV2(input.adapter, generated)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error('검증 시나리오 생성이 3분 안에 끝나지 않았습니다.')
      }
      throw new Error(`검증 시나리오를 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
