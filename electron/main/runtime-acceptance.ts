import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { IosSimulatorLaunchResult } from './ios-simulator-runtime'
import type { ProjectCapabilityManifest } from './project-capabilities'

export type RuntimeAcceptanceAssertion = NonNullable<
  ProjectCapabilityManifest['runtimeScenario']
>['assertions'][number]

export interface RuntimeAcceptanceResult {
  index: number
  kind: RuntimeAcceptanceAssertion['kind']
  description: string
  passed: boolean
  expected: string
  actual: string
}

export interface RuntimeAcceptanceReport {
  schemaVersion: 1
  evaluatedAt: string
  passed: boolean
  assertionCount: number
  passedCount: number
  results: RuntimeAcceptanceResult[]
}

interface ParsedDocument {
  value: unknown
  error: string | null
}

interface ResolvedPath {
  found: boolean
  value: unknown
}

export interface RuntimeAcceptanceEvidence {
  path: string
  mimeType: 'application/json'
  sizeBytes: number
  createdAt: string
  content: string
}

const MAX_VALUE_PREVIEW_CHARS = 1_000
const MAX_REPORT_BYTES = 512 * 1024

function parseDocument(
  content: string | undefined,
  label: string
): ParsedDocument {
  if (!content) return { value: undefined, error: `${label} 증거가 없습니다.` }
  try {
    return { value: JSON.parse(content), error: null }
  } catch {
    return { value: undefined, error: `${label} JSON을 해석할 수 없습니다.` }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function preview(value: unknown): string {
  if (value === undefined) return '(없음)'
  const serialized = JSON.stringify(value)
  const source = serialized === undefined ? String(value) : serialized
  return source.length > MAX_VALUE_PREVIEW_CHARS
    ? `${source.slice(0, MAX_VALUE_PREVIEW_CHARS)}…`
    : source
}

function formatStatePath(path: Array<string | number>): string {
  return path
    .map((segment, index) =>
      typeof segment === 'number'
        ? `[${segment}]`
        : `${index === 0 ? '' : '.'}${segment}`
    )
    .join('')
}

function resolveStatePath(
  state: unknown,
  path: Array<string | number>
): ResolvedPath {
  let current = state
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        return { found: false, value: undefined }
      }
      current = current[segment]
      continue
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined }
    }
    current = current[segment]
  }
  return { found: true, value: current }
}

function accessibilityMatches(
  document: ParsedDocument,
  identifier: string
): { matches: Record<string, unknown>[]; error: string | null } {
  if (document.error) return { matches: [], error: document.error }
  if (!isRecord(document.value) || !isRecord(document.value.root)) {
    return { matches: [], error: '접근성 트리 JSON에 root가 없습니다.' }
  }

  const matches: Record<string, unknown>[] = []
  const stack: unknown[] = [document.value.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!isRecord(node)) continue
    if (node.identifier === identifier) matches.push(node)
    if (Array.isArray(node.children)) stack.push(...node.children)
  }
  return { matches, error: null }
}

function result(
  index: number,
  assertion: RuntimeAcceptanceAssertion,
  description: string,
  passed: boolean,
  expected: unknown,
  actual: unknown
): RuntimeAcceptanceResult {
  return {
    index,
    kind: assertion.kind,
    description: assertion.name ?? description,
    passed,
    expected: preview(expected),
    actual: preview(actual)
  }
}

function evaluateStateAssertion(
  index: number,
  assertion: Extract<RuntimeAcceptanceAssertion, { kind: 'state' }>,
  document: ParsedDocument
): RuntimeAcceptanceResult {
  const path = formatStatePath(assertion.path)
  if (document.error) {
    return result(index, assertion, `앱 상태 ${path}`, false, assertion.expected, document.error)
  }
  if (!isRecord(document.value) || !Object.prototype.hasOwnProperty.call(document.value, 'state')) {
    return result(index, assertion, `앱 상태 ${path}`, false, assertion.expected, 'Debug state가 없습니다.')
  }
  const resolved = resolveStatePath(document.value.state, assertion.path)
  if (assertion.operator === 'exists') {
    return result(
      index,
      assertion,
      `앱 상태 ${path} 존재 여부`,
      resolved.found === assertion.expected,
      assertion.expected,
      resolved.found
    )
  }
  const equal = resolved.found && isDeepStrictEqual(resolved.value, assertion.expected)
  const passed = resolved.found && (assertion.operator === 'equals' ? equal : !equal)
  return result(
    index,
    assertion,
    `앱 상태 ${path} ${assertion.operator}`,
    passed,
    assertion.expected,
    resolved.found ? resolved.value : '(경로 없음)'
  )
}

function evaluateAccessibilityAssertion(
  index: number,
  assertion: Extract<RuntimeAcceptanceAssertion, { kind: 'accessibility' }>,
  document: ParsedDocument
): RuntimeAcceptanceResult {
  const { matches, error } = accessibilityMatches(document, assertion.identifier)
  if (error) {
    return result(
      index,
      assertion,
      `접근성 ${assertion.identifier}.${assertion.property}`,
      false,
      assertion.expected,
      error
    )
  }
  if (assertion.property === 'exists') {
    const exists = matches.length > 0
    return result(
      index,
      assertion,
      `접근성 ${assertion.identifier} 존재 여부`,
      exists === assertion.expected,
      assertion.expected,
      exists
    )
  }
  if (matches.length !== 1) {
    return result(
      index,
      assertion,
      `접근성 ${assertion.identifier}.${assertion.property}`,
      false,
      assertion.expected,
      matches.length === 0 ? '(identifier 없음)' : `(identifier ${matches.length}개 중복)`
    )
  }
  const actual = matches[0][assertion.property]
  return result(
    index,
    assertion,
    `접근성 ${assertion.identifier}.${assertion.property}`,
    isDeepStrictEqual(actual, assertion.expected),
    assertion.expected,
    actual
  )
}

function evaluateEvidenceAssertion(
  index: number,
  assertion: Extract<RuntimeAcceptanceAssertion, { kind: 'evidence' }>,
  launchResult: IosSimulatorLaunchResult
): RuntimeAcceptanceResult {
  const available = {
    screen: Boolean(launchResult.screenEvidence),
    accessibility: Boolean(launchResult.accessibilityEvidence),
    state: Boolean(launchResult.debugStateEvidence?.hasState),
    'ui-actions': Boolean(launchResult.uiActionEvidence),
    fixture: Boolean(launchResult.debugStateEvidence?.fixtureId)
  }[assertion.target]
  return result(
    index,
    assertion,
    `${assertion.target} 증거 존재`,
    available,
    true,
    available
  )
}

export function evaluateRuntimeAcceptance(
  assertions: RuntimeAcceptanceAssertion[],
  launchResult: IosSimulatorLaunchResult,
  evaluatedAt = new Date().toISOString()
): RuntimeAcceptanceReport {
  const debugState = parseDocument(launchResult.debugStateEvidence?.content, 'Debug state')
  const accessibility = parseDocument(
    launchResult.accessibilityEvidence?.content,
    '접근성 트리'
  )
  const results = assertions.map((assertion, index) => {
    if (assertion.kind === 'state') {
      return evaluateStateAssertion(index, assertion, debugState)
    }
    if (assertion.kind === 'accessibility') {
      return evaluateAccessibilityAssertion(index, assertion, accessibility)
    }
    return evaluateEvidenceAssertion(index, assertion, launchResult)
  })
  const passedCount = results.filter((item) => item.passed).length
  return {
    schemaVersion: 1,
    evaluatedAt,
    passed: passedCount === results.length,
    assertionCount: results.length,
    passedCount,
    results
  }
}

export function summarizeRuntimeAcceptance(report: RuntimeAcceptanceReport): string {
  const base = `runtime acceptance ${report.passedCount.toLocaleString('ko-KR')}/${report.assertionCount.toLocaleString('ko-KR')} 통과`
  if (report.passed) return base
  const failures = report.results
    .filter((item) => !item.passed)
    .slice(0, 3)
    .map((item) => item.description)
    .join(' · ')
  return `${base} · 실패: ${failures}`
}

function isContainedPath(
  root: string,
  candidate: string
): boolean {
  const child = relative(root, candidate)
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}

async function requireDirectory(
  path: string,
  label: string
): Promise<string> {
  const stats = await lstat(path).catch(() => null)
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label}은 심볼릭 링크가 아닌 디렉터리여야 합니다.`)
  }
  return realpath(path)
}

export async function writeRuntimeAcceptanceEvidence(
  runtimeRoot: string,
  taskId: string,
  report: RuntimeAcceptanceReport
): Promise<RuntimeAcceptanceEvidence> {
  const root = await requireDirectory(resolve(runtimeRoot), 'runtime root')
  const sessionCandidate = resolve(root, taskId)
  if (!isContainedPath(root, sessionCandidate)) {
    throw new Error('runtime acceptance session 경로가 runtime root를 벗어났습니다.')
  }
  const session = await requireDirectory(sessionCandidate, 'runtime session')
  if (!isContainedPath(root, session)) {
    throw new Error('runtime acceptance session 실경로가 runtime root를 벗어났습니다.')
  }

  const evidenceCandidate = resolve(session, 'evidence')
  const evidenceStats = await lstat(evidenceCandidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!evidenceStats) await mkdir(evidenceCandidate)
  const evidenceRoot = await requireDirectory(evidenceCandidate, 'runtime evidence 경로')
  if (!isContainedPath(session, evidenceRoot)) {
    throw new Error('runtime evidence 실경로가 runtime session을 벗어났습니다.')
  }

  const content = `${JSON.stringify(report, null, 2)}\n`
  const sizeBytes = Buffer.byteLength(content)
  if (sizeBytes <= 0 || sizeBytes > MAX_REPORT_BYTES) {
    throw new Error(
      `runtime acceptance 결과 크기가 허용 범위를 벗어났습니다: ${sizeBytes.toLocaleString('ko-KR')} bytes`
    )
  }
  const path = resolve(evidenceRoot, `runtime-verification-${randomUUID()}.json`)
  if (!isContainedPath(evidenceRoot, path)) {
    throw new Error('runtime acceptance 결과 경로가 evidence 디렉터리를 벗어났습니다.')
  }
  await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
  const stats = await lstat(path)
  const resolvedPath = await realpath(path)
  if (!stats.isFile() || stats.isSymbolicLink() || !isContainedPath(evidenceRoot, resolvedPath)) {
    throw new Error('runtime acceptance 결과가 안전한 일반 파일이 아닙니다.')
  }
  return {
    path: resolvedPath,
    mimeType: 'application/json',
    sizeBytes,
    createdAt: report.evaluatedAt,
    content
  }
}
