import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProjectInspection, ProjectRecord } from '../../src/shared/types'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 4_000_000

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  swift: 'Swift',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  kt: 'Kotlin',
  kts: 'Kotlin',
  java: 'Java',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  h: 'C/C++',
  hpp: 'C++',
  cs: 'C#',
  rb: 'Ruby'
}

const MANIFEST_NAMES = new Set([
  'Tuist.swift',
  'Workspace.swift',
  'Project.swift',
  'Package.swift',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Makefile',
  'Podfile'
])

async function runGit(projectPath: string, args: string[], optional = false): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES
    })
    return result.stdout.trim()
  } catch (error) {
    if (optional) return ''
    throw new Error(`저장소 정보를 확인할 수 없습니다: ${String(error)}`)
  }
}

function baseName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function detectLanguages(files: string[]): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const extension = file.includes('.') ? file.split('.').at(-1)?.toLowerCase() : undefined
    const language = extension ? LANGUAGE_BY_EXTENSION[extension] : undefined
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language]) => language)
    .slice(0, 4)
}

function detectTools(files: string[]): string[] {
  const names = new Set(files.map(baseName))
  const tools: string[] = []
  if (names.has('Tuist.swift') || names.has('Workspace.swift')) tools.push('Tuist')
  if (files.some((file) => file.includes('.xcodeproj/') || file.includes('.xcworkspace/'))) tools.push('Xcode')
  if (files.includes('Package.swift')) tools.push('SwiftPM')
  if (names.has('pnpm-lock.yaml')) tools.push('pnpm')
  else if (names.has('package-lock.json')) tools.push('npm')
  else if (names.has('yarn.lock')) tools.push('Yarn')
  else if (names.has('bun.lock') || names.has('bun.lockb')) tools.push('Bun')
  if (names.has('Cargo.toml')) tools.push('Cargo')
  if (names.has('go.mod')) tools.push('Go')
  if (names.has('pyproject.toml')) tools.push('Python')
  return tools
}

function suggestTestCommands(tools: string[]): string[] {
  const commands: string[] = []
  if (tools.includes('Tuist')) commands.push('tuist test')
  else if (tools.includes('SwiftPM')) commands.push('swift test')
  if (tools.includes('pnpm')) commands.push('pnpm test')
  if (tools.includes('npm')) commands.push('npm test')
  if (tools.includes('Yarn')) commands.push('yarn test')
  if (tools.includes('Bun')) commands.push('bun test')
  if (tools.includes('Cargo')) commands.push('cargo test')
  if (tools.includes('Go')) commands.push('go test ./...')
  if (tools.includes('Python')) commands.push('pytest')
  return commands.slice(0, 4)
}

export async function inspectProject(project: ProjectRecord): Promise<ProjectInspection> {
  const [branch, status, remotes, head, trackedFiles] = await Promise.all([
    runGit(project.path, ['branch', '--show-current'], true),
    runGit(project.path, ['status', '--short', '--untracked-files=normal']),
    runGit(project.path, ['remote'], true),
    runGit(project.path, ['log', '-1', '--format=%h%x09%cI'], true),
    runGit(project.path, ['ls-files'])
  ])
  const files = trackedFiles ? trackedFiles.split(/\r?\n/).filter(Boolean) : []
  const changes = status ? status.split(/\r?\n/).filter(Boolean) : []
  const languages = detectLanguages(files)
  const tools = detectTools(files)
  const [headCommit, lastCommitAt] = head ? head.split('\t', 2) : [null, null]
  const manifests = files
    .filter((file) => MANIFEST_NAMES.has(baseName(file)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 12)

  return {
    projectId: project.id,
    branch: branch || null,
    headCommit: headCommit || null,
    lastCommitAt: lastCommitAt || null,
    clean: changes.length === 0,
    changeCount: changes.length,
    hasRemote: Boolean(remotes),
    primaryLanguage: languages[0] ?? null,
    languages,
    tools,
    manifests,
    trackedFileCount: files.length,
    testFileCount: files.filter((file) => /(^|\/)(tests?|__tests__)(\/|$)|(?:test|tests)\.[^.]+$/i.test(file)).length,
    suggestedTestCommands: suggestTestCommands(tools),
    inspectedAt: new Date().toISOString()
  }
}
