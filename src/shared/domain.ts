import type { EventRecord, FindingRecord, TaskRecord, TaskStatus } from './types'

export const ACTIVE_STATUSES: TaskStatus[] = ['queued', 'running', 'testing']

export function isActiveTask(task: TaskRecord): boolean {
  return ACTIVE_STATUSES.includes(task.status)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const transitions: Record<TaskStatus, TaskStatus[]> = {
    queued: ['running', 'stopped', 'discarded'],
    running: ['testing', 'awaiting_approval', 'failed', 'stopped'],
    testing: ['running', 'awaiting_approval', 'failed', 'stopped'],
    awaiting_approval: ['completed', 'discarded', 'running'],
    completed: [],
    failed: ['running', 'discarded'],
    stopped: ['running', 'discarded'],
    discarded: []
  }

  return transitions[from].includes(to)
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`허용되지 않은 작업 상태 전이입니다: ${from} → ${to}`)
  }
}

export interface DailyPoint {
  date: string
  started: number
  completed: number
  findings: number
  resolved: number
}

function localDateKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildDailySeries(
  tasks: TaskRecord[],
  findings: FindingRecord[],
  days = 16,
  now = new Date()
): DailyPoint[] {
  const points: DailyPoint[] = []
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))

  for (let index = 0; index < days; index += 1) {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = localDateKey(date)
    points.push({ date: key, started: 0, completed: 0, findings: 0, resolved: 0 })
  }

  const byDate = new Map(points.map((point) => [point.date, point]))
  for (const task of tasks) {
    const created = byDate.get(localDateKey(task.createdAt))
    if (created) created.started += 1
    if (task.status === 'completed') {
      const completed = byDate.get(localDateKey(task.updatedAt))
      if (completed) completed.completed += 1
    }
  }
  for (const finding of findings) {
    const created = byDate.get(localDateKey(finding.createdAt))
    if (created) created.findings += 1
    if (finding.resolvedAt) {
      const resolved = byDate.get(localDateKey(finding.resolvedAt))
      if (resolved) resolved.resolved += 1
    }
  }

  let started = 0
  let completed = 0
  let findingTotal = 0
  let resolved = 0
  return points.map((point) => {
    started += point.started
    completed += point.completed
    findingTotal += point.findings
    resolved += point.resolved
    return { ...point, started, completed, findings: findingTotal, resolved }
  })
}

export function buildHourlyActivity(events: EventRecord[], now = new Date()): number[] {
  const start = new Date(now.getTime() - 23 * 60 * 60 * 1000)
  start.setMinutes(0, 0, 0)
  const buckets = Array.from({ length: 24 }, () => 0)

  for (const event of events) {
    const time = new Date(event.createdAt)
    const diff = Math.floor((time.getTime() - start.getTime()) / (60 * 60 * 1000))
    if (diff >= 0 && diff < buckets.length) buckets[diff] += 1
  }

  return buckets
}
