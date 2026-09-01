import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  DashboardSnapshot,
  EventKind,
  EventRecord,
  FindingRecord,
  NoteRecord,
  ProjectRecord,
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

export class AppStore {
  readonly database: DatabaseSync

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
    this.seedDemoData()
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

      CREATE INDEX IF NOT EXISTS idx_tasks_project_created
        ON tasks(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_project_created
        ON events(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_project_created
        ON findings(project_id, created_at DESC);
    `)
  }

  private seedDemoData(): void {
    const count = Number((this.database.prepare('SELECT COUNT(*) AS count FROM projects').get() as Row).count)
    if (count > 0) return

    const projectId = randomUUID()
    const secondaryProjectId = randomUUID()
    const now = new Date()
    const iso = now.toISOString()

    this.database.exec('BEGIN')
    try {
      this.database
        .prepare('INSERT INTO projects (id, name, path, test_command, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, 'ElmwoodOnline', `demo://${projectId}`, '', 1, iso)
      this.database
        .prepare('INSERT INTO projects (id, name, path, test_command, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(secondaryProjectId, 'AgentMonitoring', `demo://${secondaryProjectId}`, '', 1, iso)

      const taskStatement = this.database.prepare(`
        INSERT INTO tasks (
          id, project_id, title, prompt, status, provider, max_attempts, attempt,
          branch_name, worktree_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'codex', 3, 1, NULL, NULL, ?, ?)
      `)
      const eventStatement = this.database.prepare(`
        INSERT INTO events (project_id, task_id, kind, actor, message, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      const titles = [
        '프로필 등록 시스템 구축',
        '네트워크 재접속 안정화',
        '맵 데이터 캐시 정리',
        '항로 검색 결과 검증',
        'UI 상태 복원 테스트',
        '로그 수집 파이프라인 개선'
      ]
      for (let index = 0; index < 32; index += 1) {
        const taskId = randomUUID()
        const created = new Date(now)
        created.setDate(now.getDate() - Math.floor((31 - index) / 2))
        created.setHours(9 + (index % 8), (index * 7) % 60, 0, 0)
        const updated = new Date(created.getTime() + (38 + (index % 5) * 12) * 60 * 1000)
        const title = `${titles[index % titles.length]}${index === 31 ? ' — 1단계 C# 파일 변환부터' : ''}`
        taskStatement.run(
          taskId,
          projectId,
          title,
          `${title} 작업을 구현하고 검증한다.`,
          'completed',
          created.toISOString(),
          updated.toISOString()
        )
        eventStatement.run(
          projectId,
          taskId,
          'task_started',
          'codex',
          `${title} 작업 시작`,
          null,
          created.toISOString()
        )
        eventStatement.run(
          projectId,
          taskId,
          'task_completed',
          'codex',
          `${title} 완료 · 테스트와 검토를 통과했습니다.`,
          null,
          updated.toISOString()
        )
      }

      const findingStatement = this.database.prepare(`
        INSERT INTO findings (
          id, project_id, task_id, title, severity, resolved, created_at, resolved_at
        ) VALUES (?, ?, NULL, ?, ?, 1, ?, ?)
      `)
      const severities: Severity[] = ['critical', 'high', 'medium', 'low', 'medium', 'low']
      for (let index = 0; index < 6; index += 1) {
        const created = new Date(now)
        created.setDate(now.getDate() - (12 - index * 2))
        const resolved = new Date(created.getTime() + 24 * 60 * 60 * 1000)
        findingStatement.run(
          randomUUID(),
          projectId,
          `회귀 시나리오 ${index + 1} 실패`,
          severities[index],
          created.toISOString(),
          resolved.toISOString()
        )
        eventStatement.run(
          projectId,
          null,
          'finding_created',
          'critic',
          `회귀 시나리오 ${index + 1} 실패 발견`,
          severities[index],
          created.toISOString()
        )
        eventStatement.run(
          projectId,
          null,
          'finding_resolved',
          'codex',
          `회귀 시나리오 ${index + 1} 해결`,
          severities[index],
          resolved.toISOString()
        )
      }

      const noteStatement = this.database.prepare(
        'INSERT INTO notes (id, project_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (let index = 0; index < 14; index += 1) {
        const created = new Date(now.getTime() - index * 3 * 60 * 60 * 1000)
        noteStatement.run(
          randomUUID(),
          projectId,
          `프로젝트 결정 ${14 - index}`,
          '작업 과정에서 확인한 기준과 후속 검토 항목을 기록했습니다.',
          created.toISOString()
        )
        if (index < 4) {
          eventStatement.run(
            projectId,
            null,
            'note_created',
            'codex',
            `프로젝트 결정 ${14 - index} 메모 작성`,
            null,
            created.toISOString()
          )
        }
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
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

  getSnapshot(projectId?: string): DashboardSnapshot {
    const projects = this.listProjects()
    if (projects.length === 0) throw new Error('등록된 프로젝트가 없습니다.')
    const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0]
    const tasks = (
      this.database
        .prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id = ? ORDER BY created_at DESC`)
        .all(selectedProject.id) as Row[]
    ).map(taskFromRow)
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

    return { projects, selectedProject, tasks, events, findings, notes }
  }
}
