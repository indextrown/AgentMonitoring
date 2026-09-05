import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTaskInXcode } from '../../electron/main/task-xcode'
import type { ProjectRecord, TaskRecord } from '../../src/shared/types'

const temporaryDirectories: string[] = []

function projectRecord(path: string, container = 'Demo.xcworkspace'): ProjectRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Demo',
    path,
    testCommand: '',
    setupCommand: '',
    runtimeAdapter: {
      kind: 'ios-simulator',
      container,
      scheme: 'Demo',
      configuration: 'Debug',
      deviceFamily: 'iphone'
    },
    runtimeConfigSource: 'detected',
    publishStrategy: 'pull-request',
    isDemo: false,
    createdAt: '2026-09-05T00:00:00.000Z'
  }
}

function taskRecord(worktreePath: string): TaskRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    projectId: '11111111-1111-4111-8111-111111111111',
    title: '작업 브랜치 열기',
    prompt: '작업 브랜치의 Xcode workspace를 연다.',
    status: 'awaiting_approval',
    provider: 'codex',
    maxAttempts: 3,
    attempt: 1,
    sourceBranch: 'main',
    baseCommit: 'abc123',
    verificationBaseCommit: 'abc123',
    branchName: 'agentmonitor/task-branch',
    worktreePath,
    publishStrategy: 'pull-request',
    publication: null,
    runtimeContract: null,
    runtimeScenarioSummary: null,
    runtimeScenarioApprovedAt: null,
    techSpec: null,
    verificationPlan: null,
    verificationResult: null,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z'
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('openTaskInXcode', () => {
  it('opens the configured workspace inside the task worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-task-xcode-'))
    temporaryDirectories.push(directory)
    const worktreePath = join(directory, 'worktree')
    const containerPath = join(worktreePath, 'Demo.xcworkspace')
    await mkdir(containerPath, { recursive: true })
    await writeFile(join(containerPath, 'contents.xcworkspacedata'), '<Workspace />')
    const opener = vi.fn(async () => undefined)

    await openTaskInXcode(projectRecord(directory), taskRecord(worktreePath), opener)

    expect(opener).toHaveBeenCalledOnce()
    expect(opener).toHaveBeenCalledWith(await realpath(containerPath))
  })

  it('rejects a configured container outside the task worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-task-xcode-outside-'))
    temporaryDirectories.push(directory)
    const worktreePath = join(directory, 'worktree')
    await mkdir(worktreePath, { recursive: true })

    await expect(openTaskInXcode(
      projectRecord(directory, '../Outside.xcodeproj'),
      taskRecord(worktreePath),
      vi.fn(async () => undefined)
    )).rejects.toThrow('작업공간 밖의 Xcode container는 열 수 없습니다.')
  })

  it('rejects a container symlink that escapes the task worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-task-xcode-link-'))
    temporaryDirectories.push(directory)
    const worktreePath = join(directory, 'worktree')
    const outsidePath = join(directory, 'Outside.xcodeproj')
    await mkdir(worktreePath, { recursive: true })
    await mkdir(outsidePath, { recursive: true })
    await writeFile(join(outsidePath, 'project.pbxproj'), '// project')
    await symlink(outsidePath, join(worktreePath, 'Demo.xcodeproj'))

    await expect(openTaskInXcode(
      projectRecord(directory, 'Demo.xcodeproj'),
      taskRecord(worktreePath),
      vi.fn(async () => undefined)
    )).rejects.toThrow('작업 브랜치에서 Demo.xcodeproj을(를) 찾을 수 없습니다.')
  })
})
