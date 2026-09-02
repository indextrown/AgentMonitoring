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

const projectCapabilityManifestSchema = z
  .object({
    version: z.literal(1),
    adapter: z
      .object({
        kind: z.literal('ios-simulator'),
        container: relativeXcodeContainerSchema,
        scheme: z.string().trim().min(1).max(128),
        configuration: z.literal('Debug').default('Debug')
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
      .strict()
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
  })

type ProjectCapabilityManifest = z.infer<typeof projectCapabilityManifestSchema>

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

async function readManifest(projectPath: string): Promise<
  | { state: 'missing' }
  | { state: 'valid'; value: ProjectCapabilityManifest }
  | { state: 'invalid'; message: string }
> {
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

export async function inspectProjectCapabilities(
  project: ProjectRecord,
  trackedFileCount: number
): Promise<ProjectCapabilityResult> {
  const result = await readManifest(project.path)
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
  const observeLabels = { screen: '화면', accessibility: '접근성', state: '앱 상태' } as const
  const actLabels = { ui: 'UI', fixture: 'fixture' } as const
  const verifyLabels = { 'test-command': '검증 명령', 'runtime-scenario': '실행 시나리오' } as const

  return {
    manifest: {
      path: PROJECT_CAPABILITY_MANIFEST_PATH,
      state: 'valid',
      adapterKind: adapter.kind,
      message: `${adapter.container} · ${adapter.scheme} · ${adapter.configuration}`
    },
    capabilities: [
      code,
      capabilities.build
        ? declaredCapability('build', `${adapter.scheme} Debug 빌드 계약 선언`)
        : missingCapability('build', 'build가 비활성화되어 있습니다.'),
      capabilities.run
        ? declaredCapability('run', 'iOS Simulator 실행 계약 선언')
        : missingCapability('run', 'run이 비활성화되어 있습니다.'),
      capabilities.observe.length
        ? declaredCapability('observe', `${capabilities.observe.map((item) => observeLabels[item]).join(' · ')} 관찰 계약 선언`)
        : missingCapability('observe', '관찰 채널이 선언되지 않았습니다.'),
      capabilities.act.length
        ? declaredCapability('act', `${capabilities.act.map((item) => actLabels[item]).join(' · ')} 조작 계약 선언`)
        : missingCapability('act', '조작 채널이 선언되지 않았습니다.'),
      verifyFromCommand ??
        (capabilities.verify.length
          ? declaredCapability('verify', `${capabilities.verify.map((item) => verifyLabels[item]).join(' · ')} 계약 선언`)
          : missingCapability('verify', '검증 명령과 실행 시나리오가 없습니다.'))
    ]
  }
}
