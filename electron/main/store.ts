import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  DashboardSnapshot,
  EventKind,
  EventRecord,
  FindingRecord,
  NoteRecord,
  ProjectRecord,
  RuntimeEvidenceRecord,
  RuntimeSessionRecord,
  RuntimeSessionStatus,
  Severity,
  TaskRecord,
  TaskStatus,
  UpdateProjectInput
} from '../../src/shared/types'
import { assertTransition } from '../../src/shared/domain'

type Row = Record<string, unknown>

const projectColumns = `
  id,
  name,
  path,
  test_command AS testCommand,
  is_demo AS isDemo,
  created_at AS createdAt
`

const taskColumns = `
  id,
  project_id AS projectId,
  title,
  prompt,
  status,
  provider,
  max_attempts AS maxAttempts,
  attempt,
  branch_name AS branchName,
  worktree_path AS worktreePath,
  created_at AS createdAt,
  updated_at AS updatedAt
`

const eventColumns = `
  id,
  project_id AS projectId,
  task_id AS taskId,
  kind,
  actor,
  message,
  severity,
  created_at AS createdAt
`

const findingColumns = `
  id,
  project_id AS projectId,
  task_id AS taskId,
  title,
  severity,
  resolved,
  created_at AS createdAt,
  resolved_at AS resolvedAt
`

const noteColumns = `
  id,
  project_id AS projectId,
  title,
  body,
  created_at AS createdAt
`

const runtimeSessionColumns = `
  task_id AS taskId,
  project_id AS projectId,
  status,
  adapter_kind AS adapterKind,
  device_id AS deviceId,
  device_name AS deviceName,
  bundle_identifier AS bundleIdentifier,
  process_id AS processId,
  message,
  started_at AS startedAt,
  updated_at AS updatedAt
`

const runtimeEvidenceColumns = `
  id,
  task_id AS taskId,
  project_id AS projectId,
  kind,
  path,
  mime_type AS mimeType,
  size_bytes AS sizeBytes,
  created_at AS createdAt
`

function projectFromRow(row: Row): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    testCommand: String(row.testCommand),
    isDemo: Boolean(row.isDemo),
    createdAt: String(row.createdAt)
  }
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    title: String(row.title),
    prompt: String(row.prompt),
    status: String(row.status) as TaskStatus,
    provider: 'codex',
    maxAttempts: Number(row.maxAttempts),
    attempt: Number(row.attempt),
    branchName: row.branchName ? String(row.branchName) : null,
    worktreePath: row.worktreePath ? String(row.worktreePath) : null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  }
}

function eventFromRow(row: Row): EventRecord {
  return {
    id: Number(row.id),
    projectId: String(row.projectId),
    taskId: row.taskId ? String(row.taskId) : null,
    kind: String(row.kind) as EventKind,
    actor: String(row.actor),
    message: String(row.message),
    severity: row.severity ? (String(row.severity) as Severity) : null,
    createdAt: String(row.createdAt)
  }
}

function findingFromRow(row: Row): FindingRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    taskId: row.taskId ? String(row.taskId) : null,
    title: String(row.title),
    severity: String(row.severity) as Severity,
    resolved: Boolean(row.resolved),
    createdAt: String(row.createdAt),
    resolvedAt: row.resolvedAt ? String(row.resolvedAt) : null
  }
}

function noteFromRow(row: Row): NoteRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.createdAt)
  }
}

function runtimeSessionFromRow(row: Row): RuntimeSessionRecord {
  return {
    taskId: String(row.taskId),
    projectId: String(row.projectId),
    status: String(row.status) as RuntimeSessionStatus,
    adapterKind: 'ios-simulator',
    deviceId: row.deviceId ? String(row.deviceId) : null,
    deviceName: row.deviceName ? String(row.deviceName) : null,
    bundleIdentifier: row.bundleIdentifier ? String(row.bundleIdentifier) : null,
    processId: row.processId === null || row.processId === undefined ? null : Number(row.processId),
    message: String(row.message),
    startedAt: String(row.startedAt),
    updatedAt: String(row.updatedAt)
  }
}

function runtimeEvidenceFromRow(row: Row): RuntimeEvidenceRecord {
  return {
    id: String(row.id),
    taskId: String(row.taskId),
    projectId: String(row.projectId),
    kind: String(row.kind) as RuntimeEvidenceRecord['kind'],
    path: String(row.path),
    mimeType: String(row.mimeType) as RuntimeEvidenceRecord['mimeType'],
    sizeBytes: Number(row.sizeBytes),
    createdAt: String(row.createdAt)
  }
}

export class AppStore {
  readonly database: DatabaseSync

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
    this.removeLegacyDemoData()
  }

  close(): void {
    this.database.close()
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        test_command TEXT NOT NULL DEFAULT '',
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex',
        max_attempts INTEGER NOT NULL DEFAULT 3,
        attempt INTEGER NOT NULL DEFAULT 0,
        branch_name TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        message TEXT NOT NULL,
        severity TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        device_id TEXT,
        device_name TEXT,
        bundle_identifier TEXT,
        process_id INTEGER,
        message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_created
        ON tasks(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_project_created
        ON events(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_project_created
        ON findings(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_project_updated
        ON runtime_sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_evidence_task_created
        ON runtime_evidence(task_id, created_at DESC);
    `)
  }

  private removeLegacyDemoData(): void {
    this.database.prepare('DELETE FROM projects WHERE is_demo = 1').run()
  }

  listProjects(): ProjectRecord[] {
    return (this.database.prepare(`SELECT ${projectColumns} FROM projects ORDER BY created_at`).all() as Row[]).map(
      projectFromRow
    )
  }

  getProject(projectId: string): ProjectRecord {
    const row = this.database.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(projectId) as
      | Row
      | undefined
    if (!row) throw new Error('프로젝트를 찾을 수 없습니다.')
    return projectFromRow(row)
  }

  addProject(name: string, path: string): ProjectRecord {
    const existing = this.database.prepare(`SELECT ${projectColumns} FROM projects WHERE path = ?`).get(path) as
      | Row
      | undefined
    if (existing) return projectFromRow(existing)

    const project: ProjectRecord = {
      id: randomUUID(),
      name,
      path,
      testCommand: '',
      isDemo: false,
      createdAt: new Date().toISOString()
    }
    this.database
      .prepare('INSERT INTO projects (id, name, path, test_command, is_demo, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(project.id, project.name, project.path, project.testCommand, project.createdAt)
    this.addEvent(project.id, null, 'project_created', 'human', `${project.name} 프로젝트 등록`)
    return project
  }

  updateProject(input: UpdateProjectInput): ProjectRecord {
    this.database
      .prepare('UPDATE projects SET name = ?, test_command = ? WHERE id = ?')
      .run(input.name.trim(), input.testCommand.trim(), input.projectId)
    return this.getProject(input.projectId)
  }

  deleteProject(projectId: string): ProjectRecord {
    const project = this.getProject(projectId)
    this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    return project
  }

  createTask(projectId: string, title: string, prompt: string, maxAttempts: number): TaskRecord {
    this.getProject(projectId)
    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: randomUUID(),
      projectId,
      title: title.trim(),
      prompt: prompt.trim(),
      status: 'queued',
      provider: 'codex',
      maxAttempts: Math.max(1, Math.min(maxAttempts, 5)),
      attempt: 0,
      branchName: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now
    }
    this.database
      .prepare(`
        INSERT INTO tasks (
          id, project_id, title, prompt, status, provider, max_attempts, attempt,
          branch_name, worktree_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'codex', ?, 0, NULL, NULL, ?, ?)
      `)
      .run(task.id, task.projectId, task.title, task.prompt, task.status, task.maxAttempts, now, now)
    this.addEvent(projectId, task.id, 'task_created', 'human', `${task.title} 작업 등록`)
    return task
  }

  getTask(taskId: string): TaskRecord {
    const row = this.database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`).get(taskId) as Row | undefined
    if (!row) throw new Error('작업을 찾을 수 없습니다.')
    return taskFromRow(row)
  }

  listTasks(projectId: string): TaskRecord[] {
    return (
      this.database
        .prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id = ? ORDER BY created_at DESC`)
        .all(projectId) as Row[]
    ).map(taskFromRow)
  }

  transitionTask(taskId: string, status: TaskStatus, attempt?: number): TaskRecord {
    const task = this.getTask(taskId)
    if (task.status !== status) assertTransition(task.status, status)
    const nextAttempt = attempt ?? task.attempt
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET status = ?, attempt = ?, updated_at = ? WHERE id = ?')
      .run(status, nextAttempt, now, taskId)
    return this.getTask(taskId)
  }

  setTaskWorkspace(taskId: string, branchName: string, worktreePath: string): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?')
      .run(branchName, worktreePath, now, taskId)
    return this.getTask(taskId)
  }

  clearTaskWorktree(taskId: string): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET worktree_path = NULL, updated_at = ? WHERE id = ?')
      .run(now, taskId)
    return this.getTask(taskId)
  }

  getRuntimeSession(taskId: string): RuntimeSessionRecord | null {
    const row = this.database
      .prepare(`SELECT ${runtimeSessionColumns} FROM runtime_sessions WHERE task_id = ?`)
      .get(taskId) as Row | undefined
    return row ? runtimeSessionFromRow(row) : null
  }

  listRuntimeSessions(projectId?: string): RuntimeSessionRecord[] {
    const rows = projectId
      ? (this.database
          .prepare(`SELECT ${runtimeSessionColumns} FROM runtime_sessions WHERE project_id = ? ORDER BY updated_at DESC`)
          .all(projectId) as Row[])
      : (this.database
          .prepare(`SELECT ${runtimeSessionColumns} FROM runtime_sessions ORDER BY updated_at DESC`)
          .all() as Row[])
    return rows.map(runtimeSessionFromRow)
  }

  setRuntimeSession(
    taskId: string,
    status: RuntimeSessionStatus,
    update: Partial<
      Pick<RuntimeSessionRecord, 'deviceId' | 'deviceName' | 'bundleIdentifier' | 'processId' | 'message'>
    > = {}
  ): RuntimeSessionRecord {
    const task = this.getTask(taskId)
    const existing = this.getRuntimeSession(taskId)
    const now = new Date().toISOString()
    const next: RuntimeSessionRecord = {
      taskId,
      projectId: task.projectId,
      status,
      adapterKind: 'ios-simulator',
      deviceId: 'deviceId' in update ? update.deviceId ?? null : existing?.deviceId ?? null,
      deviceName: 'deviceName' in update ? update.deviceName ?? null : existing?.deviceName ?? null,
      bundleIdentifier: 'bundleIdentifier' in update
        ? update.bundleIdentifier ?? null
        : existing?.bundleIdentifier ?? null,
      processId: 'processId' in update ? update.processId ?? null : existing?.processId ?? null,
      message: (update.message ?? existing?.message ?? '').slice(0, 8_000),
      startedAt: status === 'preparing' && existing?.status !== 'preparing' ? now : existing?.startedAt ?? now,
      updatedAt: now
    }
    this.database
      .prepare(`
        INSERT INTO runtime_sessions (
          task_id, project_id, status, adapter_kind, device_id, device_name,
          bundle_identifier, process_id, message, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          status = excluded.status,
          adapter_kind = excluded.adapter_kind,
          device_id = excluded.device_id,
          device_name = excluded.device_name,
          bundle_identifier = excluded.bundle_identifier,
          process_id = excluded.process_id,
          message = excluded.message,
          updated_at = excluded.updated_at
      `)
      .run(
        next.taskId,
        next.projectId,
        next.status,
        next.adapterKind,
        next.deviceId,
        next.deviceName,
        next.bundleIdentifier,
        next.processId,
        next.message,
        next.startedAt,
        next.updatedAt
      )
    return this.getRuntimeSession(taskId)!
  }

  recoverInterruptedRuntimeSessions(): RuntimeSessionRecord[] {
    const interrupted = this.listRuntimeSessions().filter(
      (session) => !['failed', 'stopped'].includes(session.status)
    )
    return interrupted.map((session) => {
      const recovered = this.setRuntimeSession(session.taskId, 'stopped', {
        message: '앱이 다시 시작되어 runtime session을 중단 상태로 복구했습니다.',
        processId: null
      })
      this.addEvent(
        session.projectId,
        session.taskId,
        'runtime_stopped',
        'runtime',
        recovered.message,
        'low'
      )
      return recovered
    })
  }

  addRuntimeEvidence(
    taskId: string,
    input: Pick<RuntimeEvidenceRecord, 'kind' | 'path' | 'mimeType' | 'sizeBytes' | 'createdAt'>
  ): RuntimeEvidenceRecord {
    const task = this.getTask(taskId)
    const evidence: RuntimeEvidenceRecord = {
      id: randomUUID(),
      taskId,
      projectId: task.projectId,
      ...input
    }
    this.database
      .prepare(`
        INSERT INTO runtime_evidence (
          id, task_id, project_id, kind, path, mime_type, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        evidence.id,
        evidence.taskId,
        evidence.projectId,
        evidence.kind,
        evidence.path,
        evidence.mimeType,
        evidence.sizeBytes,
        evidence.createdAt
      )
    return evidence
  }

  listRuntimeEvidence(projectId?: string): RuntimeEvidenceRecord[] {
    const rows = projectId
      ? (this.database
          .prepare(`SELECT ${runtimeEvidenceColumns} FROM runtime_evidence WHERE project_id = ? ORDER BY created_at DESC`)
          .all(projectId) as Row[])
      : (this.database
          .prepare(`SELECT ${runtimeEvidenceColumns} FROM runtime_evidence ORDER BY created_at DESC`)
          .all() as Row[])
    return rows.map(runtimeEvidenceFromRow)
  }

  recoverInterruptedTasks(): TaskRecord[] {
    const interrupted = (
      this.database
        .prepare(`SELECT ${taskColumns} FROM tasks WHERE status IN ('running', 'testing') ORDER BY created_at`)
        .all() as Row[]
    ).map(taskFromRow)

    return interrupted.map((task) => {
      const recovered = this.transitionTask(task.id, 'stopped')
      this.addEvent(
        task.projectId,
        task.id,
        'task_recovered',
        'orchestrator',
        '앱이 다시 시작되어 이전 실행을 안전하게 중단 상태로 복구했습니다.'
      )
      return recovered
    })
  }

  addEvent(
    projectId: string,
    taskId: string | null,
    kind: EventKind,
    actor: string,
    message: string,
    severity: Severity | null = null
  ): EventRecord {
    const now = new Date().toISOString()
    const result = this.database
      .prepare(`
        INSERT INTO events (project_id, task_id, kind, actor, message, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(projectId, taskId, kind, actor, message.slice(0, 8_000), severity, now)
    const row = this.database.prepare(`SELECT ${eventColumns} FROM events WHERE id = ?`).get(result.lastInsertRowid) as Row
    return eventFromRow(row)
  }

  addFinding(
    projectId: string,
    taskId: string | null,
    title: string,
    severity: Severity = 'high'
  ): FindingRecord {
    const finding: FindingRecord = {
      id: randomUUID(),
      projectId,
      taskId,
      title: title.slice(0, 500),
      severity,
      resolved: false,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
    this.database
      .prepare(`
        INSERT INTO findings (id, project_id, task_id, title, severity, resolved, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, NULL)
      `)
      .run(finding.id, projectId, taskId, finding.title, finding.severity, finding.createdAt)
    this.addEvent(projectId, taskId, 'finding_created', 'critic', finding.title, finding.severity)
    return finding
  }

  getFinding(findingId: string): FindingRecord {
    const row = this.database.prepare(`SELECT ${findingColumns} FROM findings WHERE id = ?`).get(findingId) as
      | Row
      | undefined
    if (!row) throw new Error('버그를 찾을 수 없습니다.')
    return findingFromRow(row)
  }

  setFindingResolved(findingId: string, resolved: boolean): FindingRecord {
    const finding = this.getFinding(findingId)
    if (finding.resolved === resolved) return finding
    const resolvedAt = resolved ? new Date().toISOString() : null
    this.database
      .prepare('UPDATE findings SET resolved = ?, resolved_at = ? WHERE id = ?')
      .run(resolved ? 1 : 0, resolvedAt, findingId)
    const updated = this.getFinding(findingId)
    this.addEvent(
      finding.projectId,
      finding.taskId,
      resolved ? 'finding_resolved' : 'finding_reopened',
      'human',
      `${finding.title} ${resolved ? '해결 처리' : '다시 열기'}`,
      finding.severity
    )
    return updated
  }

  resolveTaskFindings(taskId: string): FindingRecord[] {
    const rows = this.database
      .prepare(`SELECT ${findingColumns} FROM findings WHERE task_id = ? AND resolved = 0`)
      .all(taskId) as Row[]
    return rows.map((row) => this.setFindingResolved(findingFromRow(row).id, true))
  }

  addNote(projectId: string, title: string, body: string): NoteRecord {
    const note: NoteRecord = {
      id: randomUUID(),
      projectId,
      title: title.trim(),
      body: body.trim(),
      createdAt: new Date().toISOString()
    }
    this.database
      .prepare('INSERT INTO notes (id, project_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(note.id, projectId, note.title, note.body, note.createdAt)
    this.addEvent(projectId, null, 'note_created', 'human', `${note.title} 메모 작성`)
    return note
  }

  getNote(noteId: string): NoteRecord {
    const row = this.database.prepare(`SELECT ${noteColumns} FROM notes WHERE id = ?`).get(noteId) as Row | undefined
    if (!row) throw new Error('메모를 찾을 수 없습니다.')
    return noteFromRow(row)
  }

  updateNote(noteId: string, title: string, body: string): NoteRecord {
    const note = this.getNote(noteId)
    this.database
      .prepare('UPDATE notes SET title = ?, body = ? WHERE id = ?')
      .run(title.trim(), body.trim(), noteId)
    const updated = this.getNote(noteId)
    this.addEvent(note.projectId, null, 'note_updated', 'human', `${updated.title} 메모 수정`)
    return updated
  }

  deleteNote(noteId: string): NoteRecord {
    const note = this.getNote(noteId)
    this.addEvent(note.projectId, null, 'note_deleted', 'human', `${note.title} 메모 삭제`)
    this.database.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
    return note
  }

  getSnapshot(projectId?: string): DashboardSnapshot {
    const projects = this.listProjects()
    if (projects.length === 0) {
      return {
        projects,
        selectedProject: null,
        tasks: [],
        events: [],
        findings: [],
        notes: [],
        runtimeSessions: [],
        runtimeEvidence: []
      }
    }
    const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0]
    const tasks = this.listTasks(selectedProject.id)
    const events = (
      this.database
        .prepare(`SELECT ${eventColumns} FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT 500`)
        .all(selectedProject.id) as Row[]
    ).map(eventFromRow)
    const findings = (
      this.database
        .prepare(`SELECT ${findingColumns} FROM findings WHERE project_id = ? ORDER BY created_at DESC`)
        .all(selectedProject.id) as Row[]
    ).map(findingFromRow)
    const notes = (
      this.database
        .prepare(`SELECT ${noteColumns} FROM notes WHERE project_id = ? ORDER BY created_at DESC`)
        .all(selectedProject.id) as Row[]
    ).map(noteFromRow)
    const runtimeSessions = this.listRuntimeSessions(selectedProject.id)
    const runtimeEvidence = this.listRuntimeEvidence(selectedProject.id)

    return { projects, selectedProject, tasks, events, findings, notes, runtimeSessions, runtimeEvidence }
  }
}
