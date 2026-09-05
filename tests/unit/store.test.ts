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
  it('persists project model profiles and immutable task model plans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-model-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Model fixture', join(directory, 'model-fixture'))
    const modelProfile = {
      version: 1 as const,
      mode: 'role-based' as const,
      selection: { model: 'gpt-default', reasoningEffort: 'medium' as const },
      roleSelections: { reviewer: { model: 'gpt-review', reasoningEffort: 'high' as const } }
    }
    store.updateProject({
      projectId: project.id,
      name: project.name,
      setupCommand: '',
      testCommand: '',
      modelProfile
    })
    const modelPlan = {
      version: 1 as const,
      source: 'project' as const,
      resolvedAt: '2026-09-05T00:00:00.000Z',
      roles: {
        planning: { model: 'gpt-default', reasoningEffort: 'medium' as const },
        'test-designer': { model: 'gpt-default', reasoningEffort: 'medium' as const },
        critic: { model: 'gpt-default', reasoningEffort: 'medium' as const },
        implementer: { model: 'gpt-default', reasoningEffort: 'medium' as const },
        reviewer: { model: 'gpt-review', reasoningEffort: 'high' as const }
      }
    }
    const task = store.createTask(project.id, '모델 고정', '선택한 모델을 작업에 고정해서 실행한다.', 1, null, null, null, undefined, null, modelPlan)
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getProject(project.id).modelProfile).toEqual(modelProfile)
    expect(reopened.getTask(task.id).modelPlan).toEqual(modelPlan)
    reopened.close()
  })

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
      testCommand: 'tuist test',
      publishStrategy: 'direct'
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
    store.setTaskWorkspace(
      task.id,
      'agentmonitor/test-task',
      join(directory, 'worktrees', task.id),
      'main',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
    store.setTaskVerificationBaseCommit(task.id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')

    store.transitionTask(task.id, 'running', 1)
    store.transitionTask(task.id, 'awaiting_approval')
    store.transitionTask(task.id, 'completed')
    store.setTaskPublication(task.id, {
      strategy: 'direct',
      status: 'published',
      remoteName: 'origin',
      baseBranch: 'main',
      remoteBranch: 'main',
      pullRequestUrl: null,
      publishedCommit: 'abcdef123456',
      mergeCommit: 'cccccccccccccccccccccccccccccccccccccccc',
      message: '원격 게시 완료',
      updatedAt: new Date().toISOString()
    })
    store.addNote(project.id, '결정', '승인 경계를 유지한다.')
    store.close()

    const reopened = new AppStore(databasePath)
    const snapshot = reopened.getSnapshot(project.id)
    expect(snapshot.selectedProject?.id).toBe(project.id)
    expect(snapshot.selectedProject).toMatchObject({
      setupCommand: 'tuist install',
      testCommand: 'tuist test',
      publishStrategy: 'direct'
    })
    expect(snapshot.tasks[0].status).toBe('completed')
    expect(snapshot.tasks[0]).toMatchObject({
      publishStrategy: 'direct',
      baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      verificationBaseCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      publication: { status: 'published', remoteName: 'origin', baseBranch: 'main' }
    })
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

  it('persists approval feedback without replacing the original task contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Revision project', join(directory, 'revision-project'))
    const task = store.createTask(
      project.id,
      '메인 스레드 경고 수정',
      '기존 기능을 구현하고 승인된 검증 조건을 모두 통과한다.',
      2
    )
    store.setTaskWorkspace(task.id, 'agentmonitor/revision', join(directory, 'worktree'), 'main')
    store.transitionTask(task.id, 'running', 1)
    store.transitionTask(task.id, 'awaiting_approval')

    const updated = store.addTaskRevisionRequest(
      task.id,
      '메인 스레드 경고의 원인을 제거하고 기존 검증을 다시 실행해 주세요.'
    )

    expect(updated.prompt).toBe(task.prompt)
    expect(updated.revisionRequests).toHaveLength(1)
    expect(updated.revisionRequests?.[0].instruction).toContain('메인 스레드 경고')
    expect(store.getSnapshot(project.id).events.some((event) => event.kind === 'task_revision_requested')).toBe(true)
    const firstRequestId = updated.revisionRequests![0].id
    expect(store.markTaskRevisionRequestStarted(task.id, firstRequestId).revisionRequests?.[0].startedAt).toBeTruthy()
    expect(store.markTaskRevisionRequestsApplied(task.id, [firstRequestId]).revisionRequests?.[0].appliedAt).toBeTruthy()
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getTask(task.id).revisionRequests?.[0].instruction).toContain('메인 스레드 경고')
    expect(reopened.getTask(task.id).revisionRequests?.[0].appliedAt).toBeTruthy()
    const second = reopened.addTaskRevisionRequest(task.id, '두 번째 수정 요청도 같은 작업에 누적합니다.')
    const secondRequestId = second.revisionRequests![1].id
    reopened.transitionTask(task.id, 'running', 1)
    const queued = reopened.addTaskRevisionRequest(task.id, '실행 중에 세 번째 요청을 미리 큐에 추가합니다.')
    expect(queued.revisionRequests?.map((request) => request.instruction)).toHaveLength(3)
    reopened.markTaskRevisionRequestStarted(task.id, secondRequestId)
    const partiallyApplied = reopened.markTaskRevisionRequestsApplied(task.id, [secondRequestId])
    expect(partiallyApplied.revisionRequests?.[1].appliedAt).toBeTruthy()
    expect(partiallyApplied.revisionRequests?.[2].appliedAt).toBeNull()
    reopened.transitionTask(task.id, 'awaiting_approval')
    reopened.setTaskPublication(task.id, {
      strategy: 'direct',
      status: 'awaiting_local_sync',
      remoteName: 'origin',
      baseBranch: 'main',
      remoteBranch: 'main',
      pullRequestUrl: null,
      publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mergeCommit: null,
      message: '원격 반영 후 로컬 동기화 대기',
      updatedAt: new Date().toISOString()
    })
    expect(() => reopened.addTaskRevisionRequest(task.id, '원격 반영 뒤에는 받을 수 없는 요청입니다.')).toThrow(
      '원격 반영이 끝난 작업은 추가로 수정할 수 없습니다.'
    )
    reopened.close()
  })

  it('manages and persists queued revision requests without changing completed history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Revision queue project', join(directory, 'revision-queue-project'))
    const task = store.createTask(
      project.id,
      '추가 수정 큐 관리',
      '승인 대기 중인 작업의 추가 수정 요청을 안전하게 관리한다.',
      2
    )
    store.setTaskWorkspace(task.id, 'agentmonitor/revision-queue', join(directory, 'worktree'), 'main')
    store.transitionTask(task.id, 'running', 1)
    store.transitionTask(task.id, 'awaiting_approval')

    const first = store.addTaskRevisionRequest(task.id, '첫 번째 수정 요청을 구현하고 검증해 주세요.')
    const firstId = first.revisionRequests![0].id
    store.markTaskRevisionRequestStarted(task.id, firstId)
    store.markTaskRevisionRequestsApplied(task.id, [firstId])
    const second = store.addTaskRevisionRequest(task.id, '두 번째 수정 요청을 대기열에 추가해 주세요.')
    const secondId = second.revisionRequests![1].id
    const third = store.addTaskRevisionRequest(task.id, '세 번째 수정 요청을 먼저 검토해 주세요.')
    const thirdId = third.revisionRequests![2].id

    store.updateTaskRevisionRequest(task.id, thirdId, '세 번째 수정 요청의 변경된 내용을 먼저 검토해 주세요.')
    store.moveTaskRevisionRequest(task.id, thirdId, 'up')
    store.cancelTaskRevisionRequest(task.id, secondId)
    store.setTaskRevisionQueuePaused(task.id, true)
    store.markTaskRevisionRequestFailed(task.id, thirdId, '검증 환경을 준비하지 못했습니다.')
    store.close()

    const reopened = new AppStore(databasePath)
    const persisted = reopened.getTask(task.id)
    expect(persisted.revisionQueuePaused).toBe(true)
    expect(persisted.revisionRequests?.map((request) => request.id)).toEqual([firstId, thirdId, secondId])
    expect(persisted.revisionRequests?.[0]).toMatchObject({ appliedAt: expect.any(String) })
    expect(persisted.revisionRequests?.[1]).toMatchObject({
      instruction: '세 번째 수정 요청의 변경된 내용을 먼저 검토해 주세요.',
      lastFailureMessage: '검증 환경을 준비하지 못했습니다.'
    })
    expect(persisted.revisionRequests?.[2]).toMatchObject({ cancelledAt: expect.any(String) })
    expect(() => reopened.updateTaskRevisionRequest(task.id, firstId, '완료 이력을 바꾸면 안 됩니다.')).toThrow(
      '완료되거나 취소된 요청은 수정할 수 없습니다.'
    )
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
