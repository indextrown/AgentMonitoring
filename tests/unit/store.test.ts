import { mkdtemp, rm } from 'node:fs/promises'
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

    const project = store.addProject('Fixture', join(directory, 'fixture'))
    const task = store.createTask(project.id, '테스트 작업', '테스트 작업의 완료 조건을 검증한다.', 3)
    expect(task.status).toBe('queued')

    store.transitionTask(task.id, 'running', 1)
    store.transitionTask(task.id, 'awaiting_approval')
    store.transitionTask(task.id, 'completed')
    store.addNote(project.id, '결정', '승인 경계를 유지한다.')
    store.close()

    const reopened = new AppStore(databasePath)
    const snapshot = reopened.getSnapshot(project.id)
    expect(snapshot.selectedProject?.id).toBe(project.id)
    expect(snapshot.tasks[0].status).toBe('completed')
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
})
