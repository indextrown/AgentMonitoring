import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  ApprovedRuntimeContract,
  DashboardSnapshot,
  EventKind,
  EventRecord,
  FindingRecord,
  NoteRecord,
  ProjectRecord,
  ProjectRuntimeEnvironmentEntry,
  RuntimeEvidenceRecord,
  RuntimeArtifactRetentionDays,
  RuntimeSessionRecord,
  RuntimeSessionStatus,
  Severity,
  TaskRecord,
  TaskStatus,
  TaskTechSpec,
  TaskTechSpecDraft,
  TaskVerificationPlan,
  TaskVerificationResult,
  UpdateProjectInput
} from '../../src/shared/types'
import { assertTransition, createVerificationResult } from '../../src/shared/domain'

type Row = Record<string, unknown>

const projectColumns = `
  id,
  name,
  path,
  test_command AS testCommand,
  setup_command AS setupCommand,
  runtime_adapter_json AS runtimeAdapterJson,
  runtime_config_source AS runtimeConfigSource,
  publish_strategy AS publishStrategy,
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
  source_branch AS sourceBranch,
  base_commit AS baseCommit,
  verification_base_commit AS verificationBaseCommit,
  publish_strategy AS publishStrategy,
  publication_json AS publicationJson,
  runtime_contract_json AS runtimeContractJson,
  runtime_scenario_summary AS runtimeScenarioSummary,
  runtime_scenario_approved_at AS runtimeScenarioApprovedAt,
  tech_spec_json AS techSpecJson,
  verification_plan_json AS verificationPlanJson,
  verification_result_json AS verificationResultJson,
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
  run_id AS runId,
  attempt,
  kind,
  outcome,
  summary,
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
    setupCommand: String(row.setupCommand ?? ''),
    runtimeAdapter: row.runtimeAdapterJson
      ? JSON.parse(String(row.runtimeAdapterJson)) as ProjectRecord['runtimeAdapter']
      : null,
    runtimeConfigSource: row.runtimeConfigSource
      ? String(row.runtimeConfigSource) as ProjectRecord['runtimeConfigSource']
      : null,
    publishStrategy: row.publishStrategy === 'direct' ? 'direct' : 'pull-request',
    isDemo: Boolean(row.isDemo),
    createdAt: String(row.createdAt)
  }
}

function taskFromRow(row: Row): TaskRecord {
  const verificationPlan = row.verificationPlanJson
    ? JSON.parse(String(row.verificationPlanJson)) as TaskVerificationPlan
    : null
  const persistedVerificationResult = row.verificationResultJson
    ? JSON.parse(String(row.verificationResultJson)) as Partial<TaskVerificationResult>
    : null
  const verificationResult = persistedVerificationResult
    ? {
        environmentSetup: persistedVerificationResult.environmentSetup ?? {
          status: 'skipped' as const,
          message: '환경 준비 단계가 추가되기 전에 생성된 작업입니다.',
          updatedAt: String(row.updatedAt)
        },
        testDesign: persistedVerificationResult.testDesign!,
        projectTests: persistedVerificationResult.projectTests!,
        simulatorRuntime: persistedVerificationResult.simulatorRuntime!,
        reviewer: persistedVerificationResult.reviewer!
      }
    : null
  const persistedPublication = row.publicationJson
    ? JSON.parse(String(row.publicationJson)) as Partial<NonNullable<TaskRecord['publication']>>
    : null
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
    sourceBranch: row.sourceBranch ? String(row.sourceBranch) : null,
    baseCommit: row.baseCommit ? String(row.baseCommit) : null,
    verificationBaseCommit: row.verificationBaseCommit
      ? String(row.verificationBaseCommit)
      : row.baseCommit
        ? String(row.baseCommit)
        : null,
    publishStrategy: row.publishStrategy === 'direct' ? 'direct' : 'pull-request',
    publication: persistedPublication
      ? {
          ...persistedPublication,
          mergeCommit: persistedPublication.mergeCommit ?? null
        } as NonNullable<TaskRecord['publication']>
      : null,
    runtimeContract: row.runtimeContractJson
      ? JSON.parse(String(row.runtimeContractJson)) as ApprovedRuntimeContract
      : null,
    runtimeScenarioSummary: row.runtimeScenarioSummary ? String(row.runtimeScenarioSummary) : null,
    runtimeScenarioApprovedAt: row.runtimeScenarioApprovedAt
      ? String(row.runtimeScenarioApprovedAt)
      : null,
    techSpec: row.techSpecJson
      ? JSON.parse(String(row.techSpecJson)) as TaskTechSpec
      : null,
    verificationPlan,
    verificationResult,
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
    runId: String(row.runId),
    attempt: Math.max(1, Number(row.attempt) || 1),
    kind: String(row.kind) as RuntimeEvidenceRecord['kind'],
    outcome: String(row.outcome) as RuntimeEvidenceRecord['outcome'],
    summary: row.summary ? String(row.summary) : null,
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
        setup_command TEXT NOT NULL DEFAULT '',
        runtime_adapter_json TEXT,
        runtime_config_source TEXT,
        publish_strategy TEXT NOT NULL DEFAULT 'pull-request',
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
        source_branch TEXT,
        base_commit TEXT,
        verification_base_commit TEXT,
        publish_strategy TEXT NOT NULL DEFAULT 'pull-request',
        publication_json TEXT,
        runtime_contract_json TEXT,
        runtime_scenario_summary TEXT,
        runtime_scenario_approved_at TEXT,
        tech_spec_json TEXT,
        verification_plan_json TEXT,
        verification_result_json TEXT,
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
        run_id TEXT NOT NULL DEFAULT 'legacy',
        attempt INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'captured',
        summary TEXT,
        path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_runtime_environment (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        scope TEXT NOT NULL,
        build_setting TEXT,
        launch_variable TEXT,
        encrypted_value BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, key)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_project_runtime_environment_project
        ON project_runtime_environment(project_id, updated_at DESC);
    `)

    const projectColumnNames = new Set(
      (this.database.prepare('PRAGMA table_info(projects)').all() as Row[]).map((row) => String(row.name))
    )
    if (!projectColumnNames.has('runtime_adapter_json')) {
      this.database.exec('ALTER TABLE projects ADD COLUMN runtime_adapter_json TEXT')
    }
    if (!projectColumnNames.has('setup_command')) {
      this.database.exec("ALTER TABLE projects ADD COLUMN setup_command TEXT NOT NULL DEFAULT ''")
    }
    if (!projectColumnNames.has('runtime_config_source')) {
      this.database.exec('ALTER TABLE projects ADD COLUMN runtime_config_source TEXT')
    }
    if (!projectColumnNames.has('publish_strategy')) {
      this.database.exec("ALTER TABLE projects ADD COLUMN publish_strategy TEXT NOT NULL DEFAULT 'pull-request'")
    }

    const taskColumnNames = new Set(
      (this.database.prepare('PRAGMA table_info(tasks)').all() as Row[]).map((row) => String(row.name))
    )
    if (!taskColumnNames.has('runtime_contract_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN runtime_contract_json TEXT')
    }
    if (!taskColumnNames.has('runtime_scenario_summary')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN runtime_scenario_summary TEXT')
    }
    if (!taskColumnNames.has('runtime_scenario_approved_at')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN runtime_scenario_approved_at TEXT')
    }
    if (!taskColumnNames.has('verification_plan_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN verification_plan_json TEXT')
    }
    if (!taskColumnNames.has('tech_spec_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN tech_spec_json TEXT')
    }
    if (!taskColumnNames.has('verification_result_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN verification_result_json TEXT')
    }
    if (!taskColumnNames.has('source_branch')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN source_branch TEXT')
    }
    if (!taskColumnNames.has('base_commit')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN base_commit TEXT')
    }
    if (!taskColumnNames.has('verification_base_commit')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN verification_base_commit TEXT')
    }
    if (!taskColumnNames.has('publish_strategy')) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN publish_strategy TEXT NOT NULL DEFAULT 'pull-request'")
    }
    if (!taskColumnNames.has('publication_json')) {
      this.database.exec('ALTER TABLE tasks ADD COLUMN publication_json TEXT')
    }

    const runtimeEvidenceColumnNames = new Set(
      (this.database.prepare('PRAGMA table_info(runtime_evidence)').all() as Row[]).map((row) =>
        String(row.name)
      )
    )
    if (!runtimeEvidenceColumnNames.has('run_id')) {
      this.database.exec("ALTER TABLE runtime_evidence ADD COLUMN run_id TEXT NOT NULL DEFAULT 'legacy'")
    }
    if (!runtimeEvidenceColumnNames.has('attempt')) {
      this.database.exec('ALTER TABLE runtime_evidence ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1')
    }
    if (!runtimeEvidenceColumnNames.has('outcome')) {
      this.database.exec("ALTER TABLE runtime_evidence ADD COLUMN outcome TEXT NOT NULL DEFAULT 'captured'")
    }
    if (!runtimeEvidenceColumnNames.has('summary')) {
      this.database.exec('ALTER TABLE runtime_evidence ADD COLUMN summary TEXT')
    }
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
      setupCommand: '',
      runtimeAdapter: null,
      runtimeConfigSource: null,
      publishStrategy: 'pull-request',
      isDemo: false,
      createdAt: new Date().toISOString()
    }
    this.database
      .prepare(`
        INSERT INTO projects (
          id, name, path, test_command, setup_command, runtime_adapter_json, runtime_config_source,
          publish_strategy, is_demo, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pull-request', 0, ?)
      `)
      .run(project.id, project.name, project.path, project.testCommand, project.setupCommand, project.createdAt)
    this.addEvent(project.id, null, 'project_created', 'human', `${project.name} 프로젝트 등록`)
    return project
  }

  updateProject(input: UpdateProjectInput): ProjectRecord {
    const existing = this.getProject(input.projectId)
    const runtimeAdapter = input.runtimeAdapter === undefined
      ? existing.runtimeAdapter ?? null
      : input.runtimeAdapter
    const runtimeConfigSource = input.runtimeAdapter === undefined
      ? existing.runtimeConfigSource ?? null
      : runtimeAdapter
        ? existing.runtimeConfigSource === 'manifest' &&
            JSON.stringify(existing.runtimeAdapter) === JSON.stringify(runtimeAdapter)
          ? 'manifest'
          : 'detected'
        : null
    this.database
      .prepare(`
        UPDATE projects
        SET name = ?, test_command = ?, setup_command = ?, runtime_adapter_json = ?, runtime_config_source = ?,
            publish_strategy = ?
        WHERE id = ?
      `)
      .run(
        input.name.trim(),
        input.testCommand.trim(),
        input.setupCommand.trim(),
        runtimeAdapter ? JSON.stringify(runtimeAdapter) : null,
        runtimeConfigSource,
        input.publishStrategy ?? existing.publishStrategy ?? 'pull-request',
        input.projectId
      )
    return this.getProject(input.projectId)
  }

  setProjectSetupCommand(projectId: string, setupCommand: string): ProjectRecord {
    this.database
      .prepare('UPDATE projects SET setup_command = ? WHERE id = ?')
      .run(setupCommand.trim(), projectId)
    return this.getProject(projectId)
  }

  setProjectRuntimeAdapter(
    projectId: string,
    runtimeAdapter: ProjectRecord['runtimeAdapter'],
    source: ProjectRecord['runtimeConfigSource']
  ): ProjectRecord {
    this.database
      .prepare(`
        UPDATE projects
        SET runtime_adapter_json = $runtimeAdapter, runtime_config_source = $source
        WHERE id = $projectId
      `)
      .run({
        runtimeAdapter: runtimeAdapter ? JSON.stringify(runtimeAdapter) : null,
        source: source ?? null,
        projectId
      })
    return this.getProject(projectId)
  }

  listProjectRuntimeEnvironment(projectId: string): ProjectRuntimeEnvironmentEntry[] {
    this.getProject(projectId)
    const rows = this.database.prepare(`
      SELECT id, project_id AS projectId, key, label, scope,
             build_setting AS buildSetting, launch_variable AS launchVariable,
             encrypted_value AS encryptedValue, updated_at AS updatedAt
      FROM project_runtime_environment
      WHERE project_id = ?
      ORDER BY created_at, key
    `).all(projectId) as Row[]
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.projectId),
      key: String(row.key),
      label: String(row.label),
      scope: String(row.scope) as ProjectRuntimeEnvironmentEntry['scope'],
      buildSetting: row.buildSetting ? String(row.buildSetting) : null,
      launchVariable: row.launchVariable ? String(row.launchVariable) : null,
      configured: row.encryptedValue instanceof Uint8Array && row.encryptedValue.byteLength > 0,
      updatedAt: String(row.updatedAt)
    }))
  }

  getProjectRuntimeEnvironmentSecret(
    projectId: string,
    key: string
  ): { entry: ProjectRuntimeEnvironmentEntry; encryptedValue: Buffer | null } | null {
    const row = this.database.prepare(`
      SELECT id, project_id AS projectId, key, label, scope,
             build_setting AS buildSetting, launch_variable AS launchVariable,
             encrypted_value AS encryptedValue, updated_at AS updatedAt
      FROM project_runtime_environment
      WHERE project_id = ? AND key = ?
    `).get(projectId, key) as Row | undefined
    if (!row) return null
    const encryptedValue = row.encryptedValue instanceof Uint8Array
      ? Buffer.from(row.encryptedValue)
      : null
    return {
      entry: {
        id: String(row.id),
        projectId: String(row.projectId),
        key: String(row.key),
        label: String(row.label),
        scope: String(row.scope) as ProjectRuntimeEnvironmentEntry['scope'],
        buildSetting: row.buildSetting ? String(row.buildSetting) : null,
        launchVariable: row.launchVariable ? String(row.launchVariable) : null,
        configured: Boolean(encryptedValue?.byteLength),
        updatedAt: String(row.updatedAt)
      },
      encryptedValue
    }
  }

  upsertProjectRuntimeEnvironment(input: {
    projectId: string
    id?: string
    key: string
    label: string
    scope: ProjectRuntimeEnvironmentEntry['scope']
    buildSetting: string | null
    launchVariable: string | null
    encryptedValue?: Buffer
  }): ProjectRuntimeEnvironmentEntry[] {
    this.getProject(input.projectId)
    const existing = input.id
      ? this.database.prepare('SELECT id, encrypted_value AS encryptedValue FROM project_runtime_environment WHERE id = ? AND project_id = ?').get(input.id, input.projectId) as Row | undefined
      : this.database.prepare('SELECT id, encrypted_value AS encryptedValue FROM project_runtime_environment WHERE project_id = ? AND key = ?').get(input.projectId, input.key) as Row | undefined
    const id = existing ? String(existing.id) : randomUUID()
    const now = new Date().toISOString()
    const encryptedValue = input.encryptedValue ?? (
      existing?.encryptedValue instanceof Uint8Array ? Buffer.from(existing.encryptedValue) : null
    )
    this.database.prepare(`
      INSERT INTO project_runtime_environment (
        id, project_id, key, label, scope, build_setting, launch_variable,
        encrypted_value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key = excluded.key,
        label = excluded.label,
        scope = excluded.scope,
        build_setting = excluded.build_setting,
        launch_variable = excluded.launch_variable,
        encrypted_value = excluded.encrypted_value,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.projectId,
      input.key,
      input.label,
      input.scope,
      input.buildSetting,
      input.launchVariable,
      encryptedValue,
      now,
      now
    )
    return this.listProjectRuntimeEnvironment(input.projectId)
  }

  deleteProjectRuntimeEnvironment(projectId: string, id: string): ProjectRuntimeEnvironmentEntry[] {
    this.database.prepare('DELETE FROM project_runtime_environment WHERE id = ? AND project_id = ?').run(id, projectId)
    return this.listProjectRuntimeEnvironment(projectId)
  }

  deleteProject(projectId: string): ProjectRecord {
    const project = this.getProject(projectId)
    this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    return project
  }

  createTask(
    projectId: string,
    title: string,
    prompt: string,
    maxAttempts: number,
    runtimeContract: ApprovedRuntimeContract | null = null,
    runtimeScenarioSummary: string | null = null,
    verificationPlan: TaskVerificationPlan | null = null,
    publishStrategy?: TaskRecord['publishStrategy'],
    techSpec: TaskTechSpecDraft | null = null
  ): TaskRecord {
    const project = this.getProject(projectId)
    const resolvedPublishStrategy = publishStrategy ?? project.publishStrategy ?? 'pull-request'
    const now = new Date().toISOString()
    const approvedTechSpec: TaskTechSpec | null = techSpec
      ? { ...techSpec, approvedAt: now }
      : null
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
      sourceBranch: null,
      baseCommit: null,
      verificationBaseCommit: null,
      publishStrategy: resolvedPublishStrategy,
      publication: null,
      runtimeContract,
      runtimeScenarioSummary: runtimeScenarioSummary?.trim() || null,
      runtimeScenarioApprovedAt: runtimeContract ? now : null,
      techSpec: approvedTechSpec,
      verificationPlan,
      verificationResult: verificationPlan ? createVerificationResult(verificationPlan, now) : null,
      createdAt: now,
      updatedAt: now
    }
    this.database
      .prepare(`
        INSERT INTO tasks (
          id, project_id, title, prompt, status, provider, max_attempts, attempt,
          branch_name, worktree_path, source_branch, base_commit, verification_base_commit,
          publish_strategy, publication_json,
          runtime_contract_json, runtime_scenario_summary,
          runtime_scenario_approved_at, tech_spec_json, verification_plan_json, verification_result_json,
          created_at, updated_at
        ) VALUES (
          $id, $projectId, $title, $prompt, $status, 'codex', $maxAttempts, 0,
          NULL, NULL, NULL, NULL, NULL, $publishStrategy, NULL, $runtimeContract, $runtimeScenarioSummary,
          $runtimeScenarioApprovedAt, $techSpec, $verificationPlan, $verificationResult,
          $createdAt, $updatedAt
        )
      `)
      .run({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        prompt: task.prompt,
        status: task.status,
        maxAttempts: task.maxAttempts,
        publishStrategy: resolvedPublishStrategy,
        runtimeContract: runtimeContract ? JSON.stringify(runtimeContract) : null,
        runtimeScenarioSummary: task.runtimeScenarioSummary ?? null,
        runtimeScenarioApprovedAt: task.runtimeScenarioApprovedAt ?? null,
        techSpec: approvedTechSpec ? JSON.stringify(approvedTechSpec) : null,
        verificationPlan: verificationPlan ? JSON.stringify(verificationPlan) : null,
        verificationResult: task.verificationResult ? JSON.stringify(task.verificationResult) : null,
        createdAt: now,
        updatedAt: now
      })
    this.addEvent(projectId, task.id, 'task_created', 'human', `${task.title} 작업 등록`)
    return task
  }

  getTask(taskId: string): TaskRecord {
    const row = this.database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`).get(taskId) as Row | undefined
    if (!row) throw new Error('작업을 찾을 수 없습니다.')
    return taskFromRow(row)
  }

  replaceTaskRuntimeContract(
    taskId: string,
    runtimeContract: ApprovedRuntimeContract,
    runtimeScenarioSummary: string
  ): TaskRecord {
    const task = this.getTask(taskId)
    if (!['failed', 'stopped', 'blocked_environment'].includes(task.status)) {
      throw new Error('실패·중단·환경 확인 상태의 작업만 검증 시나리오를 최신화할 수 있습니다.')
    }
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE tasks
      SET runtime_contract_json = ?, runtime_scenario_summary = ?,
          runtime_scenario_approved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(runtimeContract),
      runtimeScenarioSummary.trim(),
      now,
      now,
      taskId
    )
    this.addEvent(
      task.projectId,
      taskId,
      'agent',
      'orchestrator',
      '기존 단일 시점 Simulator 계약을 케이스·체크포인트 기반 최신 시나리오로 교체했습니다.'
    )
    return this.getTask(taskId)
  }

  listTasks(projectId: string): TaskRecord[] {
    return (
      this.database
        .prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id = ? ORDER BY created_at DESC`)
        .all(projectId) as Row[]
    ).map(taskFromRow)
  }

  listAllTasks(): TaskRecord[] {
    return (
      this.database
        .prepare(`SELECT ${taskColumns} FROM tasks ORDER BY created_at DESC`)
        .all() as Row[]
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

  setTaskVerificationResult(taskId: string, result: TaskVerificationResult): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET verification_result_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(result), now, taskId)
    return this.getTask(taskId)
  }

  setTaskPublication(taskId: string, publication: NonNullable<TaskRecord['publication']>): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET publication_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(publication), now, taskId)
    return this.getTask(taskId)
  }

  setTaskPublishStrategy(taskId: string, publishStrategy: NonNullable<TaskRecord['publishStrategy']>): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET publish_strategy = ?, publication_json = NULL, updated_at = ? WHERE id = ?')
      .run(publishStrategy, now, taskId)
    return this.getTask(taskId)
  }

  setTaskWorkspace(
    taskId: string,
    branchName: string,
    worktreePath: string,
    sourceBranch: string | null = null,
    baseCommit: string | null = null
  ): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare(`
        UPDATE tasks
        SET branch_name = ?, worktree_path = ?, source_branch = ?, base_commit = ?,
            verification_base_commit = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(branchName, worktreePath, sourceBranch, baseCommit, baseCommit, now, taskId)
    return this.getTask(taskId)
  }

  setTaskVerificationBaseCommit(taskId: string, verificationBaseCommit: string): TaskRecord {
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE tasks SET verification_base_commit = ?, updated_at = ? WHERE id = ?')
      .run(verificationBaseCommit, now, taskId)
    return this.getTask(taskId)
  }

  clearTaskWorktree(taskId: string): TaskRecord {
    this.database
      .prepare('UPDATE tasks SET worktree_path = NULL WHERE id = ?')
      .run(taskId)
    return this.getTask(taskId)
  }

  clearTaskBranch(taskId: string): TaskRecord {
    this.database
      .prepare('UPDATE tasks SET branch_name = NULL WHERE id = ?')
      .run(taskId)
    return this.getTask(taskId)
  }

  getRuntimeArtifactRetentionDays(): RuntimeArtifactRetentionDays {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = 'runtime_artifact_retention_days'")
      .get() as Row | undefined
    const value = Number(row?.value ?? 30)
    return ([0, 7, 30, 90] as const).includes(value as RuntimeArtifactRetentionDays)
      ? value as RuntimeArtifactRetentionDays
      : 30
  }

  setRuntimeArtifactRetentionDays(days: RuntimeArtifactRetentionDays): RuntimeArtifactRetentionDays {
    this.database
      .prepare(`
        INSERT INTO app_settings (key, value) VALUES ('runtime_artifact_retention_days', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(String(days))
    return this.getRuntimeArtifactRetentionDays()
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
    input: Pick<RuntimeEvidenceRecord, 'kind' | 'path' | 'mimeType' | 'sizeBytes' | 'createdAt'> &
      Partial<Pick<RuntimeEvidenceRecord, 'runId' | 'outcome' | 'summary'>>
  ): RuntimeEvidenceRecord {
    const task = this.getTask(taskId)
    const evidence: RuntimeEvidenceRecord = {
      id: randomUUID(),
      taskId,
      projectId: task.projectId,
      runId: input.runId ?? 'legacy',
      attempt: Math.max(1, task.attempt),
      outcome: input.outcome ?? 'captured',
      summary: input.summary?.trim().slice(0, 1_000) || null,
      kind: input.kind,
      path: input.path,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      createdAt: input.createdAt
    }
    this.database
      .prepare(`
        INSERT INTO runtime_evidence (
          id, task_id, project_id, run_id, attempt, kind, outcome, summary,
          path, mime_type, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        evidence.id,
        evidence.taskId,
        evidence.projectId,
        evidence.runId,
        evidence.attempt,
        evidence.kind,
        evidence.outcome,
        evidence.summary,
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

  deleteRuntimeData(taskId: string): void {
    this.database.exec('BEGIN')
    try {
      this.database.prepare('DELETE FROM runtime_evidence WHERE task_id = ?').run(taskId)
      this.database.prepare('DELETE FROM runtime_sessions WHERE task_id = ?').run(taskId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
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

  latestTaskEvent(
    taskId: string,
    kind: EventKind
  ): EventRecord | null {
    const row = this.database
      .prepare(`SELECT ${eventColumns} FROM events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
      .get(taskId, kind) as Row | undefined
    return row ? eventFromRow(row) : null
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

  listTaskFindings(
    taskId: string,
    resolved = false
  ): FindingRecord[] {
    const rows = this.database
      .prepare(`SELECT ${findingColumns} FROM findings WHERE task_id = ? AND resolved = ? ORDER BY created_at ASC`)
      .all(taskId, resolved ? 1 : 0) as Row[]
    return rows.map(findingFromRow)
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
