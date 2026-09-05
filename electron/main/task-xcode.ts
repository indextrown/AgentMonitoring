import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ProjectRecord, TaskRecord } from '../../src/shared/types'

const execFileAsync = promisify(execFile)

export type TaskXcodeOpener = (containerPath: string) => Promise<void>

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
}

async function defaultOpenXcode(containerPath: string): Promise<void> {
  await execFileAsync('/usr/bin/open', ['-a', 'Xcode', containerPath], {
    encoding: 'utf8',
    timeout: 30_000
  })
}

/**
 * Opens the configured Xcode container from a task worktree, not the original checkout.
 */
export async function openTaskInXcode(
  project: ProjectRecord,
  task: TaskRecord,
  openXcode: TaskXcodeOpener = defaultOpenXcode
): Promise<void> {
  if (task.projectId !== project.id) {
    throw new Error('작업과 프로젝트가 일치하지 않아 Xcode를 열 수 없습니다.')
  }
  if (!task.worktreePath) {
    throw new Error('이 작업의 격리 작업공간이 없어 Xcode를 열 수 없습니다.')
  }
  if (project.runtimeAdapter?.kind !== 'ios-simulator') {
    throw new Error('iOS 실행 설정이 연결된 작업만 Xcode에서 열 수 있습니다.')
  }

  const configuredContainer = project.runtimeAdapter.container
  if (!configuredContainer.endsWith('.xcworkspace') && !configuredContainer.endsWith('.xcodeproj')) {
    throw new Error('프로젝트 설정의 Xcode container를 확인하세요.')
  }

  let worktreeRoot: string
  try {
    worktreeRoot = await realpath(task.worktreePath)
  } catch {
    throw new Error('작업공간을 찾을 수 없습니다. 작업이 정리되었는지 확인하세요.')
  }

  const containerCandidate = resolve(worktreeRoot, configuredContainer)
  if (!isPathInside(worktreeRoot, containerCandidate)) {
    throw new Error('작업공간 밖의 Xcode container는 열 수 없습니다.')
  }

  let containerPath: string
  try {
    const stats = await lstat(containerCandidate)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('invalid container')
    containerPath = await realpath(containerCandidate)
  } catch {
    throw new Error(`작업 브랜치에서 ${configuredContainer}을(를) 찾을 수 없습니다. 작업을 한 번 실행해 개발 환경을 준비한 뒤 다시 시도하세요.`)
  }

  if (!isPathInside(worktreeRoot, containerPath)) {
    throw new Error('작업공간 밖으로 연결된 Xcode container는 열 수 없습니다.')
  }

  const marker = containerPath.endsWith('.xcworkspace')
    ? resolve(containerPath, 'contents.xcworkspacedata')
    : resolve(containerPath, 'project.pbxproj')
  try {
    const markerStats = await lstat(marker)
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) throw new Error('invalid marker')
  } catch {
    throw new Error(`유효한 Xcode container가 아닙니다: ${configuredContainer}`)
  }

  try {
    await openXcode(containerPath)
  } catch {
    throw new Error('Xcode를 열지 못했습니다. Xcode 설치 상태를 확인한 뒤 다시 시도하세요.')
  }
}
