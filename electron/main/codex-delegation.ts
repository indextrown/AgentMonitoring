import { createReadStream } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { CodexModelSelection } from '../../src/shared/types'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

interface ChildEvidence {
  started: boolean
  completed: boolean
  message: string
}

/** Tracks CLI-owned lifecycle events, never claims made in an assistant message. */
export class CodexDelegationTracker {
  threadId: string | null = null
  failure: string | null = null
  private children = new Map<string, ChildEvidence>()

  private child(id: string): ChildEvidence {
    const existing = this.children.get(id)
    if (existing) return existing
    if (this.children.size >= 2) {
      this.failure = '한 단계에서 두 명 이상의 서브에이전트가 생성됐습니다.'
      return { started: false, completed: false, message: '' }
    }
    const value = { started: false, completed: false, message: '' }
    this.children.set(id, value)
    return value
  }

  consume(event: Record<string, unknown>): string | null {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      this.threadId ??= event.thread_id
    }
    if (event.type !== 'item.completed') return null
    const item = record(event.item)
    if (item?.type !== 'collab_tool_call') return null
    if (item.status === 'failed') this.failure = 'Codex 서브에이전트 도구 실행이 실패했습니다.'
    const ids = Array.isArray(item.receiver_thread_ids)
      ? item.receiver_thread_ids.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : []
    if (item.tool === 'spawn_agent' && item.status === 'completed') {
      for (const id of ids) this.child(id).started = true
      if (ids.length) return '서브에이전트 생성 확인 · 결과를 기다립니다.'
    }
    for (const [id, value] of Object.entries(record(item.agents_states) ?? {})) {
      const state = record(value)
      if (state?.status === 'completed') {
        const child = this.child(id)
        child.completed = true
        if (typeof state.message === 'string') child.message = state.message
      } else if (state?.status === 'running' || state?.status === 'pending_init') {
        const child = this.child(id)
        child.completed = false
        child.message = ''
      } else if (['errored', 'failed', 'interrupted', 'not_found'].includes(String(state?.status))) {
        this.failure = '서브에이전트가 정상적으로 작업을 마치지 못했습니다.'
      }
    }
    return item.tool === 'wait' ? '서브에이전트 대기 결과를 확인했습니다.' : null
  }

  async verify(codexHome?: string, requestedModel?: CodexModelSelection): Promise<{ message: string; model: string | null }> {
    let observedModel: string | null = null
    // Codex 0.150.1 omits v2 SubAgentActivity from exec --json. Read only this
    // invocation's root/child lifecycle records, not other sessions or auth files.
    if (codexHome && this.threadId) {
      const root = await readCodexSessionEvidence(codexHome, this.threadId)
      if (root) {
        if (root.failure) this.failure = root.failure
        for (const [id, state] of root.children) {
          const child = this.child(id)
          child.started ||= state.started
          child.completed ||= state.completed
        }
        if (this.children.size === 1) {
          const [id, child] = [...this.children][0]
          const session = await readCodexSessionEvidence(codexHome, id)
          if (session) {
            if (session.failure) this.failure = session.failure
            if (session.children.size) this.failure = '서브에이전트가 다시 작업을 위임했습니다. 한 단계에는 한 명만 허용됩니다.'
            child.completed = session.completed
            child.message = session.message
            observedModel = session.model ? `${session.model.model} · ${session.model.reasoningEffort}` : null
            if (session.model && requestedModel && (session.model.model !== requestedModel.model || session.model.reasoningEffort !== requestedModel.reasoningEffort)) {
              this.failure = '서브에이전트 세션의 모델·추론 강도가 작업에 고정된 요청 설정과 다릅니다. Codex 사용자 정의 에이전트 설정을 확인하세요.'
            }
          }
        }
      }
    }
    if (this.failure) throw new Error(this.failure)
    if (this.children.size > 1) throw new Error('한 단계에서 두 명 이상의 서브에이전트가 생성됐습니다.')
    if (this.children.size !== 1) {
      throw new Error('서브에이전트 한 명의 생성 기록을 확인하지 못했습니다. Codex를 업데이트하거나 새 작업에서 역할별 독립 실행을 선택하세요.')
    }
    const child = [...this.children.values()][0]
    if (!child.started || !child.completed || !child.message.trim()) {
      throw new Error('서브에이전트의 완료 기록과 최종 응답을 확인하지 못했습니다. 작업 결과를 보존했으니 실행 환경을 확인한 뒤 다시 시도하세요.')
    }
    return { message: child.message, model: observedModel }
  }
}

interface SessionEvidence {
  children: Map<string, ChildEvidence>
  completed: boolean
  message: string
  failure: string | null
  model: CodexModelSelection | null
}

function sessionDays(threadId: string): string[] {
  // CLI UUIDv7 ids encode creation time. Adjacent days cover local/UTC rollover.
  const timestamp = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16)
  return [-1, 0, 1].map((offset) => new Date(timestamp + offset * 86_400_000)
    .toISOString().slice(0, 10).replaceAll('-', '/'))
}

async function sessionPath(codexHome: string, threadId: string): Promise<string | null> {
  if (!/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(threadId)) return null
  const home = await realpath(codexHome)
  for (const day of sessionDays(threadId)) {
    const directory = join(home, 'sessions', day)
    try {
      if (await realpath(directory) !== directory) continue
      let scanned = 0
      for await (const entry of await opendir(directory)) {
        if (++scanned > 10_000) break
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith(`-${threadId}.jsonl`)) continue
        const path = join(directory, entry.name)
        const pathFromHome = relative(home, await realpath(path))
        if (isAbsolute(pathFromHome) || pathFromHome.startsWith(`..${sep}`)) continue
        const info = await lstat(path)
        if (info.isFile() && info.size <= 64 * 1024 * 1024) return path
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

export async function readCodexSessionEvidence(codexHome: string, threadId: string): Promise<SessionEvidence | null> {
  const path = await sessionPath(codexHome, threadId)
  if (!path) return null
  const evidence: SessionEvidence = { children: new Map(), completed: false, message: '', failure: null, model: null }
  const stream = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let identityVerified = false
  let provisionalFailure: string | null = null
  try {
    for await (const line of lines) {
      let event: Record<string, unknown>
      try { event = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const payload = record(event.payload)
      if (!payload) continue
      if (event.type === 'session_meta') {
        if (payload.id !== threadId) return null
        identityVerified = true
      }
      if (!identityVerified) continue
      if (event.type === 'turn_context' && typeof payload.model === 'string' && typeof payload.effort === 'string') {
        evidence.model = { model: payload.model, reasoningEffort: payload.effort as CodexModelSelection['reasoningEffort'] }
      }
      if (event.type !== 'event_msg') continue
      if (payload.type === 'task_started') {
        evidence.completed = false
        evidence.message = ''
      }
      if (payload.type === 'error') provisionalFailure = 'Codex 세션에 오류 기록이 있고 정상 완료를 확인하지 못했습니다.'
      if (['turn_aborted', 'task_failed', 'turn_failed'].includes(String(payload.type))) {
        evidence.failure = 'Codex 세션에 실패 또는 중단 기록이 있습니다.'
      }
      if (payload.type === 'task_complete') {
        provisionalFailure = null
        evidence.completed = true
        if (typeof payload.last_agent_message === 'string') evidence.message = payload.last_agent_message.slice(-80_000)
      }
      const item = payload.type === 'item_completed' ? record(payload.item) : null
      if (item?.type !== 'SubAgentActivity' || typeof item.agent_thread_id !== 'string') continue
      if (payload.thread_id !== threadId) continue
      const child = evidence.children.get(item.agent_thread_id) ?? { started: false, completed: false, message: '' }
      child.started ||= item.kind === 'started'
      child.completed ||= item.kind === 'completed'
      if (evidence.children.size >= 2 && !evidence.children.has(item.agent_thread_id)) {
        evidence.failure = '한 단계에서 두 명 이상의 서브에이전트가 생성됐습니다.'
      } else {
        evidence.children.set(item.agent_thread_id, child)
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  evidence.failure ??= provisionalFailure
  return identityVerified ? evidence : null
}
