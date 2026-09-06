import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const excluded = /(^|\/)(\.git|\.build|DerivedData|node_modules|Pods|build|dist|out)(\/|$)|(^|\/)(\.env[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*)$/i
export const safePlanningPath = (path: string): boolean => !excluded.test(path) && !path.startsWith('/') && !path.split('/').includes('..')

export interface RepositoryContext {
  fingerprint: string
  branch: string
  head: string
  files: string[]
  dirtyFiles: string[]
  reused: boolean
}

/** Metadata only: no source bodies, ignored configuration values or build output are cached. */
export class PlanningRepositoryContext {
  private readonly cache = new Map<string, RepositoryContext>()

  async inspect(projectPath: string, signal?: AbortSignal): Promise<RepositoryContext> {
    const cwd = await realpath(projectPath)
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, {
      cwd, signal, timeout: 10_000, maxBuffer: 8_000_000, encoding: 'utf8'
    })).stdout.trimEnd()
    const [head, branch, status] = await Promise.all([
      git('rev-parse', 'HEAD'), git('rev-parse', '--abbrev-ref', 'HEAD'),
      git('status', '--porcelain=v1', '-z', '--untracked-files=all')
    ])
    const dirtyFiles: string[] = []
    const entries = status.split('\0')
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      if (!entry) continue
      dirtyFiles.push(entry.slice(3))
      if (/[RC]/.test(entry.slice(0, 2))) dirtyFiles.push(entries[++index])
    }
    const stamps = await Promise.all(dirtyFiles.map(async (path) => {
      try { const stat = await lstat(join(cwd, path)); return [path, stat.size, stat.mtimeMs, stat.ctimeMs] }
      catch { return [path, 'missing'] }
    }))
    const fingerprint = createHash('sha256').update(JSON.stringify([head, branch, status, stamps])).digest('hex')
    const previous = this.cache.get(cwd)
    if (previous?.fingerprint === fingerprint) return { ...previous, reused: true }
    const files = (await git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
      .split('\0').filter((path) => path && safePlanningPath(path))
    const result = { fingerprint, head, branch, files: [...new Set(files)], dirtyFiles: dirtyFiles.filter(safePlanningPath), reused: false }
    this.cache.delete(cwd)
    this.cache.set(cwd, result)
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!)
    return result
  }

  describe(context: RepositoryContext, requirements: string, previous?: string): string {
    const words = requirements.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
    const score = (path: string): number => words.filter((word) => path.toLowerCase().includes(word)).length * 10
      + (/package\.json$|Project\.swift$|Package\.swift$|README|\.xcodeproj/.test(path) ? 2 : 0)
    const candidates = [...context.files].sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, 24)
    return [
      `현재 브랜치: ${context.branch}, HEAD: ${context.head}`,
      previous === context.fingerprint ? '지난 요청 이후 저장소 변경이 감지되지 않았습니다. 이전 조사 결과를 재사용하세요.' :
        '새 조사 또는 저장소 변경이 감지됐습니다. 이전 대화의 코드 관련 사실을 현재 파일과 재확인하세요.',
      `미커밋 변경 경로(최대 40): ${context.dirtyFiles.slice(0, 40).join(', ') || '없음'}`,
      `초기 조사 후보 ${candidates.length}개 / 전체 ${context.files.length}개:\n${candidates.join('\n')}`,
      '후보는 검색 시작점이며 전체 구현 범위를 의미하지 않습니다. 후보를 전부 읽지 말고 요구사항과 직접 관련된 소수 파일부터 확인하세요.',
      '파일을 읽을 때 출력 범위를 제한하고 빌드 산출물·외부 의존성 전체 순회, 빌드·테스트 실행은 하지 마세요.',
      '비밀값과 인증 정보는 읽거나 문서에 포함하지 마세요. 조사하지 않은 사항은 확인 필요로 표시하세요.'
    ].join('\n\n')
  }
}
