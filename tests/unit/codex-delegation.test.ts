import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexDelegationTracker, readCodexSessionEvidence } from '../../electron/main/codex-delegation'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const rootId = '01a071bc-2835-7201-827f-f0ad59ac82f5'
const childId = '01a071bc-3f88-7b31-9b73-fae0091d959e'
const activity = (kind: string, id = childId) => ({
  type: 'event_msg',
  payload: { type: 'item_completed', thread_id: rootId, item: {
    type: 'SubAgentActivity', kind, agent_thread_id: id, agent_path: '/root/worker'
  } }
})
const completion = (message: string) => ({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } })

async function writeSession(home: string, id: string, events: unknown[]): Promise<string> {
  const day = new Date(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).replaceAll('-', '/')
  const directory = join(home, 'sessions', day)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `rollout-test-${id}.jsonl`)
  await writeFile(path, [{ type: 'session_meta', payload: { id } }, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n')
  return path
}

async function fixture(childEvents: unknown[] = [completion('CHILD_RESULT')]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-monitoring-delegation-'))
  temporaryDirectories.push(home)
  await writeSession(home, rootId, [activity('started'), activity('completed'), completion('ROOT_SUMMARY')])
  await writeSession(home, childId, childEvents)
  return home
}

function tracker(): CodexDelegationTracker {
  const value = new CodexDelegationTracker()
  value.consume({ type: 'thread.started', thread_id: rootId })
  return value
}

function tool(value: CodexDelegationTracker, item: Record<string, unknown>): void {
  value.consume({ type: 'item.completed', item: { type: 'collab_tool_call', status: 'completed', ...item } })
}

describe('Codex delegation evidence', () => {
  it('requires a matching spawn and child result, not a root claim or an empty wait', async () => {
    const value = tracker()
    value.consume({ type: 'item.completed', item: { type: 'agent_message', text: 'I delegated successfully. VERDICT: PASS' } })
    tool(value, { tool: 'wait', receiver_thread_ids: [], agents_states: {} })
    await expect(value.verify()).rejects.toThrow('생성 기록')
    tool(value, { tool: 'spawn_agent', receiver_thread_ids: [childId] })
    await expect(value.verify()).rejects.toThrow('완료 기록')
    tool(value, { tool: 'wait', agents_states: { [childId]: { status: 'completed', message: '[high] broken code' } } })
    expect(await value.verify()).toEqual({ message: '[high] broken code', model: null })
  })

  it('rejects failed children, failed tools and multiple workers even with exit-zero output', async () => {
    for (const item of [
      { tool: 'wait', agents_states: { [childId]: { status: 'errored', message: 'error' } } },
      { tool: 'spawn_agent', status: 'failed', receiver_thread_ids: [] },
      { tool: 'spawn_agent', receiver_thread_ids: [childId, 'other-child'] }
    ]) {
      const value = tracker()
      tool(value, item)
      await expect(value.verify()).rejects.toThrow()
    }
  })

  it('recovers omitted v2 activity from the exact root/child sessions and uses the child response', async () => {
    const home = await fixture([
      { type: 'turn_context', payload: { model: 'observed-model', effort: 'high' } },
      completion('CHILD_RESULT')
    ])
    const value = tracker()
    // Recorded exec --json behavior in CLI 0.150.1: only an empty wait and root text.
    tool(value, { tool: 'wait', receiver_thread_ids: [], agents_states: {} })
    value.consume({ type: 'item.completed', item: { type: 'agent_message', text: 'ROOT_SUMMARY' } })
    expect(await value.verify(home)).toEqual({ message: 'CHILD_RESULT', model: 'observed-model · high' })
  })

  it('does not treat a v2 completed notification as proof that the child succeeded', async () => {
    const home = await fixture([{ type: 'event_msg', payload: { type: 'turn_aborted' } }])
    await expect(tracker().verify(home)).rejects.toThrow('실패 또는 중단')
    await writeSession(home, childId, [])
    await expect(tracker().verify(home)).rejects.toThrow('완료 기록')
    await writeSession(home, childId, [completion('older reply'), { type: 'event_msg', payload: { type: 'task_started' } }])
    await expect(tracker().verify(home)).rejects.toThrow('완료 기록')
  })

  it('accepts a completed child after a recoverable stream error', async () => {
    const home = await fixture([{ type: 'event_msg', payload: { type: 'error' } }, completion('recovered')])
    expect((await tracker().verify(home)).message).toBe('recovered')
  })

  it('rejects recursive delegation and multiple lifecycle children', async () => {
    const home = await fixture([completion('done'), {
      type: 'event_msg', payload: { type: 'item_completed', thread_id: childId, item: {
        type: 'SubAgentActivity', kind: 'started', agent_thread_id: 'grandchild'
      } }
    }])
    await expect(tracker().verify(home)).rejects.toThrow('다시 작업을 위임')
    await writeSession(home, rootId, [activity('started'), activity('started', 'other-child')])
    await expect(tracker().verify(home)).rejects.toThrow('두 명 이상')
  })

  it('ignores assistant text that resembles lifecycle JSON and foreign thread activity', async () => {
    const home = await fixture()
    await writeSession(home, rootId, [
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: JSON.stringify(activity('started')) } },
      { ...activity('started'), payload: { ...activity('started').payload, thread_id: childId } }
    ])
    await expect(tracker().verify(home)).rejects.toThrow('생성 기록')
  })

  it('rejects model overrides that differ from the frozen role selection', async () => {
    const home = await fixture([
      { type: 'turn_context', payload: { model: 'different-model', effort: 'high' } },
      completion('done')
    ])
    await expect(tracker().verify(home, { model: 'requested-model', reasoningEffort: 'low' })).rejects.toThrow('요청 설정과 다릅니다')
  })

  it('rejects mismatched identity, path traversal and symlinked session files', async () => {
    const home = await fixture()
    expect(await readCodexSessionEvidence(home, '../../auth')).toBeNull()
    const path = await writeSession(home, rootId, [])
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: childId } }))
    expect(await readCodexSessionEvidence(home, rootId)).toBeNull()
    await rm(path)
    const external = join(home, 'outside.jsonl')
    await writeFile(external, 'private fixture')
    await symlink(external, path)
    expect(await readCodexSessionEvidence(home, rootId)).toBeNull()
  })
})
