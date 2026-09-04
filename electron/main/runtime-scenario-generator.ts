import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type {
  ApprovedRuntimeContract,
  GeneratedRuntimeScenario,
  IosRuntimeAdapterConfig,
  RuntimeAcceptanceAssertion,
  RuntimeUiAction,
  TaskTechSpecDraft
} from '../../src/shared/types'
import { buildCodexEnvironment, CODEX_AUTH_ARGUMENTS } from './codex-auth'
import { projectCapabilityManifestSchema } from './project-capabilities'

const execFileAsync = promisify(execFile)
const GENERATION_TIMEOUT_MS = 3 * 60_000

const generatedScenarioSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
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
  required: ['summary', 'actions', 'assertions'],
  properties: {
    summary: { type: 'string' },
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
): ApprovedRuntimeContract {
  const actions = normalizeActions(generated.actions)
  const contract: ApprovedRuntimeContract = {
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
      actions,
      assertions: normalizeAssertions(generated.assertions, actions.length > 0)
    }
  }
  projectCapabilityManifestSchema.parse(contract)
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
      await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA), { encoding: 'utf8', mode: 0o600 })
      const instructions = [
        '당신은 iOS 앱의 작업별 인수 검증 시나리오 설계자입니다.',
        `작업 제목: ${input.title}`,
        `작업 목표와 완료 조건:\n${input.prompt}`,
        input.techSpec
          ? `사람이 승인한 테크스펙 revision ${input.techSpec.revision}:\n${input.techSpec.markdown}`
          : '이 작업에는 별도로 승인된 테크스펙이 없습니다.',
        `실행 대상: ${input.adapter.container} / ${input.adapter.scheme} / ${input.adapter.deviceFamily}`,
        '저장소를 읽기 전용으로 확인하고, 이 작업의 사용자 동작과 관찰 가능한 성공 조건만 JSON으로 설계하세요.',
        '기존 화면의 accessibilityIdentifier는 코드에 있는 값을 사용하세요.',
        '새 화면이나 새 요소는 구현자가 그대로 추가할 수 있는 소문자 kebab-case identifier를 제안하세요.',
        'actions는 실제 사용자 순서대로 작성하세요. 단순 표시 확인 작업은 빈 배열이어도 됩니다.',
        'assertions는 구현 세부사항이 아니라 사용자에게 보이는 결과를 검사하세요.',
        '한 assertion의 property가 exists/enabled/selected면 expected는 boolean이고, 나머지는 string이어야 합니다.',
        'tap action의 text는 null, type-text action의 text는 실제 입력 예시여야 합니다.',
        '코드를 수정하지 마세요. 저장소를 이해하기 위한 읽기 전용 명령만 사용할 수 있습니다.'
      ].join('\n\n')
      await execFileAsync(
        this.codexCommand,
        [
          ...(this.codexHome ? CODEX_AUTH_ARGUMENTS : []),
          'exec',
          '--ephemeral',
          '--sandbox',
          'read-only',
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
          maxBuffer: 4_000_000,
          timeout: GENERATION_TIMEOUT_MS
        }
      )
      const generated = generatedScenarioSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')))
      return {
        summary: generated.summary,
        contract: buildApprovedRuntimeContract(input.adapter, generated)
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
