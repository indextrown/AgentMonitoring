import { access } from 'node:fs/promises'
import { join } from 'node:path'

const DEPENDENCY_MANIFEST_PATTERNS = [
  /(^|\/)Tuist\/Package\.swift$/,
  /(^|\/)Package\.swift$/,
  /(^|\/)Package\.resolved$/,
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)(Podfile|Podfile\.lock|Cartfile|Cartfile\.resolved)$/,
  /(^|\/)(Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|pyproject\.toml|uv\.lock)$/
]

const ENVIRONMENT_FAILURE_PATTERNS = [
  /could not find external dependencies/i,
  /run [`']?tuist install/i,
  /not a valid configured external dependency/i,
  /failed to (?:clone|fetch|download|resolve) (?:a )?(?:package|dependency|repository)/i,
  /could not resolve package dependencies/i,
  /package resolution failed/i,
  /could not resolve host/i,
  /authentication failed for .*?(?:repository|https?:\/\/|git@)/i,
  /permission denied.*(?:cache|keychain|deriveddata|\.build)/i
]

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function detectProjectSetupCommand(projectPath: string): Promise<string> {
  if (await pathExists(join(projectPath, 'Tuist', 'Package.swift'))) return 'tuist install'
  return ''
}

export function isDependencyManifestPath(path: string): boolean {
  return DEPENDENCY_MANIFEST_PATTERNS.some((pattern) => pattern.test(path))
}

export function isEnvironmentFailureOutput(output: string): boolean {
  return ENVIRONMENT_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
}

export function environmentFailureMessage(output: string): string {
  if (/tuist install|external dependenc/i.test(output)) {
    return 'Tuist 외부 의존성이 준비되지 않았습니다. 환경 준비 명령을 확인한 뒤 다시 검증하세요.'
  }
  if (/network|resolve host|name resolution|clone|fetch|download/i.test(output)) {
    return '외부 의존성을 내려받는 동안 네트워크 문제가 발생했습니다. 연결 상태를 확인한 뒤 다시 검증하세요.'
  }
  if (/authentication|permission denied|keychain/i.test(output)) {
    return '의존성 설치에 필요한 인증 또는 파일 접근 권한을 확인한 뒤 다시 검증하세요.'
  }
  return '프로젝트 검증 환경을 준비하지 못했습니다. 준비 명령과 도구 설정을 확인하세요.'
}
