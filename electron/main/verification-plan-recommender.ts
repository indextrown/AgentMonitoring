import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type {
  ProjectRuntimeConfigSource,
  TaskTechSpecDraft,
  VerificationPlanRecommendation
} from '../../src/shared/types'
import { buildCodexEnvironment, CODEX_AUTH_ARGUMENTS } from './codex-auth'
import { readCodexStructuredOutput } from './codex-structured-output'

const execFileAsync = promisify(execFile)
const RECOMMENDATION_TIMEOUT_MS = 3 * 60_000

const recommendationSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  mode: z.enum(['project-tests', 'simulator-runtime', 'both', 'manual-review']),
  testDesign: z.enum(['automatic', 'swift-testing', 'xctest', 'existing-tests', 'skip']),
  runtimeSource: z.enum(['task-scenario', 'project-default', 'off'])
}).strict()

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'mode', 'testDesign', 'runtimeSource'],
  properties: {
    summary: { type: 'string' },
    mode: {
      type: 'string',
      enum: ['project-tests', 'simulator-runtime', 'both', 'manual-review']
    },
    testDesign: {
      type: 'string',
      enum: ['automatic', 'swift-testing', 'xctest', 'existing-tests', 'skip']
    },
    runtimeSource: {
      type: 'string',
      enum: ['task-scenario', 'project-default', 'off']
    }
  }
} as const

export class VerificationPlanRecommender {
  constructor(
    private readonly codexCommand = 'codex',
    private readonly codexHome?: string
  ) {}

  async recommend(input: {
    projectPath: string
    title: string
    prompt: string
    techSpec?: TaskTechSpecDraft | null
    testCommand: string
    runtimeAvailable: boolean
    runtimeConfigSource: ProjectRuntimeConfigSource | null
  }): Promise<VerificationPlanRecommendation> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-monitoring-verification-'))
    const schemaPath = join(temporaryDirectory, 'schema.json')
    const outputPath = join(temporaryDirectory, 'recommendation.json')
    try {
      await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA), { encoding: 'utf8', mode: 0o600 })
      const instructions = [
        '당신은 소프트웨어 작업의 검증 계획을 추천하는 읽기 전용 분석가입니다.',
        `작업 제목: ${input.title}`,
        `작업 목표와 완료 조건:\n${input.prompt}`,
        input.techSpec
          ? `사람이 승인한 테크스펙 revision ${input.techSpec.revision}:\n${input.techSpec.markdown}`
          : '이 작업에는 별도로 승인된 테크스펙이 없습니다.',
        `프로젝트 검증 명령: ${input.testCommand.trim() || '미설정'}`,
        `iOS Simulator 연결: ${input.runtimeAvailable ? '사용 가능' : '사용 불가'}`,
        `Simulator 설정 출처: ${input.runtimeConfigSource ?? '없음'}`,
        '저장소의 언어, 테스트 프레임워크와 작업 영향을 읽기 전용으로 살펴본 뒤 JSON으로만 추천하세요.',
        '순수 로직·데이터·회귀 작업은 project-tests, 실제 화면·상호작용만 중요한 작업은 simulator-runtime, 둘 다 필요하면 both를 선택하세요.',
        '문서·설정처럼 자동 실행으로 의미 있게 검증하기 어려운 작업만 manual-review를 선택하세요.',
        'Swift Testing을 사용하는 단위 테스트에는 swift-testing, XCTest 기반 테스트에는 xctest, 새 테스트가 필요 없으면 existing-tests를 선택하세요.',
        'project-tests 또는 both를 선택할 때 프로젝트 검증 명령이 없으면 안 됩니다.',
        'simulator-runtime 또는 both는 Simulator 연결이 있을 때만 선택하세요.',
        'runtimeSource는 새 작업의 동작에 맞춘 시나리오가 필요하면 task-scenario, 저장소의 .agentmonitor/project.json 시나리오를 그대로 쓰면 project-default, runtime을 쓰지 않으면 off입니다.',
        'summary에는 왜 이 검증 조합이 적합한지 사용자가 이해하기 쉬운 한국어 한두 문장으로 적으세요.',
        '코드를 수정하지 마세요.'
      ].join('\n\n')
      const { stdout } = await execFileAsync(
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
          timeout: RECOMMENDATION_TIMEOUT_MS
        }
      )
      const recommendation = recommendationSchema.parse(
        await readCodexStructuredOutput(outputPath, stdout, '검증 계획')
      )
      const testsAvailable = Boolean(input.testCommand.trim())
      let mode = recommendation.mode
      if (mode === 'both' && !testsAvailable) mode = input.runtimeAvailable ? 'simulator-runtime' : 'manual-review'
      if (mode === 'both' && !input.runtimeAvailable) mode = testsAvailable ? 'project-tests' : 'manual-review'
      if (mode === 'project-tests' && !testsAvailable) mode = input.runtimeAvailable ? 'simulator-runtime' : 'manual-review'
      if (mode === 'simulator-runtime' && !input.runtimeAvailable) mode = testsAvailable ? 'project-tests' : 'manual-review'
      const usesTests = mode === 'project-tests' || mode === 'both'
      const usesRuntime = mode === 'simulator-runtime' || mode === 'both'
      const runtimeSource = usesRuntime
        ? recommendation.runtimeSource === 'project-default' && input.runtimeConfigSource === 'manifest'
          ? 'project-default'
          : 'task-scenario'
        : 'off'
      return {
        summary: recommendation.summary,
        plan: {
          version: 1,
          mode,
          testDesign: usesTests ? recommendation.testDesign : 'skip',
          runtimeSource
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error('검증 계획 추천이 3분 안에 끝나지 않았습니다.')
      }
      throw new Error(`검증 계획을 추천하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
