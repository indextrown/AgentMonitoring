import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { TechSpecGenerator } from '../../electron/main/tech-spec-generator'
import { TechSpecConversations, markdownPreview } from '../../electron/main/tech-spec-conversation'
import { PlanningRepositoryContext } from '../../electron/main/planning-repository-context'
import type { TechSpecProgress } from '../../src/shared/types'
import { PlanningDiagnostics } from '../../electron/main/planning-diagnostics'

const exec = promisify(execFile)
const directories: string[] = []
const generators: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(generators.splice(0).map((value) => value.dispose()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'planning-conversation-test-'))
  directories.push(directory)
  const projectPath = join(directory, 'repo')
  const codexHome = join(directory, 'codex')
  await mkdir(projectPath)
  await mkdir(codexHome)
  const command = join(directory, 'codex.mjs')
  await copyFile(resolve('tests/fixtures/planning-codex.mjs'), command)
  await chmod(command, 0o755)
  const git = (...args: string[]) => exec('git', args, { cwd: projectPath })
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(projectPath, 'Feature.swift'), 'struct Feature {}')
  await git('add', '.')
  await git('commit', '-m', 'fixture')
  const generator = new TechSpecGenerator(command, codexHome)
  generators.push(generator)
  const input = { draftKey: 'draft-a', requestId: 'request-a', projectPath, title: '기능 설계', prompt: '기능을 구현하기 전에 검증 기준을 정리해 주세요.', model: { model: 'fixture-model', reasoningEffort: 'low' as const } }
  const calls = async () => (await readFile(join(codexHome, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  return { generator, input, projectPath, calls, git, codexHome, command }
}

describe('technical spec planning conversations', () => {
  it('streams a draft and reuses the same read-only thread with manual edits and feedback', async () => {
    const { generator, input, calls } = await fixture()
    const events: TechSpecProgress[] = []
    const first = await generator.generate({ ...input, onProgress: (event) => events.push(event) })
    expect(events.some((event) => event.preview.includes('요구사항'))).toBe(true)
    expect(events.some((event) => event.message.includes('Feature.swift'))).toBe(true)
    const refined = await generator.refine({ ...input, requestId: 'request-b', current: { ...first, markdown: first.markdown + '\n직접 편집: 최대 세 번 재시도' }, feedback: '권한 거부도 추가해줘', onProgress: (event) => events.push(event) })
    expect(refined.revision).toBe(2)
    const records = await calls()
    expect(records.filter((call) => call.method === 'thread/start')).toHaveLength(1)
    const turns = records.filter((call) => call.method === 'turn/start')
    expect(turns).toHaveLength(2)
    expect(turns[0].params.threadId).toBe(turns[1].params.threadId)
    expect(turns[1].params.input[0].text).toContain('직접 편집: 최대 세 번 재시도')
    expect(turns[1].params.input[0].text).toContain('권한 거부도 추가해줘')
    expect(turns[1].params.input[0].text).toContain('저장소 변경이 감지되지 않았습니다')
    expect(turns.every((turn) => turn.params.approvalPolicy === 'never' && turn.params.sandboxPolicy.type === 'readOnly')).toBe(true)
    expect(turns[1].params.model).toBe('fixture-model')
    expect(events.some((event) => event.reusedConversation && event.reusedRepository)).toBe(true)
  })

  it('isolates drafts and starts a new conversation after release', async () => {
    const { generator, input, calls } = await fixture()
    await generator.generate(input)
    await generator.generate({ ...input, draftKey: 'draft-b' })
    await generator.release(input.draftKey)
    await generator.generate(input)
    expect((await calls()).filter((call) => call.method === 'thread/start')).toHaveLength(3)
  })

  it('resumes a persisted thread after its idle connection closes and applies a new turn model', async () => {
    const { input, command, codexHome, calls, projectPath } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 5_000, 20)
    generators.push(service)
    const request = { ...input, instructions: '계획 초안', requirements: '기능 설계', outputSchema: {} }
    await service.run(request)
    await new Promise((resolve) => setTimeout(resolve, 80))
    await writeFile(join(projectPath, 'Feature.swift'), 'struct UpdatedFeature {}')
    await service.run({ ...request, requestId: 'request-b', model: { model: 'second-model', reasoningEffort: 'medium' } })
    const records = await calls()
    expect(records.filter((call) => call.method === 'thread/start')).toHaveLength(1)
    expect(records.filter((call) => call.method === 'thread/resume')).toHaveLength(1)
    const turn = records.filter((call) => call.method === 'turn/start').at(-1)
    expect(turn.params.model).toBe('second-model')
    expect(turn.params.effort).toBe('medium')
    expect(turn.params.input[0].text).not.toContain('저장소 변경이 감지되지 않았습니다')
  })

  it('disposes active and idle drafts, then starts a fresh conversation', async () => {
    const { generator, input, calls } = await fixture()
    await generator.generate(input)
    const active = generator.generate({ ...input, draftKey: 'busy', prompt: '[[slow]]' })
    const rejected = expect(active).rejects.toThrow('계획 대화를 종료했습니다')
    await expect.poll(async () => (await calls()).filter((call) => call.method === 'turn/start').length).toBe(2)
    await generator.dispose()
    await rejected
    await generator.generate(input)
    const records = await calls()
    expect(records.filter((call) => call.method === 'thread/start')).toHaveLength(3)
    expect(records.some((call) => call.method === 'turn/interrupt')).toBe(true)
    expect(records.some((call) => call.method === 'thread/archive')).toBe(true)
  })

  it('interrupts cancellation, rejects duplicate work, and resumes without automatically retrying', async () => {
    const { generator, input, calls } = await fixture()
    const controller = new AbortController()
    const pending = generator.generate({ ...input, prompt: '[[slow]]', signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('사용자 취소')
    await expect.poll(async () => (await calls().catch(() => [])).some((call) => call.method === 'turn/start')).toBe(true)
    await expect(generator.generate(input)).rejects.toThrow('이미 진행 중')
    controller.abort(new Error('사용자 취소'))
    await rejected
    let records = await calls()
    expect(records.filter((call) => call.method === 'turn/start')).toHaveLength(1)
    expect(records.some((call) => call.method === 'turn/interrupt')).toBe(true)
    await generator.generate(input)
    records = await calls()
    expect(records.some((call) => call.method === 'thread/resume')).toBe(true)
    expect(records.filter((call) => call.method === 'thread/start')).toHaveLength(1)
  })

  it.each(['[[bad-json]]', '[[empty]]', '[[disconnect]]'])('rejects %s without silently regenerating', async (prompt) => {
    const { generator, input, calls } = await fixture()
    await expect(generator.generate({ ...input, prompt })).rejects.toThrow()
    expect((await calls()).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  })

  it('times out a hung turn and leaves no active request', async () => {
    const { input, command, codexHome, calls } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 1_500)
    generators.push(service)
    await expect(service.run({ ...input, instructions: '[[slow]]', requirements: 'timeout', outputSchema: {} })).rejects.toThrow('전체 제한')
    expect((await calls()).some((call) => call.method === 'turn/interrupt')).toBe(true)
  })

  it.each(['[[research]]', '[[delay-research]]'])('requests an early draft once in the same turn for %s', async (instructions) => {
    const { input, command, codexHome, calls } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 3_000, 60_000, { researchMs: 80 })
    generators.push(service)
    const events: TechSpecProgress[] = []
    const result = await service.run({ ...input, instructions, requirements: 'Feature', outputSchema: {}, onProgress: (p) => events.push(p) })
    expect(JSON.parse(result).markdown).toContain('목표')
    const records = await calls()
    expect(records.filter((call) => call.method === 'turn/start')).toHaveLength(1)
    const steers = records.filter((call) => call.method === 'turn/steer')
    expect(steers).toHaveLength(1)
    expect(steers[0].params.expectedTurnId).toBe('turn-1')
    expect(steers[0].params.input[0].text).toContain('요구사항을 삭제하지 마세요')
    expect(events.some((p) => p.draftingRequested)).toBe(true)
  })

  it('distinguishes an inactive provider from a wall timeout and interrupts it', async () => {
    const { input, command, codexHome, calls } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 3_000, 60_000, { researchMs: 40, inactiveMs: 100 })
    generators.push(service)
    await expect(service.run({ ...input, instructions: '[[slow]]', requirements: '', outputSchema: {} })).rejects.toMatchObject({ category: 'inactive' })
    const records = await calls()
    expect(records.filter((call) => call.method === 'turn/start')).toHaveLength(1)
    expect(records.some((call) => call.method === 'turn/interrupt')).toBe(true)
  })

  it('keeps the wall deadline despite continuous reasoning and never exposes reasoning', async () => {
    const { input, command, codexHome } = await fixture()
    const events: TechSpecProgress[] = []
    const service = new TechSpecConversations(command, codexHome, 1_000, 60_000, { researchMs: 30, inactiveMs: 100 })
    generators.push(service)
    await expect(service.run({ ...input, instructions: '[[heartbeat]]', requirements: '', outputSchema: {}, onProgress: (p) => events.push(p) })).rejects.toMatchObject({ category: 'timeout' })
    expect(JSON.stringify(events)).not.toContain('PRIVATE REASONING')
    expect(events.at(-1)!.updatedAt).toBeGreaterThan(events[0].updatedAt)
  })

  it('does not steer while Markdown is already streaming', async () => {
    const { input, command, codexHome, calls } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 1_000, 60_000, { researchMs: 30 })
    generators.push(service)
    await expect(service.run({ ...input, instructions: '[[writing]]', requirements: '', outputSchema: {} })).rejects.toThrow('전체 제한')
    expect((await calls()).some((call) => call.method === 'turn/steer')).toBe(false)
  })

  it('does not queue another answer when research finished but visible Markdown has not arrived', async () => {
    const { input, command, codexHome, calls } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 3_000, 60_000, { researchMs: 30 })
    generators.push(service)
    const result = await service.run({ ...input, instructions: '[[completed-research]]', requirements: '', outputSchema: {} })
    expect(JSON.parse(result).markdown).toContain('목표')
    expect((await calls()).some((call) => call.method === 'turn/steer')).toBe(false)
  })

  it('reports rejected steering without a duplicate AI turn or unhandled rejection', async () => {
    const { input, command, codexHome, calls } = await fixture()
    const service = new TechSpecConversations(command, codexHome, 1_000, 60_000, { researchMs: 30 })
    generators.push(service)
    const events: TechSpecProgress[] = []
    await expect(service.run({ ...input, instructions: '[[steer-error]]', requirements: '', outputSchema: {}, onProgress: (p) => events.push(p) })).rejects.toThrow('전체 제한')
    expect(events.some((p) => p.message.includes('전달하지 못했습니다'))).toBe(true)
    expect((await calls()).filter((call) => call.method === 'turn/start')).toHaveLength(1)
  })

  it('records valid and invalid generation outcomes without requirements, paths or response bodies', async () => {
    const { generator, input, codexHome } = await fixture()
    await generator.generate({ ...input, prompt: 'PRIVATE REQUIREMENT' })
    await expect(generator.generate({ ...input, prompt: '[[bad-json]] PRIVATE REQUIREMENT' })).rejects.toThrow('요청 ID')
    const content = await readFile(join(codexHome, '..', 'planning-diagnostics', 'tech-spec.jsonl'), 'utf8')
    const records = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(records.map((record) => record.outcome)).toEqual(['completed', 'invalid-output'])
    expect(records[0].toolCalls).toBe(1)
    expect(records[1].stage).toBe('validating')
    expect(content).not.toContain('PRIVATE')
    expect(content).not.toContain(input.projectPath)
    expect(content).not.toContain('요구사항과 기존 구조')
  })

  it('retains only the latest 50 diagnostic records and ignores extra payload fields', async () => {
    const { codexHome } = await fixture()
    const diagnostics = new PlanningDiagnostics(codexHome)
    await Promise.all(Array.from({ length: 55 }, (_, i) => diagnostics.record({
      requestId: `request-${i}`, startedAt: i, durationMs: 100, stage: 'writing', outcome: 'completed', toolCalls: 2,
      draftingRequested: true, firstPreviewMs: 50, reusedConversation: false, reusedRepository: false,
      ...{ prompt: 'PRIVATE PROMPT', preview: 'PRIVATE BODY' }
    })))
    const content = await readFile(join(codexHome, 'tech-spec.jsonl'), 'utf8')
    const records = content.trim().split('\n').map((line) => JSON.parse(line))
    expect(records).toHaveLength(50)
    expect(records[0].requestId).toBe('request-5')
    expect(content).not.toContain('PRIVATE')
  })

  it('invalidates cached metadata on edits, additions, staged changes, branch switches and commits', async () => {
    const { projectPath, git } = await fixture()
    const cache = new PlanningRepositoryContext()
    const first = await cache.inspect(projectPath)
    expect((await cache.inspect(projectPath)).reused).toBe(true)
    await writeFile(join(projectPath, 'Feature.swift'), 'struct Feature { var a = 1 }')
    expect((await cache.inspect(projectPath)).fingerprint).not.toBe(first.fingerprint)
    const dirty = await cache.inspect(projectPath)
    await writeFile(join(projectPath, 'Feature.swift'), 'struct Feature { var a = 2 }')
    expect((await cache.inspect(projectPath)).fingerprint).not.toBe(dirty.fingerprint)
    await writeFile(join(projectPath, 'New.swift'), 'new')
    await writeFile(join(projectPath, 'Secrets.xcconfig'), 'FIXTURE_ONLY = value')
    const added = await cache.inspect(projectPath)
    expect(added.files).toContain('New.swift')
    expect(added.files).not.toContain('Secrets.xcconfig')
    await git('add', 'Feature.swift')
    expect((await cache.inspect(projectPath)).fingerprint).not.toBe(added.fingerprint)
    await git('commit', '-m', 'updated')
    expect((await cache.inspect(projectPath)).head).not.toBe(first.head)
    await git('switch', '-c', 'feature')
    expect((await cache.inspect(projectPath)).branch).toBe('feature')
    await rm(join(projectPath, 'New.swift'))
    expect((await cache.inspect(projectPath)).files).not.toContain('New.swift')
  })

  it('decodes only a complete visible JSON string prefix', () => {
    expect(markdownPreview('{"markdown":"# 제목\\n문장')).toBe('# 제목\n문장')
    expect(markdownPreview('{"markdown":"text\\u12')).toBe('text')
    expect(markdownPreview('{"summary":"not a draft"}')).toBe('')
  })
})
