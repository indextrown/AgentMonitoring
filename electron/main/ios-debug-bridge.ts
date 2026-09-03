import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { RuntimeCommandExecutor } from './ios-simulator-runtime'

const XCRUN_COMMAND = '/usr/bin/xcrun'
const LIBRARY_DIRECTORY = 'Library'
const APPLICATION_SUPPORT_DIRECTORY = 'Application Support'
const BRIDGE_DIRECTORY = 'AgentMonitoring'
const REQUEST_DIRECTORY = 'Requests'
const RESPONSE_DIRECTORY = 'Responses'
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 512 * 1024
const POLL_INTERVAL_MS = 200

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface RuntimeDebugFixture {
  id: string
  payload: { [key: string]: JsonValue }
}

export interface RuntimeDebugBridgeRequestInput {
  deviceId: string
  bundleIdentifier: string
  cwd: string
  fixture: RuntimeDebugFixture | null
  captureState: boolean
  timeoutSeconds: number
  execute: RuntimeCommandExecutor
  wait?: (milliseconds: number) => Promise<void>
}

export interface RuntimeDebugBridgeResponse {
  schemaVersion: 1
  requestId: string
  completedAt: string
  fixture: { id: string; appliedAt: string } | null
  state?: JsonValue
}

const debugBridgeResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    completedAt: z.string().datetime({ offset: true }),
    fixture: z
      .object({
        id: z.string().min(1).max(128),
        appliedAt: z.string().datetime({ offset: true })
      })
      .strict()
      .nullable(),
    state: z.json().optional(),
    error: z
      .object({
        message: z.string().min(1).max(2_000)
      })
      .strict()
      .optional()
  })
  .strict()

export class IosDebugBridgeError extends Error {}

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
    throw new IosDebugBridgeError(`${label}이 심볼릭 링크가 아닌 디렉터리여야 합니다.`)
  }
  return realpath(path)
}

async function ensureChildDirectory(
  parent: string,
  name: string,
  label: string
): Promise<string> {
  const candidate = resolve(parent, name)
  if (!isContainedPath(parent, candidate)) {
    throw new IosDebugBridgeError(`${label}가 허용된 상위 경로를 벗어났습니다.`)
  }
  const stats = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stats) await mkdir(candidate)
  const resolved = await requireDirectory(candidate, label)
  if (!isContainedPath(parent, resolved)) {
    throw new IosDebugBridgeError(`${label}가 허용된 상위 경로 밖을 가리킵니다.`)
  }
  return resolved
}

async function prepareBridgeDirectories(
  input: RuntimeDebugBridgeRequestInput
): Promise<{ requests: string; responses: string }> {
  const containerResult = await input.execute({
    command: XCRUN_COMMAND,
    args: [
      'simctl',
      'get_app_container',
      input.deviceId,
      input.bundleIdentifier,
      'data'
    ],
    cwd: input.cwd,
    label: 'Simulator Debug bridge 앱 container 확인',
    timeoutMs: 30_000
  })
  if (containerResult.code !== 0) {
    throw new IosDebugBridgeError(
      containerResult.output.trim().slice(-2_000) || 'Simulator 앱 data container를 찾지 못했습니다.'
    )
  }
  const containerSource = (containerResult.stdout || containerResult.output).trim()
  if (!containerSource || containerSource.includes('\n')) {
    throw new IosDebugBridgeError('Simulator 앱 data container 경로가 올바르지 않습니다.')
  }
  const container = await requireDirectory(containerSource, 'Simulator 앱 data container')
  const library = await ensureChildDirectory(
    container,
    LIBRARY_DIRECTORY,
    'Simulator 앱 Library 경로'
  )
  const applicationSupport = await ensureChildDirectory(
    library,
    APPLICATION_SUPPORT_DIRECTORY,
    'Simulator 앱 Application Support 경로'
  )
  const bridge = await ensureChildDirectory(
    applicationSupport,
    BRIDGE_DIRECTORY,
    'Simulator Debug bridge'
  )
  const requests = await ensureChildDirectory(bridge, REQUEST_DIRECTORY, 'Simulator Debug bridge 요청 경로')
  const responses = await ensureChildDirectory(bridge, RESPONSE_DIRECTORY, 'Simulator Debug bridge 응답 경로')
  return { requests, responses }
}

function parseResponse(
  source: string,
  requestId: string,
  expectedFixture: RuntimeDebugFixture | null,
  captureState: boolean
): RuntimeDebugBridgeResponse {
  let parsed: z.infer<typeof debugBridgeResponseSchema>
  try {
    parsed = debugBridgeResponseSchema.parse(JSON.parse(source))
  } catch {
    throw new IosDebugBridgeError('Simulator Debug bridge 응답 JSON 계약이 올바르지 않습니다.')
  }
  if (parsed.requestId !== requestId) {
    throw new IosDebugBridgeError('Simulator Debug bridge 응답의 request ID가 요청과 다릅니다.')
  }
  if (parsed.error) {
    throw new IosDebugBridgeError(`대상 앱 Debug bridge 실패: ${parsed.error.message}`)
  }
  if (expectedFixture) {
    if (!parsed.fixture || parsed.fixture.id !== expectedFixture.id) {
      throw new IosDebugBridgeError('Simulator Debug bridge가 요청한 fixture 적용을 확인하지 않았습니다.')
    }
  } else if (parsed.fixture) {
    throw new IosDebugBridgeError('상태 요청에 예상하지 않은 fixture 결과가 포함됐습니다.')
  }
  if (captureState && parsed.state === undefined) {
    throw new IosDebugBridgeError('Simulator Debug bridge 응답에 요청한 앱 상태가 없습니다.')
  }
  if (!captureState && parsed.state !== undefined) {
    throw new IosDebugBridgeError('fixture 전용 응답에 예상하지 않은 앱 상태가 포함됐습니다.')
  }
  return {
    schemaVersion: 1,
    requestId: parsed.requestId,
    completedAt: parsed.completedAt,
    fixture: parsed.fixture,
    ...(parsed.state === undefined ? {} : { state: parsed.state })
  }
}

async function waitForResponse(
  responsePath: string,
  requestId: string,
  input: RuntimeDebugBridgeRequestInput
): Promise<RuntimeDebugBridgeResponse> {
  const startedAt = Date.now()
  const timeoutMilliseconds = input.timeoutSeconds * 1_000
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds)
  }))
  while (Date.now() - startedAt <= timeoutMilliseconds) {
    const stats = await lstat(responsePath).catch(() => null)
    if (stats) {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new IosDebugBridgeError('Simulator Debug bridge 응답은 심볼릭 링크가 아닌 일반 JSON 파일이어야 합니다.')
      }
      if (stats.size <= 0 || stats.size > MAX_RESPONSE_BYTES) {
        throw new IosDebugBridgeError(
          `Simulator Debug bridge 응답 크기가 허용 범위를 벗어났습니다: ${stats.size.toLocaleString('ko-KR')} bytes`
        )
      }
      return parseResponse(
        await readFile(responsePath, 'utf8'),
        requestId,
        input.fixture,
        input.captureState
      )
    }
    await wait(POLL_INTERVAL_MS)
  }
  throw new IosDebugBridgeError(
    `대상 앱이 ${input.timeoutSeconds}초 안에 Debug bridge 응답을 작성하지 않았습니다.`
  )
}

export async function requestIosDebugBridge(
  input: RuntimeDebugBridgeRequestInput
): Promise<RuntimeDebugBridgeResponse> {
  if (!input.fixture && !input.captureState) {
    throw new IosDebugBridgeError('Debug bridge 요청에 fixture 또는 상태 수집 목적이 필요합니다.')
  }
  const { requests, responses } = await prepareBridgeDirectories(input)
  const requestId = randomUUID()
  const requestPath = resolve(requests, `${requestId}.json`)
  const temporaryRequestPath = resolve(requests, `.${requestId}.tmp`)
  const responsePath = resolve(responses, `${requestId}.json`)
  const content = `${JSON.stringify({
    schemaVersion: 1,
    requestId,
    createdAt: new Date().toISOString(),
    captureState: input.captureState,
    fixture: input.fixture
  }, null, 2)}\n`
  const sizeBytes = Buffer.byteLength(content)
  if (sizeBytes <= 0 || sizeBytes > MAX_REQUEST_BYTES) {
    throw new IosDebugBridgeError(
      `Simulator Debug bridge 요청 크기가 허용 범위를 벗어났습니다: ${sizeBytes.toLocaleString('ko-KR')} bytes`
    )
  }
  await rm(responsePath, { force: true })
  try {
    await writeFile(temporaryRequestPath, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryRequestPath, requestPath)
    return await waitForResponse(responsePath, requestId, input)
  } finally {
    await rm(temporaryRequestPath, { force: true })
    await rm(requestPath, { force: true })
    await rm(responsePath, { force: true })
  }
}
