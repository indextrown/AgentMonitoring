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
    await expect(service.run({ ...input, instructions: '[[slow]]', requirements: 'timeout', outputSchema: {} })).rejects.toThrow('3분')
    expect((await calls()).some((call) => call.method === 'turn/interrupt')).toBe(true)
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
