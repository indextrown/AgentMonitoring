import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../electron/main/store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('AppStore', () => {
  it('starts with an empty workspace and persists user records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)

    const initial = store.getSnapshot()
    expect(initial.projects).toEqual([])
    expect(initial.selectedProject).toBeNull()
    expect(initial.tasks).toEqual([])
    expect(initial.events).toEqual([])
    expect(initial.runtimeEvidence).toEqual([])

    const project = store.addProject('Fixture', join(directory, 'fixture'))
    store.updateProject({
      projectId: project.id,
      name: project.name,
      setupCommand: 'tuist install',
      testCommand: 'tuist test'
    })
    const task = store.createTask(
      project.id,
      '테스트 작업',
      '테스트 작업의 완료 조건을 검증한다.',
      3,
      null,
      null,
      { version: 1, mode: 'project-tests', testDesign: 'swift-testing', runtimeSource: 'off' }
    )
    expect(task.status).toBe('queued')

    store.transitionTask(task.id, 'running', 1)
    store.transitionTask(task.id, 'awaiting_approval')
    store.transitionTask(task.id, 'completed')
    store.addNote(project.id, '결정', '승인 경계를 유지한다.')
    store.close()

    const reopened = new AppStore(databasePath)
    const snapshot = reopened.getSnapshot(project.id)
    expect(snapshot.selectedProject?.id).toBe(project.id)
    expect(snapshot.selectedProject).toMatchObject({
      setupCommand: 'tuist install',
      testCommand: 'tuist test'
    })
    expect(snapshot.tasks[0].status).toBe('completed')
    expect(snapshot.tasks[0].verificationPlan).toEqual({
      version: 1,
      mode: 'project-tests',
      testDesign: 'swift-testing',
      runtimeSource: 'off'
    })
    expect(snapshot.tasks[0].verificationResult).toMatchObject({
      environmentSetup: { status: 'pending' },
      testDesign: { status: 'pending' },
      projectTests: { status: 'pending' },
      simulatorRuntime: { status: 'skipped' },
      reviewer: { status: 'pending' }
    })
    expect(snapshot.notes[0].title).toBe('결정')
    reopened.close()
  })

  it('removes only legacy demo projects when reopening the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const realProject = store.addProject('Real project', join(directory, 'real-project'))
    const demoProjectId = '11111111-1111-4111-8111-111111111111'
    store.database
      .prepare('INSERT INTO projects (id, name, path, test_command, is_demo, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(demoProjectId, 'Legacy demo', `demo://${demoProjectId}`, '', new Date().toISOString())
    store.createTask(demoProjectId, '예전 데모 작업', '삭제되어야 하는 예전 데모 작업이다.', 1)
    store.close()

    const reopened = new AppStore(databasePath)
    const snapshot = reopened.getSnapshot()
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.selectedProject?.id).toBe(realProject.id)
    expect(snapshot.tasks).toEqual([])
    expect(() => reopened.getProject(demoProjectId)).toThrow('프로젝트를 찾을 수 없습니다.')
    reopened.close()
  })

  it('adds a readable environment step to verification results created by an older version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Legacy project', join(directory, 'legacy-project'))
    const task = store.createTask(
      project.id,
      '기존 작업',
      '환경 준비 단계가 추가되기 전에 만든 작업이다.',
      1,
      null,
      null,
      { version: 1, mode: 'project-tests', testDesign: 'existing-tests', runtimeSource: 'off' }
    )
    const timestamp = new Date().toISOString()
    const legacyResult = {
      testDesign: { status: 'skipped', message: '기존 테스트 사용', updatedAt: timestamp },
      projectTests: { status: 'passed', message: '통과', updatedAt: timestamp },
      simulatorRuntime: { status: 'skipped', message: '사용 안 함', updatedAt: timestamp },
      reviewer: { status: 'passed', message: '통과', updatedAt: timestamp }
    }
    store.database
      .prepare('UPDATE tasks SET verification_result_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyResult), task.id)
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getTask(task.id).verificationResult?.environmentSetup).toMatchObject({
      status: 'skipped',
      message: '환경 준비 단계가 추가되기 전에 생성된 작업입니다.'
    })
    reopened.close()
  })

  it('recovers interrupted tasks and manages findings, notes, and project records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const store = new AppStore(join(directory, 'test.sqlite'))
    const project = store.addProject('Managed project', join(directory, 'managed-project'))
    const running = store.createTask(project.id, '실행 중 작업', '재시작 시 중단 상태로 복구되어야 한다.', 2)
    const testing = store.createTask(project.id, '테스트 중 작업', '테스트 도중 재시작도 복구되어야 한다.', 2)
    const queued = store.createTask(project.id, '대기 작업', '대기 상태는 그대로 유지되어야 한다.', 2)
    store.transitionTask(running.id, 'running', 1)
    store.transitionTask(testing.id, 'running', 1)
    store.transitionTask(testing.id, 'testing', 1)

    const recovered = store.recoverInterruptedTasks()
    expect(new Set(recovered.map((task) => task.id))).toEqual(new Set([running.id, testing.id]))
    expect(store.getTask(running.id).status).toBe('stopped')
    expect(store.getTask(testing.id).status).toBe('stopped')
    expect(store.getTask(queued.id).status).toBe('queued')
    expect(store.getSnapshot(project.id).events.filter((event) => event.kind === 'task_recovered')).toHaveLength(2)

    const finding = store.addFinding(project.id, running.id, '경계 조건이 누락됨', 'medium')
    expect(store.setFindingResolved(finding.id, true).resolved).toBe(true)
    expect(store.setFindingResolved(finding.id, false).resolved).toBe(false)

    const note = store.addNote(project.id, '초안', '처음 기록')
    expect(store.updateNote(note.id, '결정', '수정된 기록')).toMatchObject({ title: '결정', body: '수정된 기록' })
    expect(store.deleteNote(note.id).id).toBe(note.id)
    expect(store.getSnapshot(project.id).notes).toEqual([])

    store.deleteProject(project.id)
    expect(store.getSnapshot().projects).toEqual([])
    expect(() => store.getTask(running.id)).toThrow('작업을 찾을 수 없습니다.')
    store.close()
  })

  it('persists task runtime sessions and recovers active sessions as stopped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Swift project', join(directory, 'swift-project'))
    const task = store.createTask(project.id, 'Swift 실행', 'iPad Simulator에서 앱을 실행한다.', 2)

    store.setRuntimeSession(task.id, 'preparing', { message: 'runtime 준비 중' })
    store.setRuntimeSession(task.id, 'running', {
      deviceId: 'IPAD-UDID',
      deviceName: 'iPad Pro 13-inch',
      bundleIdentifier: 'com.example.App',
      processId: 4242,
      message: '앱 실행 완료'
    })
    store.addRuntimeEvidence(task.id, {
      kind: 'screen',
      path: join(directory, 'runtime-sessions', task.id, 'evidence', 'screen.png'),
      mimeType: 'image/png',
      sizeBytes: 1_024,
      createdAt: new Date().toISOString()
    })
    store.addRuntimeEvidence(task.id, {
      kind: 'accessibility',
      path: join(directory, 'runtime-sessions', task.id, 'evidence', 'accessibility.json'),
      mimeType: 'application/json',
      sizeBytes: 2_048,
      createdAt: new Date(Date.now() + 1_000).toISOString()
    })
    store.addRuntimeEvidence(task.id, {
      kind: 'ui-actions',
      path: join(directory, 'runtime-sessions', task.id, 'evidence', 'ui-actions.json'),
      mimeType: 'application/json',
      sizeBytes: 3_072,
      createdAt: new Date(Date.now() + 2_000).toISOString()
    })
    store.addRuntimeEvidence(task.id, {
      kind: 'debug-state',
      path: join(directory, 'runtime-sessions', task.id, 'evidence', 'debug-state.json'),
      mimeType: 'application/json',
      sizeBytes: 4_096,
      createdAt: new Date(Date.now() + 3_000).toISOString()
    })
    store.addRuntimeEvidence(task.id, {
      runId: 'runtime-run-1',
      kind: 'runtime-verification',
      outcome: 'passed',
      summary: 'runtime acceptance 3/3 통과',
      path: join(directory, 'runtime-sessions', task.id, 'evidence', 'runtime-verification.json'),
      mimeType: 'application/json',
      sizeBytes: 5_120,
      createdAt: new Date(Date.now() + 4_000).toISOString()
    })
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getSnapshot(project.id).runtimeSessions).toMatchObject([
      {
        taskId: task.id,
        status: 'running',
        deviceId: 'IPAD-UDID',
        bundleIdentifier: 'com.example.App',
        processId: 4242
      }
    ])
    expect(reopened.getSnapshot(project.id).runtimeEvidence).toMatchObject([
      {
        taskId: task.id,
        runId: 'runtime-run-1',
        attempt: 1,
        kind: 'runtime-verification',
        outcome: 'passed',
        summary: 'runtime acceptance 3/3 통과',
        mimeType: 'application/json',
        sizeBytes: 5_120
      },
      {
        taskId: task.id,
        runId: 'legacy',
        attempt: 1,
        kind: 'debug-state',
        outcome: 'captured',
        mimeType: 'application/json',
        sizeBytes: 4_096
      },
      {
        taskId: task.id,
        kind: 'ui-actions',
        mimeType: 'application/json',
        sizeBytes: 3_072
      },
      {
        taskId: task.id,
        kind: 'accessibility',
        mimeType: 'application/json',
        sizeBytes: 2_048
      },
      {
        taskId: task.id,
        kind: 'screen',
        mimeType: 'image/png',
        sizeBytes: 1_024
      }
    ])

    const recovered = reopened.recoverInterruptedRuntimeSessions()
    expect(recovered).toHaveLength(1)
    expect(reopened.getRuntimeSession(task.id)).toMatchObject({
      status: 'stopped',
      processId: null
    })
    expect(reopened.getSnapshot(project.id).events.some((event) => event.kind === 'runtime_stopped')).toBe(true)
    reopened.close()
  })

  it('persists storage retention and clears task-owned runtime metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Storage project', join(directory, 'storage-project'))
    const task = store.createTask(project.id, '저장 공간 정리', '작업별 실행 기록을 안전하게 정리한다.', 1)

    expect(store.getRuntimeArtifactRetentionDays()).toBe(30)
    expect(store.setRuntimeArtifactRetentionDays(7)).toBe(7)
    expect(store.listAllTasks().map((item) => item.id)).toContain(task.id)

    store.setTaskWorkspace(task.id, 'agentmonitor/storage-test', join(directory, 'worktrees', task.id))
    store.setRuntimeSession(task.id, 'stopped', { message: '정리 대기' })
    store.addRuntimeEvidence(task.id, {
      kind: 'screen',
      path: join(directory, 'runtime-sessions', task.id, 'screen.png'),
      mimeType: 'image/png',
      sizeBytes: 12,
      createdAt: new Date().toISOString()
    })
    store.deleteRuntimeData(task.id)
    expect(store.getRuntimeSession(task.id)).toBeNull()
    expect(store.listRuntimeEvidence(project.id)).toEqual([])
    expect(store.clearTaskWorktree(task.id).worktreePath).toBeNull()
    expect(store.clearTaskBranch(task.id).branchName).toBeNull()
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getRuntimeArtifactRetentionDays()).toBe(7)
    reopened.close()
  })

  it('adds runtime report columns to databases created before report metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'legacy.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE runtime_evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO runtime_evidence (
        id, task_id, project_id, kind, path, mime_type, size_bytes, created_at
      ) VALUES (
        'legacy-evidence', 'legacy-task', 'legacy-project', 'screen',
        '/tmp/legacy-screen.png', 'image/png', 100, '2026-09-03T00:00:00.000Z'
      );
    `)
    legacy.close()

    const store = new AppStore(databasePath)
    const columns = store.database
      .prepare('PRAGMA table_info(runtime_evidence)')
      .all()
      .map((row) => String((row as Record<string, unknown>).name))
    expect(columns).toEqual(
      expect.arrayContaining(['run_id', 'attempt', 'outcome', 'summary'])
    )
    expect(store.listRuntimeEvidence()).toMatchObject([
      {
        id: 'legacy-evidence',
        runId: 'legacy',
        attempt: 1,
        outcome: 'captured',
        summary: null
      }
    ])
    store.close()
  })
})
