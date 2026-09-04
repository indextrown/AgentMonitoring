import { execFile } from 'node:child_process'
import { isAbsolute, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  ProjectChangeKind,
  ProjectRecord,
  SourceControlArea,
  SourceControlCommitResult,
  SourceControlDiff,
  SourceControlFile,
  SourceControlIdentity,
  SourceControlStatus
} from '../../src/shared/types'
import { GitOperationCoordinator } from './git-operation-coordinator'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 8_000_000
const MAX_DIFF_LENGTH = 120_000
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

interface GitResult {
  stdout: string
  stderr: string
}

async function runGit(
  projectPath: string,
  args: string[],
  acceptedExitCodes: number[] = [0]
): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string
      stderr?: string
    }
    if (typeof failure.code === 'number' && acceptedExitCodes.includes(failure.code)) {
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
    const detail = [failure.stdout, failure.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
      .slice(-4_000)
    throw new Error(detail || `Git 명령을 실행할 수 없습니다: git ${args[0] ?? ''}`)
  }
}

function kindForCode(code: string, fallback: ProjectChangeKind = 'modified'): ProjectChangeKind {
  if (code === '?' || code === '??') return 'untracked'
  if (code === 'U' || CONFLICT_CODES.has(code)) return 'conflicted'
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R' || code === 'C') return 'renamed'
  if (code === 'M' || code === 'T') return 'modified'
  return fallback
}

export function parseSourceControlStatus(status: string): SourceControlFile[] {
  if (!status) return []
  const records = status.split('\0')
  const files: SourceControlFile[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const code = record.slice(0, 2)
    const conflicted = CONFLICT_CODES.has(code) || code.includes('U')
    const path = record.slice(3)
    const renamed = code.includes('R') || code.includes('C')
    const originalPath = renamed ? records[index + 1] || null : null
    if (renamed) index += 1

    if (code === '??') {
      files.push({ path, originalPath: null, staged: null, working: 'untracked', conflicted: false })
      continue
    }

    const stagedCode = code[0]
    const workingCode = code[1]
    files.push({
      path,
      originalPath,
      staged: stagedCode === ' ' ? null : kindForCode(conflicted ? 'U' : stagedCode),
      working: workingCode === ' ' ? null : kindForCode(conflicted ? 'U' : workingCode),
      conflicted
    })
  }

  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
}

function validateRepositoryPath(projectPath: string, path: string): void {
  if (!path || path.includes('\0') || isAbsolute(path) || !isPathInside(projectPath, resolve(projectPath, path))) {
    throw new Error('안전하지 않은 저장소 파일 경로입니다.')
  }
}

function identityFromValues(name: string, email: string): SourceControlIdentity {
  const normalizedName = name.trim()
  const normalizedEmail = email.trim()
  return {
    name: normalizedName || null,
    email: normalizedEmail || null,
    complete: Boolean(normalizedName && normalizedEmail)
  }
}

function redactRemoteUrl(remoteUrl: string): string {
  return remoteUrl.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
}

export class SourceControlService {
  constructor(private readonly coordinator: GitOperationCoordinator) {}

  async getStatus(project: ProjectRecord): Promise<SourceControlStatus> {
    this.assertRealProject(project)
    const [status, branch, head, name, email, remoteUrl, upstream] = await Promise.all([
      runGit(project.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      runGit(project.path, ['branch', '--show-current']),
      runGit(project.path, ['rev-parse', '--short', 'HEAD'], [0, 128]),
      runGit(project.path, ['config', '--get', 'user.name'], [0, 1]),
      runGit(project.path, ['config', '--get', 'user.email'], [0, 1]),
      runGit(project.path, ['remote', 'get-url', 'origin'], [0, 2]),
      runGit(project.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [0, 128])
    ])
    const files = parseSourceControlStatus(status.stdout)
    const upstreamName = upstream.stdout.trim()
    let ahead = 0
    let behind = 0
    if (upstreamName) {
      const relation = await runGit(
        project.path,
        ['rev-list', '--left-right', '--count', `${upstreamName}...HEAD`],
        [0, 128]
      )
      const [remoteOnly, localOnly] = relation.stdout.trim().split(/\s+/).map(Number)
      behind = Number.isFinite(remoteOnly) ? remoteOnly : 0
      ahead = Number.isFinite(localOnly) ? localOnly : 0
    }
    return {
      projectId: project.id,
      branch: branch.stdout.trim() || null,
      headCommit: head.stdout.trim() || null,
      identity: identityFromValues(name.stdout, email.stdout),
      files,
      stagedCount: files.filter((file) => file.staged !== null).length,
      workingCount: files.filter((file) => file.working !== null).length,
      conflictedCount: files.filter((file) => file.conflicted).length,
      remote: remoteUrl.stdout.trim()
        ? {
            name: 'origin',
            url: redactRemoteUrl(remoteUrl.stdout.trim()),
            upstream: upstreamName || null,
            ahead,
            behind,
            diverged: ahead > 0 && behind > 0
          }
        : null,
      inspectedAt: new Date().toISOString()
    }
  }

  fetch(project: ProjectRecord): Promise<SourceControlStatus> {
    return this.coordinator.runExclusive(project.id, async () => {
      this.assertRealProject(project)
      const remote = await runGit(project.path, ['remote', 'get-url', 'origin'], [0, 2])
      if (!remote.stdout.trim()) throw new Error('origin 원격 저장소가 설정되지 않았습니다.')
      await runGit(project.path, ['fetch', 'origin', '--prune'])
      return this.getStatus(project)
    })
  }

  async getDiff(
    project: ProjectRecord,
    path: string,
    area: SourceControlArea
  ): Promise<SourceControlDiff> {
    this.assertRealProject(project)
    validateRepositoryPath(project.path, path)
    const status = await this.getStatus(project)
    const file = status.files.find((candidate) => candidate.path === path)
    if (!file) throw new Error('현재 변경 목록에 없는 파일입니다.')

    let result: GitResult
    if (area === 'staged') {
      if (!file.staged) throw new Error('스테이징된 변경이 없는 파일입니다.')
      result = await runGit(project.path, ['diff', '--cached', '--no-ext-diff', '--unified=3', '--', path])
    } else if (file.working === 'untracked') {
      const absolutePath = resolve(project.path, path)
      result = await runGit(
        project.path,
        ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', '/dev/null', absolutePath],
        [0, 1]
      )
      result.stdout = result.stdout
        .split(absolutePath)
        .join(path)
        .replace(/^diff --git .*$/m, `diff --git a/${path} b/${path}`)
        .replace(/^\+\+\+ .*$/m, `+++ b/${path}`)
    } else {
      if (!file.working) throw new Error('작업공간 변경이 없는 파일입니다.')
      result = await runGit(project.path, ['diff', '--no-ext-diff', '--unified=3', '--', path])
    }

    const patch = result.stdout
    return {
      projectId: project.id,
      path,
      area,
      patch: patch.slice(0, MAX_DIFF_LENGTH),
      available: Boolean(patch.trim()),
      binary: /Binary files .* differ|GIT binary patch/.test(patch),
      truncated: patch.length > MAX_DIFF_LENGTH
    }
  }

  stage(project: ProjectRecord, paths: string[]): Promise<SourceControlStatus> {
    return this.coordinator.runExclusive(project.id, async () => {
      const gitPaths = await this.requireKnownPaths(project, paths)
      await runGit(project.path, ['add', '--', ...gitPaths])
      return this.getStatus(project)
    })
  }

  unstage(project: ProjectRecord, paths: string[]): Promise<SourceControlStatus> {
    return this.coordinator.runExclusive(project.id, async () => {
      const gitPaths = await this.requireKnownPaths(project, paths)
      if (await this.hasHead(project)) {
        await runGit(project.path, ['restore', '--staged', '--', ...gitPaths])
      } else {
        await runGit(project.path, ['rm', '--cached', '--', ...gitPaths])
      }
      return this.getStatus(project)
    })
  }

  stageAll(project: ProjectRecord): Promise<SourceControlStatus> {
    return this.coordinator.runExclusive(project.id, async () => {
      this.assertRealProject(project)
      await runGit(project.path, ['add', '--all'])
      return this.getStatus(project)
    })
  }

  unstageAll(project: ProjectRecord): Promise<SourceControlStatus> {
    return this.coordinator.runExclusive(project.id, async () => {
      this.assertRealProject(project)
      if (await this.hasHead(project)) {
        await runGit(project.path, ['restore', '--staged', '--', ':/'])
      } else {
        await runGit(project.path, ['rm', '--cached', '--ignore-unmatch', '-r', '--', '.'])
      }
      return this.getStatus(project)
    })
  }

  setIdentity(
    project: ProjectRecord,
    name: string,
    email: string
  ): Promise<SourceControlStatus> {
    return this.coordinator.runExclusive(project.id, async () => {
      this.assertRealProject(project)
      const normalizedName = name.trim()
      const normalizedEmail = email.trim()
      if (!normalizedName || !normalizedEmail) throw new Error('Git 작성자 이름과 이메일을 모두 입력하세요.')
      await runGit(project.path, ['config', '--local', 'user.name', normalizedName])
      await runGit(project.path, ['config', '--local', 'user.email', normalizedEmail])
      return this.getStatus(project)
    })
  }

  commit(
    project: ProjectRecord,
    message: string,
    includeWorking = false
  ): Promise<SourceControlCommitResult> {
    return this.coordinator.runExclusive(project.id, async () => {
      this.assertRealProject(project)
      const normalizedMessage = message.trim()
      if (!normalizedMessage) throw new Error('커밋 메시지를 입력하세요.')
      if (normalizedMessage.length > 2_000) throw new Error('커밋 메시지는 2,000자 이하로 입력하세요.')
      let before = await this.getStatus(project)
      if (!before.identity.complete) throw new Error('커밋하기 전에 이 저장소의 Git 작성자 이름과 이메일을 설정하세요.')
      if (before.conflictedCount > 0) throw new Error('충돌 파일을 해결하고 스테이징한 뒤 커밋하세요.')
      if (includeWorking) {
        await runGit(project.path, ['add', '--all'])
        before = await this.getStatus(project)
      }
      if (before.stagedCount === 0) throw new Error('커밋할 스테이징된 파일이 없습니다.')

      const result = await runGit(project.path, ['commit', '-m', normalizedMessage])
      const commit = await runGit(project.path, ['rev-parse', '--short', 'HEAD'])
      return {
        commit: commit.stdout.trim(),
        summary: result.stdout.trim().split(/\r?\n/).at(0) ?? normalizedMessage,
        status: await this.getStatus(project)
      }
    })
  }

  private assertRealProject(project: ProjectRecord): void {
    if (project.isDemo || project.path.startsWith('demo://')) {
      throw new Error('데모 프로젝트에서는 Source Control을 사용할 수 없습니다.')
    }
  }

  private async requireKnownPaths(project: ProjectRecord, paths: string[]): Promise<string[]> {
    this.assertRealProject(project)
    const uniquePaths = [...new Set(paths)]
    if (uniquePaths.length === 0) throw new Error('변경할 파일을 선택하세요.')
    const status = await this.getStatus(project)
    const knownPaths = new Set(status.files.map((file) => file.path))
    const gitPaths: string[] = []
    for (const path of uniquePaths) {
      validateRepositoryPath(project.path, path)
      if (!knownPaths.has(path)) throw new Error(`현재 변경 목록에 없는 파일입니다: ${path}`)
      gitPaths.push(path)
      const originalPath = status.files.find((file) => file.path === path)?.originalPath
      if (originalPath) {
        validateRepositoryPath(project.path, originalPath)
        gitPaths.push(originalPath)
      }
    }
    return [...new Set(gitPaths)]
  }

  private async hasHead(project: ProjectRecord): Promise<boolean> {
    const result = await runGit(project.path, ['rev-parse', '--verify', 'HEAD'], [0, 128])
    return Boolean(result.stdout.trim())
  }
}
