import { describe, expect, it } from 'vitest'
import {
  buildDailySeries,
  buildHourlyActivity,
  buildRuntimeTaskReport,
  canTransition
} from '../../src/shared/domain'
import type { EventRecord, RuntimeEvidenceRecord, TaskRecord } from '../../src/shared/types'

describe('task state machine', () => {
  it('allows the guarded implementation and approval flow', () => {
    expect(canTransition('queued', 'running')).toBe(true)
    expect(canTransition('running', 'testing')).toBe(true)
    expect(canTransition('running', 'blocked_environment')).toBe(true)
    expect(canTransition('testing', 'blocked_environment')).toBe(true)
    expect(canTransition('blocked_environment', 'running')).toBe(true)
    expect(canTransition('testing', 'running')).toBe(true)
    expect(canTransition('testing', 'awaiting_approval')).toBe(true)
    expect(canTransition('awaiting_approval', 'completed')).toBe(true)
    expect(canTransition('running', 'awaiting_manual_validation')).toBe(true)
    expect(canTransition('awaiting_manual_validation', 'completed')).toBe(true)
  })

  it('does not allow completed work to restart or skip approval', () => {
    expect(canTransition('completed', 'running')).toBe(false)
    expect(canTransition('running', 'completed')).toBe(false)
    expect(canTransition('discarded', 'running')).toBe(false)
    expect(canTransition('blocked_environment', 'completed')).toBe(false)
  })
})

describe('activity aggregation', () => {
  it('places recent events into a 24-hour bucket', () => {
    const now = new Date('2026-09-01T12:30:00.000Z')
    const event: EventRecord = {
      id: 1,
      projectId: 'project',
      taskId: null,
      kind: 'agent',
      actor: 'codex',
      message: 'event',
      severity: null,
      createdAt: '2026-09-01T12:05:00.000Z'
    }

    const buckets = buildHourlyActivity([event], now)
    expect(buckets).toHaveLength(24)
    expect(buckets.at(-1)).toBe(1)
    expect(buckets.reduce((sum, value) => sum + value, 0)).toBe(1)
  })

  it('builds a monotonic cumulative task series in the local calendar', () => {
    const now = new Date()
    const tasks: TaskRecord[] = Array.from({ length: 32 }, (_, index) => {
      const created = new Date(now)
      created.setDate(now.getDate() - Math.floor((31 - index) / 2))
      created.setHours(9, 0, 0, 0)
      return {
        id: String(index),
        projectId: 'project',
        title: 'task',
        prompt: 'prompt',
        status: 'completed',
        provider: 'codex',
        maxAttempts: 3,
        attempt: 1,
        branchName: null,
        worktreePath: null,
        sourceBranch: null,
        baseCommit: null,
        createdAt: created.toISOString(),
        updatedAt: new Date(created.getTime() + 60 * 60 * 1000).toISOString()
      }
    })

    const series = buildDailySeries(tasks, [], 16, now)
    expect(series.at(-1)?.started).toBe(32)
    expect(series.at(-1)?.completed).toBe(32)
    expect(series.every((point, index) => index === 0 || point.started >= series[index - 1].started)).toBe(true)
  })
})

describe('runtime report aggregation', () => {
  it('groups evidence by execution and attempt while preserving repair outcomes', () => {
    const evidence = (
      [
        ['run-1', 1, 'screen', 'captured', null, '2026-09-01T00:00:00.000Z'],
        ['run-1', 1, 'runtime-verification', 'failed', '2/3 통과', '2026-09-01T00:00:01.000Z'],
        ['run-1', 2, 'screen', 'captured', null, '2026-09-01T00:01:00.000Z'],
        ['run-1', 2, 'runtime-verification', 'passed', '3/3 통과', '2026-09-01T00:01:01.000Z'],
        ['run-2', 1, 'runtime-verification', 'passed', '3/3 통과', '2026-09-02T00:00:00.000Z']
      ] as const
    ).map<RuntimeEvidenceRecord>(([runId, attempt, kind, outcome, summary, createdAt], index) => ({
      id: `evidence-${index}`,
      taskId: 'task',
      projectId: 'project',
      runId,
      attempt,
      kind,
      outcome,
      summary,
      path: `/tmp/evidence-${index}.json`,
      mimeType: kind === 'screen' ? 'image/png' : 'application/json',
      sizeBytes: 100,
      createdAt
    }))
    const repairEvent: EventRecord = {
      id: 1,
      projectId: 'project',
      taskId: 'task',
      kind: 'runtime_repair_started',
      actor: 'orchestrator',
      message: 'repair',
      severity: null,
      createdAt: '2026-09-01T00:00:02.000Z'
    }

    const report = buildRuntimeTaskReport(evidence, [repairEvent])

    expect(report).toMatchObject({
      runCount: 2,
      repairCount: 1,
      evidenceCount: 5,
      passedCount: 2,
      failedCount: 1,
      latestOutcome: 'passed',
      recovered: false
    })
    expect(report?.attempts.map(({ executionNumber, attempt, outcome, repaired }) => ({
      executionNumber,
      attempt,
      outcome,
      repaired
    }))).toEqual([
      { executionNumber: 2, attempt: 1, outcome: 'passed', repaired: false },
      { executionNumber: 1, attempt: 2, outcome: 'passed', repaired: false },
      { executionNumber: 1, attempt: 1, outcome: 'failed', repaired: true }
    ])
  })
})
