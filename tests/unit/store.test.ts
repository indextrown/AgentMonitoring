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
  it('seeds a usable dashboard and persists user records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-store-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)

    const initial = store.getSnapshot()
    expect(initial.selectedProject.name).toBe('ElmwoodOnline')
    expect(initial.tasks).toHaveLength(32)
    expect(initial.findings).toHaveLength(6)
    expect(initial.notes).toHaveLength(14)

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
    expect(snapshot.tasks[0].status).toBe('completed')
    expect(snapshot.notes[0].title).toBe('결정')
    reopened.close()
  })
})
