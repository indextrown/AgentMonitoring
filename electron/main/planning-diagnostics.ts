import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TechSpecProgress } from '../../src/shared/types'

export type PlanningFailure = 'cancelled' | 'timeout' | 'inactive' | 'usage-limit' | 'connection' | 'invalid-output' | 'unknown'

export class PlanningTimeoutError extends Error {
  constructor(readonly category: 'timeout' | 'inactive', message: string) { super(message) }
}

export function planningFailure(error: unknown): PlanningFailure {
  if (error instanceof PlanningTimeoutError) return error.category
  const message = error instanceof Error ? error.message : String(error)
  if (/취소|대화를 종료|AbortError/.test(message)) return 'cancelled'
  if (/usage limit|quota|rate limit/i.test(message)) return 'usage-limit'
  if (/시간.*초과|ETIMEDOUT/i.test(message)) return 'timeout'
  if (/JSON|형식|길이|최종.*응답|크기 제한/.test(message)) return 'invalid-output'
  if (/연결|ECONN|ENOTFOUND|fetch failed/i.test(message)) return 'connection'
  return 'unknown'
}

export interface PlanningDiagnostic {
  requestId: string
  startedAt: number
  durationMs: number
  outcome: 'completed' | PlanningFailure
  stage: TechSpecProgress['stage']
  toolCalls: number
  draftingRequested: boolean
  firstPreviewMs: number | null
  reusedConversation: boolean
  reusedRepository: boolean
}

/** Bounded, local metadata only. Never persist prompts, paths, model output or error bodies. */
export class PlanningDiagnostics {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly directory?: string) {}

  record(value: PlanningDiagnostic): Promise<void> {
    if (!this.directory) return Promise.resolve()
    const directory = this.directory
    // Pick fields explicitly so future callers cannot accidentally serialize a prompt or token.
    const safe: PlanningDiagnostic = {
      requestId: value.requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
      startedAt: value.startedAt, durationMs: value.durationMs, outcome: value.outcome,
      stage: value.stage, toolCalls: value.toolCalls, draftingRequested: value.draftingRequested,
      firstPreviewMs: value.firstPreviewMs, reusedConversation: value.reusedConversation,
      reusedRepository: value.reusedRepository
    }
    this.queue = this.queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, 'tech-spec.jsonl')
      let previous = ''
      try { previous = await readFile(path, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const lines = previous.trim().split('\n').filter(Boolean).slice(-49)
      lines.push(JSON.stringify(safe))
      await writeFile(path + '.tmp', lines.join('\n') + '\n', { mode: 0o600 })
      await rename(path + '.tmp', path)
    }).catch(() => undefined) // Diagnostics must never turn a successful generation into a failure.
    return this.queue
  }
}
