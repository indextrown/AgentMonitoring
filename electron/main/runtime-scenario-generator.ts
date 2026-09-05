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
import { extractCodexFailureMessage, readCodexStructuredOutput } from './codex-structured-output'
import { projectCapabilityManifestSchema } from './project-capabilities'
import { normalizeRuntimeScenarioEnvironment } from '../../src/shared/runtime-scenario-policy'
import { taskRuntimeContractV2Schema } from './runtime-contract'
import { hasIgnoredXcconfigFiles } from './ignored-xcconfig'

const GENERATION_TIMEOUT_MS = 3 * 60_000
const SENSITIVE_LAUNCH_VARIABLE_PATTERN = /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/

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
    launchVariables: z.record(
      z.string().trim().regex(/^UITEST_[A-Z0-9_]+$/),
      z.string().max(200)
    ),
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
        required: ['id', 'name', 'permissions', 'requiredEnvironmentKeys', 'launchVariables', 'resetAppData', 'steps'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          permissions: OUTPUT_SCHEMA.properties.permissions,
          requiredEnvironmentKeys: { type: 'array', maxItems: 20, items: { type: 'string' } },
          launchVariables: {
            type: 'object',
            maxProperties: 12,
            propertyNames: { pattern: '^UITEST_[A-Z0-9_]+$' },
            additionalProperties: { type: 'string', maxLength: 200 }
          },
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
  generated: z.infer<typeof generatedScenarioV2Schema>,
  availableEnvironmentKeys?: string[]
): ApprovedRuntimeContract {
  const availableKeys = availableEnvironmentKeys === undefined
    ? null
    : new Set(availableEnvironmentKeys)
  const runnableCases = availableKeys === null
    ? generated.cases
    : generated.cases.filter((scenario) => (
        scenario.requiredEnvironmentKeys.every((key) => availableKeys.has(key))
      ))
  if (runnableCases.length === 0) {
    throw new Error('현재 등록된 실행 환경에서 수행할 Simulator 검증 케이스가 없습니다.')
  }
  const usedEnvironmentKeys = new Set(runnableCases.flatMap((scenario) => scenario.requiredEnvironmentKeys))
  const environmentRequirements: RuntimeEnvironmentRequirement[] = generated.environmentRequirements.filter(
    (requirement) => usedEnvironmentKeys.has(requirement.key)
  )
  const cases: RuntimeScenarioCase[] = runnableCases.map((scenario) => {
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
        // 조작 없이 연속된 체크포인트는 서로 다른 시점을 표현할 수 없다.
        // 런타임이 재현할 수 있는 마지막 안정 상태만 유지한다.
        if (normalizedSteps.at(-1)?.kind === 'assert') normalizedSteps.pop()
        normalizedSteps.push(step)
        continue
      }
      const action = normalized.actions[actionIndex]
      actionIndex += 1
      if (action) normalizedSteps.push({ kind: 'action', action })
    }
    const safeLaunchVariables = Object.fromEntries(
      Object.entries(scenario.launchVariables).filter(([name, value]) => (
        !value || !SENSITIVE_LAUNCH_VARIABLE_PATTERN.test(name)
      ))
    )
    return {
      id: scenario.id,
      name: scenario.name,
      preconditions: {
        permissions: normalized.permissions,
        requiredEnvironmentKeys: scenario.requiredEnvironmentKeys,
        launchVariables: safeLaunchVariables,
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
    legacyContract?: ApprovedRuntimeContractV1 | null
    previousContract?: ApprovedRuntimeContract | null
    availableEnvironmentKeys?: string[]
    localBuildConfigurationAvailable?: boolean
  }): Promise<GeneratedRuntimeScenario> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-monitoring-scenario-'))
    const schemaPath = join(temporaryDirectory, 'schema.json')
    const outputPath = join(temporaryDirectory, 'scenario.json')
    try {
      await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA_V2), { encoding: 'utf8', mode: 0o600 })
      const previousContract = input.previousContract ?? input.legacyContract
      const approvedContext = input.techSpec
        ? `사람이 승인한 테크스펙 revision ${input.techSpec.revision}(가장 우선하는 합격 기준):\n${input.techSpec.markdown}`
        : '이 작업에는 별도로 승인된 테크스펙이 없습니다.'
      const previousContext = previousContract
        ? [
            previousContract.version === 1
              ? '아래 version 1 계약은 모든 조작이 끝난 뒤 모든 조건을 한 번에 검사해 서로 다른 화면과 상태가 충돌할 수 있습니다.'
              : '아래 기존 계약을 현재 코드와 실행 환경에서 재현 가능한지 다시 검토하세요.',
            '기존 의도를 유지하되 현재 IDE가 자동으로 준비할 수 없는 상태와 순간적인 중간 상태는 제외하세요.',
            `기존 계약:\n${JSON.stringify(previousContract)}`,
            '기존 identifier는 유지하되, 실행 가능한 디버그 fixture가 있는지 관련 코드와 UI 테스트만 읽기 전용으로 확인하세요.'
          ].join('\n\n')
        : '기존 Simulator 검증 계약이 없습니다.'
      const sourceContext = [approvedContext, previousContext].join('\n\n')
      const localBuildConfigurationAvailable = input.localBuildConfigurationAvailable ?? await hasIgnoredXcconfigFiles(
        input.projectPath
      ).catch(() => false)
      const instructions = [
        '당신은 iOS 앱의 작업별 인수 검증 시나리오 설계자입니다.',
        `작업 제목: ${input.title}`,
        `작업 목표와 완료 조건:\n${input.prompt}`,
        sourceContext,
        `실행 대상: ${input.adapter.container} / ${input.adapter.scheme} / ${input.adapter.deviceFamily}`,
        '저장소를 읽기 전용으로 확인하고, 이 작업의 사용자 동작과 관찰 가능한 성공 조건만 JSON으로 설계하세요.',
        input.availableEnvironmentKeys?.length
          ? `이미 등록된 실행 환경 key: ${input.availableEnvironmentKeys.join(', ')}`
          : '등록된 실행 환경 key가 없습니다. environmentRequirements와 requiredEnvironmentKeys는 반드시 빈 배열로 두세요.',
        localBuildConfigurationAvailable
          ? 'Git에서 제외된 로컬 xcconfig가 작업공간에 안전하게 동기화되어 빌드에 사용됩니다. 파일 내용이나 비밀값은 열거나 출력하지 말고 tracked 코드와 빌드 설정의 참조만 확인하세요. 앱이 이 빌드 설정으로 토큰을 받는 정상 경로는 별도 환경 key나 launchVariable 없이 실행 가능한 성공 case로 포함할 수 있습니다.'
          : '작업공간에서 사용할 수 있는 Git 제외 로컬 xcconfig가 없습니다. 외부 비밀값이 필요한 정상 경로를 임의 값으로 재현하지 마세요.',
        '서로 다른 권한, 토큰 유무, fixture, 성공·실패 상태는 반드시 별도 cases로 나누세요. 각 케이스는 앱을 새로 실행합니다.',
        'iOS 개인정보 권한은 시스템 팝업 문구를 action identifier로 사용하지 말고 각 케이스 permissions에 선언하세요.',
        '저장소 밖의 토큰이나 로컬 설정은 위에 나열된 이미 등록된 key만 environmentRequirements와 requiredEnvironmentKeys에 사용하세요. 등록되지 않은 key나 fixture를 새로 만들지 마세요.',
        '코드에 실제로 존재하는 UITEST_ 접두사의 비밀이 아닌 디버그 fixture는 case.launchVariables에 직접 선언하세요. 비밀번호, 토큰, key, secret, 사용자 데이터는 테스트용 가짜 값이라도 절대 넣지 마세요. 없음을 검증하는 빈 문자열만 허용됩니다.',
        '등록된 환경값이나 코드에 존재하는 UITEST_ fixture로 재현할 수 없는 오류·timeout·토큰 상태는 Simulator cases에서 제외하세요. 그 분기는 프로젝트 테스트가 검증합니다.',
        '하나의 케이스에 환경값이 있는 상태와 없는 상태를 동시에 기대하지 마세요.',
        '기존 화면의 accessibilityIdentifier는 코드에 있는 값을 사용하세요.',
        '새 화면이나 새 요소는 구현자가 그대로 추가할 수 있는 소문자 kebab-case identifier를 제안하세요.',
        '모든 assertion은 작업 목표나 승인된 테크스펙의 명시적인 문장으로 근거를 설명할 수 있어야 합니다. 예를 들어 “자동 요청을 반복하지 않는다”를 “카메라 위치까지 유지한다”로 강화하지 마세요.',
        '기존 UI 테스트는 식별자·fixture·조작 방법을 알기 위한 근거이며 새 제품 요구사항을 만드는 근거가 아닙니다.',
        'steps에는 action과 그 직후 확인할 assert 체크포인트를 실제 사용자 순서대로 배치하세요.',
        '조작 없이 assert step을 연속해 시간 흐름을 표현하지 마세요. 런타임은 각 체크포인트를 독립 실행하므로 조작 후 안정된 최종 상태만 검증하세요.',
        'ProgressView 노출이나 버튼이 순간적으로 disabled되는 로딩 중간 상태는 Simulator assertion으로 만들지 마세요.',
        'assertions는 구현 세부사항이 아니라 그 시점에 사용자에게 보이는 결과를 검사하세요.',
        '한 assertion의 property가 exists/enabled/selected면 expected는 boolean이고, 나머지는 string이어야 합니다.',
        '최종 JSON을 출력하기 전에 각 assertion이 어느 작업 목표나 승인 테크스펙 문장을 검증하는지 스스로 비평하고, 근거가 없는 조건은 제거하세요.',
        'tap action의 text는 null, type-text action의 text는 실제 입력 예시여야 합니다.',
        '코드를 수정하지 마세요. 저장소를 이해하기 위한 읽기 전용 명령만 사용할 수 있습니다.'
      ].join('\n\n')
      const baseArguments = [
          ...(this.codexHome ? CODEX_AUTH_ARGUMENTS : []),
          'exec',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--json',
          '--cd', input.projectPath,
          '--output-last-message',
          outputPath
      ]
      const options = {
          cwd: input.projectPath,
          env: this.codexHome ? buildCodexEnvironment(this.codexHome, this.codexCommand) : process.env,
          encoding: 'utf8',
          maxBuffer: 16_000_000,
          timeout: GENERATION_TIMEOUT_MS
        } as const
      let stdout: string
      try {
        ;({ stdout } = await execCodexFile(
          this.codexCommand,
          [...baseArguments, '--output-schema', schemaPath, instructions],
          options
        ))
      } catch (error) {
        const processError = error as Error & { code?: unknown, stdout?: unknown, stderr?: unknown }
        const hasOutput = [processError.stdout, processError.stderr]
          .some((value) => typeof value === 'string' && value.trim())
        if (processError.code !== 1 || hasOutput) throw error
        await writeFile(outputPath, '', { encoding: 'utf8', mode: 0o600 })
        ;({ stdout } = await execCodexFile(
          this.codexCommand,
          [
            ...baseArguments,
            [
              instructions,
              '응답은 설명이나 Markdown 없이 JSON 객체 하나만 출력하세요.',
              '최상위 형식은 {"summary":string,"environmentRequirements":[{"key":string,"label":string,"required":boolean}],"cases":case[]} 입니다.',
              '각 case 형식은 {"id":kebab-case string,"name":string,"permissions":[{"service":string,"state":"granted"|"denied"|"reset"}],"requiredEnvironmentKeys":string[],"launchVariables":{"UITEST_NAME":string},"resetAppData":boolean,"steps":step[]} 입니다. preconditions 필드는 만들지 마세요.',
              'action step은 {"kind":"action","action":{"kind":"tap"|"type-text","identifier":string,"text":string|null,"timeoutSeconds":1..30}} 입니다.',
              'assert step은 {"kind":"assert","assertions":[{"name":string,"identifier":string,"property":"exists"|"label"|"title"|"value"|"placeholderValue"|"elementType"|"enabled"|"selected","expected":string|boolean}]} 입니다.',
              'environmentRequirements에는 key, label, required만 넣고, 케이스가 사용할 key는 case.requiredEnvironmentKeys에 넣으세요.'
            ].join('\n\n')
          ],
          options
        ))
      }
      const generated = generatedScenarioV2Schema.parse(
        await readCodexStructuredOutput(outputPath, stdout, '검증 시나리오')
      )
      return {
        summary: generated.summary,
        contract: buildApprovedRuntimeContractV2(
          input.adapter,
          generated,
          input.availableEnvironmentKeys
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error('검증 시나리오 생성이 3분 안에 끝나지 않았습니다.')
      }
      if (error instanceof z.ZodError) {
        const issues = error.issues.slice(0, 8).map((issue) => (
          `${issue.path.join('.') || '응답'}: ${issue.message}`
        )).join(' · ')
        throw new Error(`검증 시나리오 형식이 올바르지 않습니다: ${issues}`)
      }
      const stdout = (error as Error & { stdout?: unknown }).stdout
      const codexFailure = typeof stdout === 'string' ? extractCodexFailureMessage(stdout) : null
      if (codexFailure) {
        throw new Error(`검증 시나리오를 만들지 못했습니다: ${codexFailure}`)
      }
      const processError = error as Error & { code?: unknown, stderr?: unknown }
      const stderr = typeof processError.stderr === 'string'
        ? processError.stderr.trim().split(/\r?\n/).slice(-12).join('\n')
        : ''
      const stdoutTail = typeof stdout === 'string'
        ? stdout.trim().split(/\r?\n/).slice(-12).join('\n')
        : ''
      const details = [
        processError.code ? `Codex 종료 코드 ${String(processError.code)}` : '',
        stdoutTail,
        stderr
      ].filter(Boolean).join('\n')
      throw new Error(
        `검증 시나리오를 만들지 못했습니다: ${details || (error instanceof Error ? error.message : String(error))}`
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
