import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppStore } from '../../electron/main/store'
import type { ApprovedRuntimeContract } from '../../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('approved runtime scenario persistence', () => {
  it('persists project runtime settings and the task approval snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runtime-contract-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'test.sqlite')
    const store = new AppStore(databasePath)
    const project = store.addProject('Demo', join(directory, 'Demo'))
    const adapter = {
      kind: 'ios-simulator' as const,
      container: 'Demo.xcodeproj',
      scheme: 'Demo',
      configuration: 'Debug' as const,
      deviceFamily: 'iphone' as const
    }
    store.setProjectRuntimeAdapter(project.id, adapter, 'detected')

    const contract: ApprovedRuntimeContract = {
      version: 1,
      adapter,
      capabilities: {
        build: true,
        run: true,
        observe: ['screen', 'accessibility'],
        act: ['ui'],
        verify: ['test-command', 'runtime-scenario']
      },
      runtimeScenario: {
        actions: [{ kind: 'tap', identifier: 'save-profile', timeoutSeconds: 10 }],
        assertions: [
          {
            kind: 'accessibility',
            name: '저장 결과 표시',
            identifier: 'profile-saved',
            property: 'exists',
            expected: true
          }
        ]
      }
    }
    const task = store.createTask(
      project.id,
      '프로필 저장',
      '프로필 저장 버튼을 누르면 완료 결과가 보여야 한다.',
      3,
      contract,
      '프로필을 저장하고 완료 결과를 확인합니다.'
    )
    expect(task.runtimeScenarioApprovedAt).toBeTruthy()
    store.close()

    const reopened = new AppStore(databasePath)
    expect(reopened.getProject(project.id)).toMatchObject({
      runtimeAdapter: adapter,
      runtimeConfigSource: 'detected'
    })
    expect(reopened.getTask(task.id)).toMatchObject({
      runtimeContract: contract,
      runtimeScenarioSummary: '프로필을 저장하고 완료 결과를 확인합니다.'
    })
    reopened.close()
  })
})
