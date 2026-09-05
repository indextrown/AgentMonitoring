import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAuthManager, resolveCodexCommand } from '../../electron/main/codex-auth'
import { TechSpecGenerator } from '../../electron/main/tech-spec-generator'
import type { TechSpecProgress } from '../../src/shared/types'

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
