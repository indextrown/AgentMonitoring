import { realpath } from 'node:fs/promises'
import type { CodexModelSelection, TechSpecProgress } from '../../src/shared/types'
import { PlanningAppServer, type RpcObject } from './planning-app-server'
import { PlanningRepositoryContext, safePlanningPath } from './planning-repository-context'
import { PlanningTimeoutError } from './planning-diagnostics'

interface PlanningBudget {
  researchMs: number
  maxToolCalls: number
  inactiveMs: number
}

interface DraftSession {
  path: string
  threadId?: string
  fingerprint?: string
  connection?: PlanningAppServer
  idleTimer?: NodeJS.Timeout
  controller?: AbortController
  active?: Promise<string>
}

export interface PlanningRequest {
  draftKey: string
  requestId: string
  projectPath: string
  signal?: AbortSignal
  onProgress?: (progress: TechSpecProgress) => void
}

/** Extract only the visible Markdown field, never reasoning or raw JSON/tool output. */
export function markdownPreview(text: string): string {
  const match = /"markdown"\s*:\s*"/.exec(text)
  if (!match) return ''
  const start = match.index + match[0].length
  let end = start
  for (; end < text.length; end++) {
    if (text[end] === '"') break
    if (text[end] === '\\') {
      const length = text[end + 1] === 'u' ? 6 : 2
      if (end + length > text.length) break
      end += length - 1
    }
  }
  try { return JSON.parse(`"${text.slice(start, end)}"`).slice(0, 30_000) } catch { return '' }
}

export class TechSpecConversations {
  private readonly drafts = new Map<string, DraftSession>()
  private readonly context = new PlanningRepositoryContext()
  private readonly budget: PlanningBudget

  constructor(private readonly command: string, private readonly codexHome?: string, private readonly timeoutMs = 180_000, private readonly idleMs = 60_000, budget: Partial<PlanningBudget> = {}) {
    this.budget = { researchMs: 45_000, maxToolCalls: 8, inactiveMs: 90_000, ...budget }
  }

  async run(input: PlanningRequest & { instructions: string; requirements: string; model?: CodexModelSelection; outputSchema: object }): Promise<string> {
    input.signal?.throwIfAborted()
    const path = await realpath(input.projectPath)
    input.signal?.throwIfAborted()
    let draft = this.drafts.get(input.draftKey)
    if (draft && draft.path !== path) throw new Error('다른 프로젝트의 계획 대화는 이어갈 수 없습니다.')
    if (draft?.active) throw new Error('이 초안의 테크스펙 요청이 이미 진행 중입니다.')
    if (!draft) {
      if (this.drafts.size >= 16) throw new Error('열린 계획 초안이 너무 많습니다. 사용하지 않는 작업 등록 화면을 닫아 주세요.')
      draft = { path }
      this.drafts.set(input.draftKey, draft)
    }
    if (draft.idleTimer) clearTimeout(draft.idleTimer)
    const controller = new AbortController()
    draft.controller = controller
    const abort = (): void => controller.abort(input.signal?.reason ?? new Error('테크스펙 생성을 취소했습니다.'))
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(new PlanningTimeoutError('timeout', `테크스펙 생성의 전체 제한 ${Math.round(this.timeoutMs / 1000)}초를 초과했습니다. 기존 문서와 의견은 보존됩니다. 같은 대화에서 다시 요청하거나 새 대화로 시작할 수 있습니다.`)), this.timeoutMs)
    const active = this.execute(draft, { ...input, signal: controller.signal }, controller)
    draft.active = active
    try { return await active }
    finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      draft.active = undefined
      draft.controller = undefined
      if (this.drafts.get(input.draftKey) === draft) {
        // Persisted Codex history can be resumed after the idle transport is released.
        draft.idleTimer = setTimeout(() => {
          const connection = draft.connection
          draft.connection = undefined
          void connection?.close()
        }, this.idleMs)
        draft.idleTimer.unref()
      }
    }
  }

  async release(key: string): Promise<void> {
    const draft = this.drafts.get(key)
    if (!draft) return
    this.drafts.delete(key)
    if (draft.idleTimer) clearTimeout(draft.idleTimer)
    draft.controller?.abort(new Error('계획 대화를 종료했습니다.'))
    await draft.active?.catch(() => undefined)
    if (draft.connection && draft.threadId) {
      await draft.connection.call('thread/archive', { threadId: draft.threadId }, 2_000).catch(() => undefined)
    }
    await draft.connection?.close()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.drafts.keys()].map((key) => this.release(key)))
  }

  private async execute(draft: DraftSession, input: PlanningRequest & { instructions: string; requirements: string; model?: CodexModelSelection; outputSchema: object }, controller: AbortController): Promise<string> {
    const signal = input.signal!
    const startedAt = Date.now()
    let turnId: string | undefined
    let unsubscribe = (): void => {}
    let connection = draft.connection
    let cancellation: Promise<void> | undefined
    let researchTimer: NodeJS.Timeout | undefined
    let inactivityTimer: NodeJS.Timeout | undefined
    let finished = false
    let lastActivity = Date.now()
    let turnStartedAt = Date.now()
    const activeTools = new Set<string>()
    const progress: TechSpecProgress = {
      requestId: input.requestId, stage: 'preparing', message: '저장소 변경 확인 중',
      startedAt, updatedAt: startedAt, preview: '', model: input.model?.model ?? '프로젝트 기본 모델',
      effort: input.model?.reasoningEffort ?? '', reusedConversation: Boolean(draft.threadId), reusedRepository: false,
      toolCalls: 0, draftingRequested: false
    }
    let lastPublished = 0
    const publish = (change: Partial<TechSpecProgress>, force = true): void => {
      Object.assign(progress, change, { updatedAt: Date.now() })
      if (signal.aborted) return
      if (force || Date.now() - lastPublished >= 100) {
        lastPublished = Date.now()
        input.onProgress?.({ ...progress })
      }
    }
    // A single steer in the same turn asks for a bounded first draft; it is not a second generation.
    // It is guidance, not a tool-permission boundary. Hard and inactivity deadlines remain enforced.
    const requestDraft = (): void => {
      // Steering while the model is already composing can queue another answer behind the current one.
      // Only steer during tool execution, never merely because visible Markdown has not arrived yet.
      if (finished || signal.aborted || !turnId || !connection || !activeTools.size || progress.draftingRequested || progress.preview) return
      publish({ draftingRequested: true, stage: 'writing', message: '조사 예산 도달 · 지금까지 확인한 내용으로 초안 작성 요청' })
      void connection.call('turn/steer', {
        threadId: draft.threadId, expectedTurnId: turnId,
        input: [{ type: 'text', text_elements: [], text: '초안 조사 예산에 도달했습니다. 추가 파일 검색과 도구 재시도를 마무리하고 지금까지 확인한 근거로 최종 테크스펙 JSON을 작성하세요. 원본 요구사항과 사용자 결정을 모두 보존하고, 미확인 코드와 추가 조사 항목은 본문에 추가 확인 필요로 적으세요. 확인하지 않은 것을 사실로 만들거나 요구사항을 삭제하지 마세요.' }]
      }).catch(() => {
        if (!finished && !signal.aborted) publish({ message: '초안 전환 요청을 전달하지 못했습니다 · 현재 응답을 기다립니다. 취소할 수 있습니다.' })
      })
    }
    // Closing the transport is the fallback if interrupt is unavailable, including startup cancellation.
    const abort = (): void => {
      if (!connection) return
      const current = connection
      const stop = turnId && draft.threadId
        ? current.call('turn/interrupt', { threadId: draft.threadId, turnId }, 1_000).catch(() => undefined)
        : Promise.resolve()
      cancellation = stop.then(() => current.close())
      void cancellation.catch(() => undefined)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      publish({})
      const context = await this.context.inspect(draft.path, signal)
      signal.throwIfAborted()
      publish({ message: draft.threadId ? '이전 계획 대화 이어가는 중' : '새 계획 대화 연결 중', reusedRepository: context.reused })
      const newConnection = !connection
      if (!connection) {
        connection = new PlanningAppServer(this.command, this.codexHome)
        draft.connection = connection
        await connection.initialize()
      }
      signal.throwIfAborted()
      const config = { cwd: draft.path, approvalPolicy: 'never', sandbox: 'read-only', model: input.model?.model ?? null }
      if (!draft.threadId) {
        const result = await connection.call('thread/start', { ...config, ephemeral: false })
        if (typeof result.thread?.id !== 'string') throw new Error('Codex 계획 대화 ID를 받지 못했습니다.')
        draft.threadId = result.thread.id
      } else if (newConnection) {
        await connection.call('thread/resume', { ...config, threadId: draft.threadId })
      }
      signal.throwIfAborted()
      const messages = new Map<string, string>()
      let final = ''
      let resolveTurn!: (value: string) => void
      let rejectTurn!: (error: Error) => void
      const completed = new Promise<string>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject })
      // Attach a rejection handler while turn/start is pending; early events are replayed once its ID is known.
      void completed.catch(() => undefined)
      const early: RpcObject[] = []
      const receive = (message: RpcObject): void => {
        const params = message.params ?? {}
        if (params.threadId !== draft.threadId) return
        if (!turnId) { if (early.length < 2_000) early.push(message); return }
        if (params.turnId && params.turnId !== turnId) return
        if (typeof message.method === 'string' && (message.method.startsWith('item/') || message.method === 'turn/completed')) {
          lastActivity = Date.now()
          publish({}, false) // A heartbeat only; reasoning and command output are never exposed.
        }
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          const text = (messages.get(params.itemId) ?? '') + params.delta
          if (text.length > 200_000) { rejectTurn(new Error('테크스펙 응답 크기 제한을 초과했습니다.')); return }
          messages.set(params.itemId, text)
          const preview = markdownPreview(text)
          if (preview) publish({ stage: 'writing', message: '테크스펙 작성 중', preview }, false)
        }
        if (message.method === 'item/started' && ['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(params.item?.type)) {
          activeTools.add(params.item.id)
          const paths = (params.item.commandActions ?? []).flatMap((action: RpcObject) =>
            typeof action.path === 'string' && safePlanningPath(action.path) ? [action.path] : [])
          publish({ toolCalls: (progress.toolCalls ?? 0) + 1,
            stage: progress.draftingRequested ? 'writing' : 'investigating',
            message: progress.draftingRequested ? '초안 작성 요청 전달됨 · 진행 중인 코드 확인 마무리' : paths.length ? `관련 파일 확인: ${paths.slice(0, 3).join(', ')}` : '관련 코드 읽기·검색 중' })
          if (progress.toolCalls! >= this.budget.maxToolCalls || Date.now() - turnStartedAt >= this.budget.researchMs) requestDraft()
        }
        if (message.method === 'item/completed') activeTools.delete(params.item?.id)
        if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
          const item = params.item
          if (typeof item.text === 'string' && item.phase !== 'commentary') {
            final = item.text
            publish({ stage: 'writing', message: '테크스펙 작성 중', preview: markdownPreview(final) || progress.preview })
          }
        }
        if (message.method === 'turn/completed' && params.turn?.id === turnId) {
          finished = true
          if (params.turn.status === 'completed') {
            const last = (params.turn.items ?? []).filter((item: RpcObject) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)
            resolveTurn(last?.text ?? final)
          } else rejectTurn(new Error(params.turn.status === 'interrupted' ? '테크스펙 생성을 취소했습니다.' :
            String(params.turn.error?.message ?? 'Codex가 테크스펙 생성 중 실패했습니다.').slice(0, 500)))
        }
      }
      unsubscribe = connection.subscribe(receive, rejectTurn)
      const abortTurn = (): void => rejectTurn(signal.reason)
      signal.addEventListener('abort', abortTurn, { once: true })
      try {
        publish({ stage: 'investigating', message: 'Codex 응답 대기 · 필요한 코드 조사' })
        const result = await connection.call('turn/start', {
          threadId: draft.threadId, cwd: draft.path, approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false }, model: input.model?.model ?? null,
          effort: input.model?.reasoningEffort ?? null, outputSchema: input.outputSchema,
          input: [{ type: 'text', text_elements: [], text: `${input.instructions}\n\n<repository-context>\n${this.context.describe(context, input.requirements, draft.fingerprint)}\n</repository-context>\n\n이전 미완료 응답은 승인된 설계가 아닙니다. 현재 요청과 직접 편집한 문서를 우선하세요.` }]
        })
        turnId = result.turn?.id
        if (!turnId) throw new Error('Codex 계획 실행 ID를 받지 못했습니다.')
        lastActivity = turnStartedAt = Date.now()
        researchTimer = setTimeout(requestDraft, this.budget.researchMs)
        inactivityTimer = setInterval(() => {
          if (!finished && Date.now() - lastActivity >= this.budget.inactiveMs) {
            controller.abort(new PlanningTimeoutError('inactive', `Codex에서 ${Math.round(this.budget.inactiveMs / 1000)}초 동안 새 진행 이벤트를 받지 못했습니다. 연결 상태를 확인한 뒤 같은 대화에서 다시 요청할 수 있습니다.`))
          }
        }, Math.min(1_000, this.budget.inactiveMs / 2))
        for (const message of early) receive(message)
        signal.throwIfAborted()
        const output = await completed
        signal.throwIfAborted()
        if (!output.trim()) throw new Error('Codex가 최종 테크스펙 응답을 남기지 않았습니다. 기존 문서를 유지합니다.')
        if (output.length > 200_000) throw new Error('테크스펙 응답 크기 제한을 초과했습니다.')
        draft.fingerprint = context.fingerprint
        publish({ stage: 'validating', message: '최종 응답 형식 검증 중' })
        return output
      } finally { signal.removeEventListener('abort', abortTurn) }
    } catch (error) {
      // Never issue an automatic second AI request after a failure.
      draft.connection = undefined
      if (cancellation) await cancellation
      else await connection?.close()
      throw signal.aborted ? signal.reason : error
    } finally {
      finished = true
      clearTimeout(researchTimer)
      clearInterval(inactivityTimer)
      signal.removeEventListener('abort', abort)
      unsubscribe()
    }
  }
}
