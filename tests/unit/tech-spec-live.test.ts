import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAuthManager, resolveCodexCommand } from '../../electron/main/codex-auth'
import { TechSpecGenerator } from '../../electron/main/tech-spec-generator'
import type { GeneratedTechSpec, TechSpecProgress } from '../../src/shared/types'

// Opt-in only: uses an existing IDE login and consumes two model turns, never logs auth values or source bodies.
it.skipIf(!process.env.AGENT_MONITORING_LIVE_CODEX_HOME)('live Codex generates and refines a spec in one read-only planning conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentmonitor-live-planning-'))
  const command = await resolveCodexCommand()
  const codexHome = process.env.AGENT_MONITORING_LIVE_CODEX_HOME!
  const auth = new CodexAuthManager(codexHome, () => undefined, command)
  const generator = new TechSpecGenerator(command, codexHome)
  try {
    const exec = promisify(execFile)
    const git = (...args: string[]) => exec('git', args, { cwd: directory })
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Planning smoke')
    await git('config', 'user.email', 'smoke@example.invalid')
    await writeFile(join(directory, 'counter.ts'), 'export const increment = (count: number) => count + 1\n')
    await git('add', 'counter.ts')
    await git('commit', '-m', 'fixture')
    expect((await auth.status()).state).toBe('signed_in')
    const catalog = await auth.models()
    const selected = catalog.models.find((model) => model.id === catalog.defaultModelId)!
    const progress: TechSpecProgress[] = []
    const input = {
      projectPath: directory, draftKey: 'live-smoke', requestId: 'live-first', title: '카운터 초기화 함수 설계',
      prompt: '기존 increment 함수와 함께 사용할 reset 함수를 설계해 주세요. 숫자 0을 반환하고 기존 함수를 바꾸지 않습니다. 아주 작은 저장소이므로 관련 파일 하나만 확인하고 간결하게 작성하세요.',
      model: { model: selected.id, reasoningEffort: selected.defaultReasoningEffort },
      onProgress: (event: TechSpecProgress) => { progress.push(event) }
    }
    const started = Date.now()
    const first = await generator.generate(input)
    const firstMs = Date.now() - started
    expect(first.markdown.length).toBeGreaterThanOrEqual(100)
    const nextStarted = Date.now()
    const refined = await generator.refine({ ...input, requestId: 'live-refine', current: {
      ...first, markdown: first.markdown + '\n\n사용자 결정: reset 함수는 매개변수를 받지 않습니다.'
    }, feedback: '직접 추가한 매개변수 없음 결정을 유지하고, 반환값이 0인지 확인하는 테스트 기준을 보완해줘.' })
    expect(refined.revision).toBe(2)
    expect(progress.some((event) => event.requestId === 'live-refine' && event.reusedConversation && event.reusedRepository)).toBe(true)
    expect(progress.some((event) => event.preview.length > 0)).toBe(true)
    expect((await git('status', '--porcelain')).stdout).toBe('')
    console.log(JSON.stringify({ model: selected.id, effort: selected.defaultReasoningEffort, firstMs, refineMs: Date.now() - nextStarted, progressEvents: progress.length, readOnly: true }))
  } finally {
    await generator.dispose()
    await auth.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 420_000)

// Explicit opt-in for a real, larger repository. No source or generated Markdown is printed.
it.skipIf(!process.env.AGENT_MONITORING_LIVE_CODEX_HOME || !process.env.AGENT_MONITORING_LIVE_PLANNING_PROJECT)('live repository planning returns a spec and targeted refinement without editing the project', async () => {
  const projectPath = process.env.AGENT_MONITORING_LIVE_PLANNING_PROJECT!
  const command = await resolveCodexCommand()
  const codexHome = process.env.AGENT_MONITORING_LIVE_CODEX_HOME!
  const auth = new CodexAuthManager(codexHome, () => undefined, command)
  const generator = new TechSpecGenerator(command, codexHome)
  const exec = promisify(execFile)
  const git = (...args: string[]) => exec('git', args, { cwd: projectPath, maxBuffer: 16_000_000 })
  const fingerprint = async () => createHash('sha256').update((await git('status', '--porcelain', '-z')).stdout)
    .update((await git('diff', '--binary', 'HEAD')).stdout).digest('hex')
  const before = await fingerprint()
  try {
    expect((await auth.status()).state).toBe('signed_in')
    const catalog = await auth.models()
    const selected = catalog.models.find((model) => model.id === catalog.defaultModelId)!
    const input = {
      projectPath, draftKey: 'live-repository', requestId: 'live-repository-first', title: '내 위치 버튼 구현',
      prompt: 'MapKit과 Mapbox 화면을 각각 MVVM으로 구성합니다. MapKit은 Swift Concurrency, Mapbox는 RxSwift 기반 ViewModel을 사용하며 기능은 동일합니다. 화면을 열면 최초 한 번 내 위치로 이동하고, 오른쪽 아래 원형 버튼을 누르면 다시 내 위치로 이동합니다. 로딩 중에는 버튼을 비활성화하고 위치 권한 거부와 위치 조회 실패를 사용자에게 안내합니다. 현재 코드에서 이미 구현한 내용과 추가로 필요한 내용을 구분해서 계획해 주세요.',
      model: { model: selected.id, reasoningEffort: selected.defaultReasoningEffort }
    }
    let first: GeneratedTechSpec | undefined
    for (const phase of ['first', 'refine'] as const) {
      const start = Date.now()
      let firstPreviewMs: number | null = null
      let latest: TechSpecProgress | undefined
      let previousStage = ''
      const onProgress = (event: TechSpecProgress) => {
        latest = event
        if (firstPreviewMs === null && event.preview) firstPreviewMs = Date.now() - start
        if (event.stage !== previousStage) {
          previousStage = event.stage
          console.log(JSON.stringify({ phase, stage: event.stage, elapsedMs: Date.now() - start }))
        }
      }
      const result = phase === 'first' ? await generator.generate({ ...input, onProgress }) : await generator.refine({
        ...input, requestId: 'live-repository-refine', onProgress, current: first!,
        feedback: '기존 요구사항을 유지하고, 메인 스레드 경고를 확인할 검증 기준을 더 명확하게 해 주세요. 코드 변경이나 테스트 실행은 하지 마세요.'
      })
      expect(result.markdown.length).toBeGreaterThanOrEqual(100)
      expect(result.revision).toBe(phase === 'first' ? 1 : 2)
      if (phase === 'first') first = result
      else expect(latest?.reusedConversation && latest?.reusedRepository).toBe(true)
      console.log(JSON.stringify({ phase, durationMs: Date.now() - start, firstPreviewMs, toolCalls: latest?.toolCalls,
        draftingRequested: latest?.draftingRequested, model: selected.id, effort: selected.defaultReasoningEffort }))
    }
  } finally {
    await generator.dispose()
    await auth.dispose()
    expect(await fingerprint()).toBe(before)
  }
}, 420_000)
