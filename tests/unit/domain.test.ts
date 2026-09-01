import { describe, expect, it } from 'vitest'
import { buildDailySeries, buildHourlyActivity, canTransition } from '../../src/shared/domain'
import type { EventRecord, TaskRecord } from '../../src/shared/types'

describe('task state machine', () => {
  it('allows the guarded implementation and approval flow', () => {
    expect(canTransition('queued', 'running')).toBe(true)
    expect(canTransition('running', 'testing')).toBe(true)
    expect(canTransition('testing', 'running')).toBe(true)
    expect(canTransition('testing', 'awaiting_approval')).toBe(true)
    expect(canTransition('awaiting_approval', 'completed')).toBe(true)
  })

  it('does not allow completed work to restart or skip approval', () => {
    expect(canTransition('completed', 'running')).toBe(false)
    expect(canTransition('running', 'completed')).toBe(false)
    expect(canTransition('discarded', 'running')).toBe(false)
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
