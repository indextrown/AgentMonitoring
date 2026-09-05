import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_IGNORED_XCCONFIG_BYTES = 1024 * 1024

export interface IgnoredXcconfigSyncResult {
  paths: string[]
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

async function assertSafeDestinationParent(
  worktreeRoot: string,
  destinationParent: string,
  path: string
): Promise<void> {
  const pathFromRoot = relative(resolve(worktreeRoot), resolve(destinationParent))
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`작업공간 밖을 가리키는 xcconfig 경로는 복사하지 않습니다: ${path}`)
  }
  let currentPath = resolve(worktreeRoot)
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    currentPath = resolve(currentPath, segment)
    try {
      const stats = await lstat(currentPath)
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`작업공간 밖을 가리키는 xcconfig 경로는 복사하지 않습니다: ${path}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function listIgnoredXcconfigPaths(repositoryRoot: string): Promise<string[]> {
  const result = await execFileAsync(
    'git',
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '*.xcconfig'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
  )
  return String(result.stdout)
    .split('\0')
    .filter(Boolean)
    .filter((path) => path.endsWith('.xcconfig'))
    .sort((left, right) => left.localeCompare(right))
}

export async function hasIgnoredXcconfigFiles(repositoryRoot: string): Promise<boolean> {
  return (await listIgnoredXcconfigPaths(repositoryRoot)).length > 0
}

async function isIgnoredInWorktree(worktreeRoot: string, path: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '--quiet', '--', path], {
      cwd: worktreeRoot,
      encoding: 'utf8'
    })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return false
    throw error
  }
}

export async function syncIgnoredXcconfigFiles(
  sourceRoot: string,
  worktreeRoot: string
): Promise<IgnoredXcconfigSyncResult> {
  const paths = await listIgnoredXcconfigPaths(sourceRoot)
  for (const path of paths) {
    const sourcePath = resolve(sourceRoot, path)
    const destinationPath = resolve(worktreeRoot, path)
    const destinationParent = resolve(destinationPath, '..')
    if (!isPathInside(sourceRoot, sourcePath) || !isPathInside(worktreeRoot, destinationPath)) {
      throw new Error(`안전하지 않은 xcconfig 경로입니다: ${path}`)
    }
    const sourceStats = await lstat(sourcePath)
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error(`일반 xcconfig 파일만 복사할 수 있습니다: ${path}`)
    }
    if (sourceStats.size > MAX_IGNORED_XCCONFIG_BYTES) {
      throw new Error(`xcconfig 파일이 1MB를 초과합니다: ${path}`)
    }
    await assertSafeDestinationParent(worktreeRoot, destinationParent, path)
    if (!(await isIgnoredInWorktree(worktreeRoot, path))) {
      throw new Error(`작업공간에서 Git 제외 상태가 아닌 xcconfig는 복사하지 않습니다: ${path}`)
    }
    await mkdir(destinationParent, { recursive: true })
    const [resolvedWorktreeRoot, resolvedDestinationParent] = await Promise.all([
      realpath(worktreeRoot),
      realpath(destinationParent)
    ])
    if (!isPathWithinRoot(resolvedWorktreeRoot, resolvedDestinationParent)) {
      throw new Error(`작업공간 밖을 가리키는 xcconfig 경로는 복사하지 않습니다: ${path}`)
    }
    try {
      const destinationStats = await lstat(destinationPath)
      if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
        throw new Error(`작업공간의 기존 xcconfig가 일반 파일이 아닙니다: ${path}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await copyFile(sourcePath, destinationPath)
    await chmod(destinationPath, 0o600)
  }
  return { paths }
}
