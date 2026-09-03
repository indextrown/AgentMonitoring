import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ProjectCapability,
  ProjectCapabilityManifestInspection,
  ProjectRecord
} from '../../src/shared/types'

export const PROJECT_CAPABILITY_MANIFEST_PATH = '.agentmonitor/project.json'
const MAX_MANIFEST_BYTES = 64 * 1024

const relativeXcodeContainerSchema = z.string().min(1).max(512).refine(
  (value) => {
    const segments = value.split(/[\\/]/)
    return (
      !value.startsWith('/') &&
      !value.startsWith('~') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !segments.includes('..') &&
      (value.endsWith('.xcworkspace') || value.endsWith('.xcodeproj'))
    )
  },
  'container는 저장소 내부의 .xcworkspace 또는 .xcodeproj 상대 경로여야 합니다.'
)

const accessibilityIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !/[\u0000-\u001F\u007F]/.test(value),
    'identifier에는 제어 문자를 사용할 수 없습니다.'
  )

const runtimeUiActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tap'),
      identifier: accessibilityIdentifierSchema,
      timeoutSeconds: z.number().int().min(1).max(30).default(10)
    })
    .strict(),
  z
    .object({
      kind: z.literal('type-text'),
      identifier: accessibilityIdentifierSchema,
      text: z.string().min(1).max(2_000),
      timeoutSeconds: z.number().int().min(1).max(30).default(10)
    })
    .strict()
])

const runtimeFixtureSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/, 'fixture id는 영문·숫자·점·밑줄·하이픈만 사용할 수 있습니다.'),
    payload: z.record(z.string(), z.json())
  })
  .strict()

const runtimeStatePathSegmentSchema = z.union([
  z
    .string()
    .min(1)
    .max(128)
    .refine(
      (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
      'state path에는 안전하지 않은 객체 키를 사용할 수 없습니다.'
    ),
  z.number().int().min(0).max(1_000)
])

const runtimeAssertionNameSchema = z.string().trim().min(1).max(160).optional()
const runtimeStatePathSchema = z.array(runtimeStatePathSegmentSchema).min(1).max(16)

const runtimeAcceptanceAssertionSchema = z.union([
  z
    .object({
      kind: z.literal('state'),
      name: runtimeAssertionNameSchema,
      path: runtimeStatePathSchema,
      operator: z.literal('exists'),
      expected: z.boolean().default(true)
    })
    .strict(),
  z
    .object({
      kind: z.literal('state'),
      name: runtimeAssertionNameSchema,
      path: runtimeStatePathSchema,
      operator: z.enum(['equals', 'not-equals']),
      expected: z.json()
    })
    .strict(),
  z
    .object({
      kind: z.literal('accessibility'),
      name: runtimeAssertionNameSchema,
      identifier: accessibilityIdentifierSchema,
      property: z.literal('exists'),
      expected: z.boolean().default(true)
    })
    .strict(),
  z
    .object({
      kind: z.literal('accessibility'),
      name: runtimeAssertionNameSchema,
      identifier: accessibilityIdentifierSchema,
      property: z.enum(['label', 'title', 'value', 'placeholderValue', 'elementType']),
      expected: z.string().max(2_000)
    })
    .strict(),
  z
    .object({
      kind: z.literal('accessibility'),
      name: runtimeAssertionNameSchema,
      identifier: accessibilityIdentifierSchema,
      property: z.enum(['enabled', 'selected']),
      expected: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      name: runtimeAssertionNameSchema,
      target: z.enum(['screen', 'accessibility', 'state', 'ui-actions', 'fixture'])
    })
    .strict()
])

export const projectCapabilityManifestSchema = z
  .object({
    version: z.literal(1),
    adapter: z
      .object({
        kind: z.literal('ios-simulator'),
        container: relativeXcodeContainerSchema,
        scheme: z.string().trim().min(1).max(128),
        configuration: z.literal('Debug').default('Debug'),
        deviceFamily: z.enum(['ipad', 'iphone']).default('ipad')
      })
      .strict(),
    capabilities: z
      .object({
        build: z.boolean(),
        run: z.boolean(),
        observe: z.array(z.enum(['screen', 'accessibility', 'state'])).max(3),
        act: z.array(z.enum(['ui', 'fixture'])).max(2),
        verify: z.array(z.enum(['test-command', 'runtime-scenario'])).max(2)
      })
      .strict(),
    debugBridge: z
      .object({
        protocol: z.literal('file-v1'),
        responseTimeoutSeconds: z.number().int().min(1).max(30).default(10)
      })
      .strict()
      .optional(),
    runtimeScenario: z
      .object({
        actions: z.array(runtimeUiActionSchema).max(20).default([]),
        fixture: runtimeFixtureSchema.optional(),
        assertions: z.array(runtimeAcceptanceAssertionSchema).max(50).default([])
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.capabilities.run && !manifest.capabilities.build) {
      context.addIssue({ code: 'custom', path: ['capabilities', 'run'], message: 'run에는 build가 필요합니다.' })
    }
    if ((manifest.capabilities.observe.length || manifest.capabilities.act.length) && !manifest.capabilities.run) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities', 'run'],
        message: 'observe와 act에는 run이 필요합니다.'
      })
    }
    if (manifest.capabilities.verify.includes('runtime-scenario') && !manifest.capabilities.run) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities', 'verify'],
        message: 'runtime-scenario에는 run이 필요합니다.'
      })
    }
    if (
      (manifest.runtimeScenario?.actions.length ?? 0) > 0 &&
      !manifest.capabilities.act.includes('ui')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities', 'act'],
        message: 'runtimeScenario.actions를 실행하려면 act에 ui가 필요합니다.'
      })
    }
    if (manifest.runtimeScenario?.fixture && !manifest.capabilities.act.includes('fixture')) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities', 'act'],
        message: 'runtimeScenario.fixture를 적용하려면 act에 fixture가 필요합니다.'
      })
    }
    if (manifest.runtimeScenario?.fixture && !manifest.debugBridge) {
      context.addIssue({
        code: 'custom',
        path: ['debugBridge'],
        message: 'runtimeScenario.fixture를 적용하려면 debugBridge 계약이 필요합니다.'
      })
    }
    const assertions = manifest.runtimeScenario?.assertions ?? []
    if (assertions.length > 0 && !manifest.capabilities.verify.includes('runtime-scenario')) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities', 'verify'],
        message: 'runtimeScenario.assertions를 평가하려면 verify에 runtime-scenario가 필요합니다.'
      })
    }
    assertions.forEach((assertion, index) => {
      if (assertion.kind === 'state') {
        if (!manifest.capabilities.observe.includes('state')) {
          context.addIssue({
            code: 'custom',
            path: ['runtimeScenario', 'assertions', index],
            message: 'state assertion에는 observe.state가 필요합니다.'
          })
        }
        if (!manifest.debugBridge) {
          context.addIssue({
            code: 'custom',
            path: ['runtimeScenario', 'assertions', index],
            message: 'state assertion에는 debugBridge 계약이 필요합니다.'
          })
        }
      }
      if (
        assertion.kind === 'accessibility' &&
        !manifest.capabilities.observe.includes('accessibility')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['runtimeScenario', 'assertions', index],
          message: 'accessibility assertion에는 observe.accessibility가 필요합니다.'
        })
      }
      if (assertion.kind !== 'evidence') return
      const targetReady = {
        screen: manifest.capabilities.observe.includes('screen'),
        accessibility: manifest.capabilities.observe.includes('accessibility'),
        state: manifest.capabilities.observe.includes('state') && Boolean(manifest.debugBridge),
        'ui-actions':
          manifest.capabilities.act.includes('ui') &&
          (manifest.runtimeScenario?.actions.length ?? 0) > 0,
        fixture:
          manifest.capabilities.act.includes('fixture') &&
          Boolean(manifest.debugBridge) &&
          Boolean(manifest.runtimeScenario?.fixture)
      }[assertion.target]
      if (!targetReady) {
        context.addIssue({
          code: 'custom',
          path: ['runtimeScenario', 'assertions', index],
          message: `${assertion.target} evidence assertion에 필요한 Observe·Act 계약이 준비되지 않았습니다.`
        })
      }
    })
  })

export type ProjectCapabilityManifest = z.infer<typeof projectCapabilityManifestSchema>

export type ProjectCapabilityManifestReadResult =
  | { state: 'missing' }
  | { state: 'valid'; value: ProjectCapabilityManifest }
  | { state: 'invalid'; message: string }

export interface ProjectCapabilityResult {
  manifest: ProjectCapabilityManifestInspection
  capabilities: ProjectCapability[]
}

function missingCapability(
  key: ProjectCapability['key'],
  detail: string
): ProjectCapability {
  return { key, status: 'missing', detail }
}

function manifestErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0]
    const location = issue.path.length ? issue.path.join('.') : 'manifest'
    return `${location}: ${issue.message}`
  }
  if (error instanceof SyntaxError) return 'JSON 문법이 올바르지 않습니다.'
  return error instanceof Error ? error.message : String(error)
}

export async function readProjectCapabilityManifest(
  projectPath: string
): Promise<ProjectCapabilityManifestReadResult> {
  const manifestPath = join(projectPath, PROJECT_CAPABILITY_MANIFEST_PATH)
  try {
    const stats = await lstat(manifestPath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { state: 'invalid', message: 'manifest는 심볼릭 링크가 아닌 일반 파일이어야 합니다.' }
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      return { state: 'invalid', message: 'manifest 크기는 64KB를 넘을 수 없습니다.' }
    }
    const source = await readFile(manifestPath, 'utf8')
    return { state: 'valid', value: projectCapabilityManifestSchema.parse(JSON.parse(source)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', message: manifestErrorMessage(error) }
  }
}

function declaredCapability(
  key: ProjectCapability['key'],
  detail: string
): ProjectCapability {
  return { key, status: 'declared', detail: `${detail} · 실행 어댑터 연결 예정` }
}

function readyCapability(
  key: ProjectCapability['key'],
  detail: string
): ProjectCapability {
  return { key, status: 'ready', detail }
}

export async function inspectProjectCapabilities(
  project: ProjectRecord,
  trackedFileCount: number
): Promise<ProjectCapabilityResult> {
  const result = await readProjectCapabilityManifest(project.path)
  const code: ProjectCapability = {
    key: 'code',
    status: 'ready',
    detail: `Git 추적 파일 ${trackedFileCount.toLocaleString('ko-KR')}개에 접근 가능`
  }
  const verifyFromCommand: ProjectCapability | null = project.testCommand.trim()
    ? { key: 'verify', status: 'ready', detail: `검증 명령: ${project.testCommand.trim()}` }
    : null

  if (result.state === 'missing') {
    return {
      manifest: {
        path: PROJECT_CAPABILITY_MANIFEST_PATH,
        state: 'missing',
        adapterKind: null,
        message: 'manifest가 없어 기존 코드 작업 모드로 동작합니다.'
      },
      capabilities: [
        code,
        missingCapability('build', '프로젝트 계약에 빌드 방식이 없습니다.'),
        missingCapability('run', '프로젝트 계약에 앱 실행 방식이 없습니다.'),
        missingCapability('observe', '화면·접근성·상태 관찰이 선언되지 않았습니다.'),
        missingCapability('act', 'UI·fixture 조작이 선언되지 않았습니다.'),
        verifyFromCommand ?? missingCapability('verify', '프로젝트 검증 명령이 설정되지 않았습니다.')
      ]
    }
  }

  if (result.state === 'invalid') {
    const invalidDetail = 'manifest 오류를 수정한 뒤 다시 검사하세요.'
    return {
      manifest: {
        path: PROJECT_CAPABILITY_MANIFEST_PATH,
        state: 'invalid',
        adapterKind: null,
        message: result.message
      },
      capabilities: [
        code,
        missingCapability('build', invalidDetail),
        missingCapability('run', invalidDetail),
        missingCapability('observe', invalidDetail),
        missingCapability('act', invalidDetail),
        verifyFromCommand ?? missingCapability('verify', invalidDetail)
      ]
    }
  }

  const { adapter, capabilities } = result.value
  const deviceFamilyLabel = adapter.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'
  const observeLabels = { screen: '화면', accessibility: '접근성', state: '앱 상태' } as const
  const actLabels = { ui: 'UI', fixture: 'fixture' } as const
  const verifyLabels = { 'test-command': '검증 명령', 'runtime-scenario': '실행 시나리오' } as const
  const readyObserveLabels = [
    capabilities.observe.includes('screen') ? 'Simulator 화면 캡처' : '',
    capabilities.observe.includes('accessibility') ? 'XCTest 접근성 트리 수집' : '',
    capabilities.observe.includes('state') && result.value.debugBridge
      ? 'Debug bridge 앱 상태 수집'
      : ''
  ].filter(Boolean)
  const declaredObserveLabels = capabilities.observe
    .filter((item) => !['screen', 'accessibility'].includes(item) && !(item === 'state' && result.value.debugBridge))
    .map((item) => observeLabels[item])
  const uiActionCount = capabilities.act.includes('ui')
    ? result.value.runtimeScenario?.actions.length ?? 0
    : 0
  const fixtureReady = Boolean(
    capabilities.act.includes('fixture') &&
    result.value.debugBridge &&
    result.value.runtimeScenario?.fixture
  )
  const readyActLabels = [
    uiActionCount > 0
      ? `accessibility identifier UI 조작 ${uiActionCount.toLocaleString('ko-KR')}단계`
      : '',
    fixtureReady ? `Debug fixture ${result.value.runtimeScenario?.fixture?.id} 적용` : ''
  ].filter(Boolean)
  const declaredActLabels = capabilities.act
    .filter((item) => (item === 'fixture' && !fixtureReady) || (item === 'ui' && uiActionCount === 0))
    .map((item) => actLabels[item])
  const runtimeAssertionCount = capabilities.verify.includes('runtime-scenario')
    ? result.value.runtimeScenario?.assertions.length ?? 0
    : 0
  const readyVerifyLabels = [
    verifyFromCommand?.detail ?? '',
    runtimeAssertionCount > 0
      ? `runtime acceptance ${runtimeAssertionCount.toLocaleString('ko-KR')}개`
      : ''
  ].filter(Boolean)
  const declaredVerifyLabels = capabilities.verify
    .filter((item) => item === 'runtime-scenario' && runtimeAssertionCount === 0)
    .map((item) => verifyLabels[item])

  return {
    manifest: {
      path: PROJECT_CAPABILITY_MANIFEST_PATH,
      state: 'valid',
      adapterKind: adapter.kind,
      message: `${adapter.container} · ${adapter.scheme} · ${adapter.configuration} · ${deviceFamilyLabel}`
    },
    capabilities: [
      code,
      capabilities.build
        ? readyCapability('build', `${adapter.scheme} Debug 빌드 adapter 사용 가능`)
        : missingCapability('build', 'build가 비활성화되어 있습니다.'),
      capabilities.run
        ? readyCapability('run', `${deviceFamilyLabel} Simulator 실행 adapter 사용 가능`)
        : missingCapability('run', 'run이 비활성화되어 있습니다.'),
      readyObserveLabels.length
        ? readyCapability(
            'observe',
            [
              `${readyObserveLabels.join(' · ')} 사용 가능`,
              declaredObserveLabels.join(' · '),
              declaredObserveLabels.length ? '연결 예정' : ''
            ].filter(Boolean).join(' · ')
          )
        : capabilities.observe.length
          ? declaredCapability('observe', `${capabilities.observe.map((item) => observeLabels[item]).join(' · ')} 관찰 계약 선언`)
        : missingCapability('observe', '관찰 채널이 선언되지 않았습니다.'),
      readyActLabels.length > 0
        ? readyCapability(
            'act',
            [
              `${readyActLabels.join(' · ')} 사용 가능`,
              declaredActLabels.join(' · '),
              declaredActLabels.length ? '연결 예정' : ''
            ].filter(Boolean).join(' · ')
          )
        : capabilities.act.length
          ? declaredCapability('act', `${capabilities.act.map((item) => actLabels[item]).join(' · ')} 조작 계약 선언`)
        : missingCapability('act', '조작 채널이 선언되지 않았습니다.'),
      readyVerifyLabels.length > 0
        ? readyCapability(
            'verify',
            [
              readyVerifyLabels.join(' · '),
              declaredVerifyLabels.join(' · '),
              declaredVerifyLabels.length ? 'assertion 미설정' : ''
            ].filter(Boolean).join(' · ')
          )
        : capabilities.verify.length
          ? declaredCapability('verify', `${capabilities.verify.map((item) => verifyLabels[item]).join(' · ')} 계약 선언`)
          : missingCapability('verify', '검증 명령과 실행 시나리오가 없습니다.')
    ]
  }
}
