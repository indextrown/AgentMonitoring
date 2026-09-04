import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ProjectCapabilityManifest } from './project-capabilities'
import type {
  RuntimePrivacyPermission,
  RuntimeSessionRecord,
  RuntimeSessionStatus
} from '../../src/shared/types'
import {
  IosDebugBridgeError,
  requestIosDebugBridge,
  type RuntimeDebugBridgeResponse,
  type RuntimeDebugFixture
} from './ios-debug-bridge'

export interface RuntimeCommandRequest {
  command: string
  args: string[]
  cwd: string
  label: string
  timeoutMs: number
  environment?: NodeJS.ProcessEnv
}

export interface RuntimeCommandResult {
  code: number
  output: string
  stdout: string
}

export type RuntimeCommandExecutor = (
  request: RuntimeCommandRequest
) => Promise<RuntimeCommandResult>

export type RuntimeUiAction = NonNullable<
  ProjectCapabilityManifest['runtimeScenario']
>['actions'][number]

export type RuntimeDebugBridgeContract = NonNullable<ProjectCapabilityManifest['debugBridge']>

export interface IosSimulatorLaunchInput {
  taskId: string
  worktreePath: string
  runtimeRoot: string
  contract: ProjectCapabilityManifest['adapter']
  captureScreen: boolean
  captureAccessibility: boolean
  captureState: boolean
  privacyPermissions: RuntimePrivacyPermission[]
  uiActions: RuntimeUiAction[]
  debugBridge: RuntimeDebugBridgeContract | null
  debugFixture: RuntimeDebugFixture | null
  buildSettings?: Record<string, string>
  launchVariables?: Record<string, string>
  resetAppData?: boolean
  accessibilityObserverTemplateRoot?: string
  execute: RuntimeCommandExecutor
  wait?: (milliseconds: number) => Promise<void>
  onProgress: (
    status: RuntimeSessionStatus,
    message: string,
    update?: Partial<Pick<RuntimeSessionRecord, 'deviceId' | 'deviceName' | 'bundleIdentifier'>>
  ) => void
}

export interface RuntimeScreenEvidence {
  path: string
  mimeType: 'image/png'
  sizeBytes: number
  capturedAt: string
}

export interface RuntimeAccessibilityEvidence {
  path: string
  mimeType: 'application/json'
  sizeBytes: number
  capturedAt: string
  nodeCount: number
  truncated: boolean
  content: string
}

export interface RuntimeUiActionEvidence {
  path: string
  mimeType: 'application/json'
  sizeBytes: number
  executedAt: string
  actionCount: number
  content: string
}

export interface RuntimeDebugStateEvidence {
  path: string
  mimeType: 'application/json'
  sizeBytes: number
  capturedAt: string
  hasState: boolean
  fixtureId: string | null
  content: string
}

export interface IosSimulatorLaunchResult {
  deviceId: string
  deviceName: string
  bundleIdentifier: string
  processId: number | null
  appPath: string
  screenEvidence: RuntimeScreenEvidence | null
  accessibilityEvidence: RuntimeAccessibilityEvidence | null
  uiActionEvidence: RuntimeUiActionEvidence | null
  debugStateEvidence: RuntimeDebugStateEvidence | null
}

export interface IosSimulatorStopInput {
  session: RuntimeSessionRecord
  cwd: string
  execute: RuntimeCommandExecutor
}

export interface IosSimulatorRuntimeAdapter {
  launch: (input: IosSimulatorLaunchInput) => Promise<IosSimulatorLaunchResult>
  stop: (input: IosSimulatorStopInput) => Promise<void>
}

export interface SimulatorDevice {
  runtime: string
  udid: string
  name: string
  state: string
  isAvailable: boolean
  lastBootedAt: string | null
  deviceTypeIdentifier: string | null
}

export type IosSimulatorDeviceFamily = ProjectCapabilityManifest['adapter']['deviceFamily']

interface XcodeBuildSettingsEntry {
  target?: string
  buildSettings?: Record<string, unknown>
}

const RUNTIME_TIMEOUTS = {
  inspect: 30_000,
  boot: 5 * 60_000,
  build: 30 * 60_000,
  install: 2 * 60_000,
  launch: 60_000,
  observe: 30_000,
  accessibility: 5 * 60_000,
  stop: 30_000
} as const

const XCRUN_COMMAND = '/usr/bin/xcrun'
const SCREEN_SETTLE_MS = 1_000
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024
const MAX_ACCESSIBILITY_JSON_BYTES = 512 * 1024
const MAX_ACCESSIBILITY_EVIDENCE_BYTES = 1024 * 1024
const MAX_UI_ACTION_JSON_BYTES = 128 * 1024
const MAX_UI_ACTION_EVIDENCE_BYTES = 256 * 1024
const MAX_DEBUG_STATE_EVIDENCE_BYTES = 1024 * 1024
const ACCESSIBILITY_BEGIN_MARKER = 'AGENTMONITOR_ACCESSIBILITY_BEGIN'
const ACCESSIBILITY_END_MARKER = 'AGENTMONITOR_ACCESSIBILITY_END'
const UI_ACTIONS_BEGIN_MARKER = 'AGENTMONITOR_UI_ACTIONS_BEGIN'
const UI_ACTIONS_END_MARKER = 'AGENTMONITOR_UI_ACTIONS_END'
const UI_FAILURE_BEGIN_MARKER = 'AGENTMONITOR_UI_FAILURE_BEGIN'
const UI_FAILURE_END_MARKER = 'AGENTMONITOR_UI_FAILURE_END'
const ACCESSIBILITY_OBSERVER_NAME = 'AgentMonitoringAccessibility'
const ACCESSIBILITY_OBSERVER_TARGET_ID = 'AA0000000000000000000001'

interface AccessibilityTreeNode {
  elementType: string
  identifier: string
  label: string
  title: string
  enabled: boolean
  selected: boolean
  frame: { x: number; y: number; width: number; height: number }
  value?: string
  placeholderValue?: string
  truncated?: boolean
  children: AccessibilityTreeNode[]
}

export interface AccessibilityTreePayload {
  schemaVersion: 1
  bundleIdentifier: string
  capturedAt: string
  nodeCount: number
  truncated: boolean
  root: AccessibilityTreeNode
}

interface RuntimeUiActionResult {
  index: number
  kind: RuntimeUiAction['kind']
  identifier: string
  durationMilliseconds: number
}

export interface RuntimeUiActionPayload {
  schemaVersion: 1
  bundleIdentifier: string
  executedAt: string
  actionCount: number
  results: RuntimeUiActionResult[]
}

export interface RuntimeUiFailurePayload {
  schemaVersion: 1
  bundleIdentifier: string
  failedAt: string
  failure: {
    index: number
    kind: RuntimeUiAction['kind']
    identifier: string
    completedActionCount: number
    message: string
  }
  completedActions: RuntimeUiActionResult[]
}

const boundedAccessibilityString = z.string().max(2_000)
const accessibilityTreeNodeSchema: z.ZodType<AccessibilityTreeNode> = z.lazy(() =>
  z
    .object({
      elementType: z.string().min(1).max(128),
      identifier: boundedAccessibilityString,
      label: boundedAccessibilityString,
      title: boundedAccessibilityString,
      enabled: z.boolean(),
      selected: z.boolean(),
      frame: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite(),
          height: z.number().finite()
        })
        .strict(),
      value: boundedAccessibilityString.optional(),
      placeholderValue: boundedAccessibilityString.optional(),
      truncated: z.boolean().optional(),
      children: z.array(accessibilityTreeNodeSchema).max(5_000)
    })
    .strict()
)
const accessibilityTreePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleIdentifier: z.string().min(1).max(512),
    capturedAt: z.string().datetime({ offset: true }),
    nodeCount: z.number().int().min(1).max(5_000),
    truncated: z.boolean(),
    root: accessibilityTreeNodeSchema
  })
  .strict()
const runtimeUiActionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleIdentifier: z.string().min(1).max(512),
    executedAt: z.string().datetime({ offset: true }),
    actionCount: z.number().int().min(1).max(20),
    results: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(19),
            kind: z.enum(['tap', 'type-text']),
            identifier: z.string().min(1).max(256),
            durationMilliseconds: z.number().finite().min(0).max(5 * 60_000)
          })
          .strict()
      )
      .min(1)
      .max(20)
  })
  .strict()
const runtimeUiFailurePayloadSchema = z.object({
  schemaVersion: z.literal(1),
  bundleIdentifier: z.string().min(1).max(512),
  failedAt: z.string().datetime({ offset: true }),
  failure: z.object({
    index: z.number().int().min(0).max(19),
    kind: z.enum(['tap', 'type-text']),
    identifier: z.string().min(1).max(256),
    completedActionCount: z.number().int().min(0).max(20),
    message: z.string().min(1).max(1_000)
  }).strict(),
  completedActions: z.array(z.object({
    index: z.number().int().min(0).max(19),
    kind: z.enum(['tap', 'type-text']),
    identifier: z.string().min(1).max(256),
    durationMilliseconds: z.number().finite().min(0).max(5 * 60_000)
  }).strict()).max(20)
}).strict()

export class IosRuntimeStageError extends Error {
  constructor(
    readonly status: RuntimeSessionStatus,
    message: string,
    readonly failureEvidence: Partial<Pick<IosSimulatorLaunchResult, 'screenEvidence' | 'accessibilityEvidence' | 'uiActionEvidence'>> | null = null
  ) {
    super(message)
  }
}

function redactSensitiveValues(source: string, values: string[]): string {
  return values
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((result, value) => result.split(value).join('[REDACTED]'), source)
}

function xcconfigValue(value: string): string {
  if (/\r|\n|\u0000/.test(value)) {
    throw new IosRuntimeStageError('preparing', '실행 환경값에는 줄바꿈이나 NUL 문자를 사용할 수 없습니다.')
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$')}"`
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    throw new IosRuntimeStageError('failed', `${label} JSON을 해석할 수 없습니다.`)
  }
}

function decodeObserverPayload(
  source: string,
  beginMarker: string,
  endMarker: string,
  label: string,
  maximumBytes: number,
  status: RuntimeSessionStatus
): unknown {
  const beginIndex = source.lastIndexOf(beginMarker)
  const endIndex = source.indexOf(endMarker, beginIndex)
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
    throw new IosRuntimeStageError(
      status,
      `XCTest observer 출력에서 ${label} marker를 찾지 못했습니다.`
    )
  }
  const encodedLines = source
    .slice(beginIndex + beginMarker.length, endIndex)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    encodedLines.length === 0 ||
    encodedLines.some((line) => !/^[A-Za-z0-9+/=]+$/.test(line))
  ) {
    throw new IosRuntimeStageError(status, `${label} payload가 올바른 base64가 아닙니다.`)
  }
  const encoded = encodedLines.join('')
  if (encoded.length > Math.ceil(maximumBytes / 3) * 4 + 4) {
    throw new IosRuntimeStageError(status, `${label} payload가 허용 크기를 초과했습니다.`)
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength === 0 || decoded.byteLength > maximumBytes) {
    throw new IosRuntimeStageError(
      status,
      `${label} 크기가 허용 범위를 벗어났습니다: ${decoded.byteLength.toLocaleString('ko-KR')} bytes`
    )
  }
  try {
    return JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new IosRuntimeStageError(status, `${label} JSON을 해석할 수 없습니다.`)
  }
}

export function parseAccessibilityObserverOutput(
  source: string,
  expectedBundleIdentifier: string
): AccessibilityTreePayload {
  const decoded = decodeObserverPayload(
    source,
    ACCESSIBILITY_BEGIN_MARKER,
    ACCESSIBILITY_END_MARKER,
    '접근성 트리',
    MAX_ACCESSIBILITY_JSON_BYTES,
    'observing'
  )

  let payload: AccessibilityTreePayload
  try {
    payload = accessibilityTreePayloadSchema.parse(decoded)
  } catch {
    throw new IosRuntimeStageError('observing', '접근성 트리 JSON 계약이 올바르지 않습니다.')
  }
  if (payload.bundleIdentifier !== expectedBundleIdentifier) {
    throw new IosRuntimeStageError(
      'observing',
      `접근성 트리의 bundle identifier가 실행한 앱과 다릅니다: ${payload.bundleIdentifier}`
    )
  }
  return payload
}

export function parseUiActionObserverOutput(
  source: string,
  expectedBundleIdentifier: string,
  expectedActions: RuntimeUiAction[]
): RuntimeUiActionPayload {
  const decoded = decodeObserverPayload(
    source,
    UI_ACTIONS_BEGIN_MARKER,
    UI_ACTIONS_END_MARKER,
    'UI 조작 결과',
    MAX_UI_ACTION_JSON_BYTES,
    'acting'
  )
  let payload: RuntimeUiActionPayload
  try {
    payload = runtimeUiActionPayloadSchema.parse(decoded)
  } catch {
    throw new IosRuntimeStageError('acting', 'UI 조작 결과 JSON 계약이 올바르지 않습니다.')
  }
  if (payload.bundleIdentifier !== expectedBundleIdentifier) {
    throw new IosRuntimeStageError(
      'acting',
      `UI 조작 결과의 bundle identifier가 실행한 앱과 다릅니다: ${payload.bundleIdentifier}`
    )
  }
  if (
    payload.actionCount !== expectedActions.length ||
    payload.results.length !== expectedActions.length ||
    payload.results.some((result, index) => {
      const expected = expectedActions[index]
      return (
        result.index !== index ||
        result.kind !== expected?.kind ||
        result.identifier !== expected?.identifier
      )
    })
  ) {
    throw new IosRuntimeStageError('acting', 'UI 조작 결과가 요청한 action 계약과 다릅니다.')
  }
  return payload
}

export function parseUiFailureObserverOutput(
  source: string,
  expectedBundleIdentifier: string
): RuntimeUiFailurePayload {
  const decoded = decodeObserverPayload(
    source,
    UI_FAILURE_BEGIN_MARKER,
    UI_FAILURE_END_MARKER,
    'UI 조작 실패 결과',
    MAX_UI_ACTION_JSON_BYTES,
    'acting'
  )
  const payload = runtimeUiFailurePayloadSchema.parse(decoded)
  if (payload.bundleIdentifier !== expectedBundleIdentifier) {
    throw new IosRuntimeStageError('acting', 'UI 조작 실패 결과의 bundle identifier가 실행한 앱과 다릅니다.')
  }
  return payload
}

function accessibilityTestPlan(
  bundleIdentifier: string,
  captureAccessibility: boolean,
  uiActions: RuntimeUiAction[]
): string {
  const encodedActions = Buffer.from(JSON.stringify(uiActions), 'utf8').toString('base64')
  return `${JSON.stringify(
    {
      configurations: [
        {
          id: 'AA000000-0000-4000-8000-000000000001',
          name: 'Accessibility',
          options: {
            environmentVariableEntries: [
              {
                key: 'AGENTMONITOR_TARGET_BUNDLE_ID',
                value: bundleIdentifier,
                enabled: true
              },
              {
                key: 'AGENTMONITOR_CAPTURE_ACCESSIBILITY',
                value: captureAccessibility ? '1' : '0',
                enabled: true
              },
              {
                key: 'AGENTMONITOR_UI_ACTIONS_BASE64',
                value: encodedActions,
                enabled: true
              }
            ]
          }
        }
      ],
      defaultOptions: {},
      testTargets: [
        {
          target: {
            containerPath: `container:${ACCESSIBILITY_OBSERVER_NAME}.xcodeproj`,
            identifier: ACCESSIBILITY_OBSERVER_TARGET_ID,
            name: `${ACCESSIBILITY_OBSERVER_NAME}Tests`
          }
        }
      ],
      version: 1
    },
    null,
    2
  )}\n`
}

async function findAccessibilityObserverTemplate(
  requestedRoot?: string
): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    requestedRoot,
    resourcesPath ? resolve(resourcesPath, 'ios-accessibility-observer') : null,
    resolve(process.cwd(), 'resources', 'ios-accessibility-observer')
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of [...new Set(candidates)]) {
    const stats = await lstat(candidate).catch(() => null)
    if (stats?.isDirectory() && !stats.isSymbolicLink()) return realpath(candidate)
  }
  throw new IosRuntimeStageError(
    'observing',
    '번들된 XCTest 접근성 observer를 찾지 못했습니다. AgentMonitoring을 다시 빌드하세요.'
  )
}

async function prepareAccessibilityObserver(
  sessionRoot: string,
  bundleIdentifier: string,
  captureAccessibility: boolean,
  uiActions: RuntimeUiAction[],
  requestedTemplateRoot?: string
): Promise<{ projectPath: string; derivedDataPath: string }> {
  const templateRoot = await findAccessibilityObserverTemplate(requestedTemplateRoot)
  const observerRoot = resolve(sessionRoot, 'accessibility-observer')
  if (!observerRoot.startsWith(`${sessionRoot}/`)) {
    throw new IosRuntimeStageError('observing', '안전하지 않은 접근성 observer 경로입니다.')
  }
  await rm(observerRoot, { recursive: true, force: true })
  await cp(templateRoot, observerRoot, { recursive: true })
  const resolvedObserverRoot = await requireContainedDirectory(
    sessionRoot,
    'accessibility-observer',
    '접근성 observer'
  )
  await writeFile(
    resolve(resolvedObserverRoot, `${ACCESSIBILITY_OBSERVER_NAME}.xctestplan`),
    accessibilityTestPlan(bundleIdentifier, captureAccessibility, uiActions),
    'utf8'
  )
  await mkdir(resolve(resolvedObserverRoot, 'DerivedData'), { recursive: true })
  return {
    projectPath: resolve(resolvedObserverRoot, `${ACCESSIBILITY_OBSERVER_NAME}.xcodeproj`),
    derivedDataPath: await requireContainedDirectory(
      resolvedObserverRoot,
      'DerivedData',
      '접근성 observer DerivedData'
    )
  }
}

export function parseAvailableSimulatorDevices(
  source: string,
  family: IosSimulatorDeviceFamily
): SimulatorDevice[] {
  const payload = parseJson(source, 'Simulator 기기 목록') as {
    devices?: Record<string, Array<Record<string, unknown>>>
  }
  const devices = Object.entries(payload.devices ?? {}).flatMap(([runtime, entries]) =>
    entries.map((entry) => ({
      runtime,
      udid: String(entry.udid ?? ''),
      name: String(entry.name ?? ''),
      state: String(entry.state ?? ''),
      isAvailable: entry.isAvailable !== false,
      lastBootedAt: entry.lastBootedAt ? String(entry.lastBootedAt) : null,
      deviceTypeIdentifier: entry.deviceTypeIdentifier
        ? String(entry.deviceTypeIdentifier)
        : null
    }))
  )

  return devices
    .filter((device) => {
      const deviceTypeIdentifier = device.deviceTypeIdentifier?.toLowerCase() ?? ''
      const deviceName = device.name.toLowerCase()
      return (
        device.isAvailable &&
        device.udid &&
        (deviceTypeIdentifier.includes(`.${family}-`) || deviceName.startsWith(family))
      )
    })
    .sort((left, right) => {
      const booted = Number(right.state === 'Booted') - Number(left.state === 'Booted')
      if (booted !== 0) return booted
      const runtime = right.runtime.localeCompare(left.runtime, undefined, { numeric: true })
      if (runtime !== 0) return runtime
      return (right.lastBootedAt ?? '').localeCompare(left.lastBootedAt ?? '')
    })
}

export function parseXcodeAppProduct(source: string): {
  targetBuildDirectory: string
  wrapperName: string
  bundleIdentifier: string
} {
  const payload = parseJson(source, 'Xcode build settings')
  if (!Array.isArray(payload)) {
    throw new IosRuntimeStageError('building', 'Xcode build settings 응답이 배열이 아닙니다.')
  }

  const candidates = (payload as XcodeBuildSettingsEntry[])
    .map((entry) => {
      const settings = entry.buildSettings ?? {}
      return {
        target: entry.target ?? '',
        targetBuildDirectory: String(settings.TARGET_BUILD_DIR ?? ''),
        wrapperName: String(settings.WRAPPER_NAME ?? ''),
        bundleIdentifier: String(settings.PRODUCT_BUNDLE_IDENTIFIER ?? ''),
        wrapperExtension: String(settings.WRAPPER_EXTENSION ?? ''),
        productType: String(settings.PRODUCT_TYPE ?? ''),
        skipInstall: String(settings.SKIP_INSTALL ?? '')
      }
    })
    .filter(
      (candidate) =>
        candidate.targetBuildDirectory &&
        candidate.wrapperName &&
        candidate.bundleIdentifier &&
        candidate.wrapperExtension === 'app' &&
        candidate.productType === 'com.apple.product-type.application'
    )
    .sort((left, right) => Number(left.skipInstall === 'YES') - Number(right.skipInstall === 'YES'))

  const product = candidates[0]
  if (!product) {
    throw new IosRuntimeStageError(
      'building',
      'scheme에서 설치 가능한 iOS 앱 산출물과 bundle identifier를 찾지 못했습니다.'
    )
  }
  return product
}

async function executeRequired(
  execute: RuntimeCommandExecutor,
  request: RuntimeCommandRequest,
  status: RuntimeSessionStatus
): Promise<RuntimeCommandResult> {
  const result = await execute(request)
  if (result.code !== 0) {
    const detail = result.output.trim().slice(-2_000)
    throw new IosRuntimeStageError(status, detail ? `${request.label} 실패\n${detail}` : `${request.label} 실패`)
  }
  return result
}

async function requireContainedDirectory(
  rootPath: string,
  candidatePath: string,
  label: string
): Promise<string> {
  const root = await realpath(rootPath)
  const candidate = resolve(root, candidatePath)
  const stats = await lstat(candidate)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new IosRuntimeStageError('preparing', `${label}은 심볼릭 링크가 아닌 디렉터리여야 합니다.`)
  }
  const resolvedCandidate = await realpath(candidate)
  if (!resolvedCandidate.startsWith(`${root}/`)) {
    throw new IosRuntimeStageError('preparing', `${label}이 격리 worktree 밖을 가리킵니다.`)
  }
  return resolvedCandidate
}

function xcodeContainerArguments(containerPath: string): string[] {
  return containerPath.endsWith('.xcworkspace')
    ? ['-workspace', containerPath]
    : ['-project', containerPath]
}

function parseProcessId(output: string): number | null {
  const match = output.match(/:\s*(\d+)\s*$/m)
  return match ? Number(match[1]) : null
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function writeRuntimeJsonEvidence(
  sessionRoot: string,
  prefix: string,
  payload: unknown,
  maximumBytes: number,
  status: RuntimeSessionStatus,
  label: string
): Promise<{ path: string; sizeBytes: number; content: string }> {
  await mkdir(resolve(sessionRoot, 'evidence'), { recursive: true })
  const evidenceRoot = await requireContainedDirectory(
    sessionRoot,
    'evidence',
    'runtime evidence'
  )
  const evidencePath = resolve(evidenceRoot, `${prefix}-${randomUUID()}.json`)
  const content = `${JSON.stringify(payload, null, 2)}\n`
  const sizeBytes = Buffer.byteLength(content)
  if (sizeBytes <= 0 || sizeBytes > maximumBytes) {
    throw new IosRuntimeStageError(
      status,
      `${label} 크기가 허용 범위를 벗어났습니다: ${sizeBytes.toLocaleString('ko-KR')} bytes`
    )
  }
  await writeFile(evidencePath, content, 'utf8')
  const resolvedEvidencePath = await realpath(evidencePath)
  if (!resolvedEvidencePath.startsWith(`${evidenceRoot}/`)) {
    throw new IosRuntimeStageError(status, `${label}가 작업별 runtime 경로 밖을 가리킵니다.`)
  }
  return { path: resolvedEvidencePath, sizeBytes, content }
}

export async function launchIosSimulatorRuntime(
  input: IosSimulatorLaunchInput
): Promise<IosSimulatorLaunchResult> {
  const sensitiveValues = [
    ...Object.values(input.buildSettings ?? {}),
    ...Object.values(input.launchVariables ?? {})
  ]
  const execute: RuntimeCommandExecutor = async (request) => {
    const result = await input.execute(request)
    return {
      ...result,
      output: redactSensitiveValues(result.output, sensitiveValues),
      stdout: redactSensitiveValues(result.stdout, sensitiveValues)
    }
  }
  const deviceFamilyLabel = input.contract.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'
  input.onProgress(
    'preparing',
    `${deviceFamilyLabel} Simulator runtime 계약과 worktree를 확인하고 있습니다.`
  )
  const worktreePath = await realpath(input.worktreePath)
  const containerPath = await requireContainedDirectory(worktreePath, input.contract.container, 'Xcode container')
  await mkdir(resolve(input.runtimeRoot), { recursive: true })
  const runtimeRoot = await realpath(resolve(input.runtimeRoot))
  const sessionRoot = resolve(runtimeRoot, input.taskId)
  if (!sessionRoot.startsWith(`${runtimeRoot}/`)) {
    throw new IosRuntimeStageError('preparing', '안전하지 않은 runtime session 경로입니다.')
  }
  await mkdir(sessionRoot, { recursive: true })
  const resolvedSessionRoot = await requireContainedDirectory(
    runtimeRoot,
    input.taskId,
    'runtime session'
  )
  await mkdir(resolve(resolvedSessionRoot, 'DerivedData'), { recursive: true })
  const derivedDataPath = await requireContainedDirectory(
    resolvedSessionRoot,
    'DerivedData',
    'DerivedData'
  )

  const deviceList = await executeRequired(
    execute,
    {
      command: XCRUN_COMMAND,
      args: ['simctl', 'list', 'devices', 'available', '--json'],
      cwd: worktreePath,
      label: '사용 가능한 Simulator 조회',
      timeoutMs: RUNTIME_TIMEOUTS.inspect
    },
    'preparing'
  )
  const device = parseAvailableSimulatorDevices(deviceList.stdout, input.contract.deviceFamily)[0]
  if (!device) {
    throw new IosRuntimeStageError(
      'preparing',
      `사용 가능한 ${deviceFamilyLabel} Simulator가 없습니다. Xcode에서 ${deviceFamilyLabel} Simulator 기기를 만든 뒤 다시 실행하세요.`
    )
  }

  input.onProgress(
    'booting',
    `${device.name} 부팅을 준비하고 있습니다.`,
    { deviceId: device.udid, deviceName: device.name }
  )
  await executeRequired(
    execute,
    {
      command: XCRUN_COMMAND,
      args: ['simctl', 'bootstatus', device.udid, '-b'],
      cwd: worktreePath,
      label: `${device.name} 부팅`,
      timeoutMs: RUNTIME_TIMEOUTS.boot
    },
    'booting'
  )
  await executeRequired(
    execute,
    {
      command: '/usr/bin/open',
      args: ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid],
      cwd: worktreePath,
      label: 'Simulator 창 열기',
      timeoutMs: RUNTIME_TIMEOUTS.inspect
    },
    'booting'
  )

  const runtimeXcconfigPath = resolve(resolvedSessionRoot, 'runtime-environment.xcconfig')
  const buildSettingEntries = Object.entries(input.buildSettings ?? {})
  if (buildSettingEntries.length > 0) {
    await writeFile(
      runtimeXcconfigPath,
      `${buildSettingEntries.map(([key, value]) => `${key} = ${xcconfigValue(value)}`).join('\n')}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
  }
  const commonXcodeArguments = [
    ...xcodeContainerArguments(containerPath),
    '-scheme',
    input.contract.scheme,
    '-configuration',
    input.contract.configuration,
    '-sdk',
    'iphonesimulator',
    '-destination',
    `id=${device.udid}`,
    '-derivedDataPath',
    derivedDataPath,
    ...(buildSettingEntries.length > 0 ? ['-xcconfig', runtimeXcconfigPath] : [])
  ]

  input.onProgress(
    'building',
    `${input.contract.scheme} ${input.contract.configuration} 앱을 격리 worktree에서 빌드하고 있습니다.`
  )
  let buildSettings: RuntimeCommandResult
  try {
    await executeRequired(
      execute,
      {
        command: XCRUN_COMMAND,
        args: ['xcodebuild', ...commonXcodeArguments, 'build'],
        cwd: worktreePath,
        label: 'Swift 앱 빌드',
        timeoutMs: RUNTIME_TIMEOUTS.build
      },
      'building'
    )
    buildSettings = await executeRequired(
      execute,
      {
        command: XCRUN_COMMAND,
        args: ['xcodebuild', ...commonXcodeArguments, '-showBuildSettings', '-json'],
        cwd: worktreePath,
        label: '앱 산출물 설정 확인',
        timeoutMs: RUNTIME_TIMEOUTS.inspect
      },
      'building'
    )
  } finally {
    await rm(runtimeXcconfigPath, { force: true })
  }
  const product = parseXcodeAppProduct(buildSettings.stdout)
  const appPath = await requireContainedDirectory(
    derivedDataPath,
    resolve(product.targetBuildDirectory, product.wrapperName),
    '빌드된 앱'
  )

  input.onProgress(
    'installing',
    `${device.name}에 ${product.wrapperName}을 설치하고 있습니다.`,
    { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
  )
  if (input.resetAppData) {
    await execute({
      command: XCRUN_COMMAND,
      args: ['simctl', 'uninstall', device.udid, product.bundleIdentifier],
      cwd: worktreePath,
      label: 'Simulator 앱 데이터 초기화',
      timeoutMs: RUNTIME_TIMEOUTS.install
    })
  }
  await executeRequired(
    execute,
    {
      command: XCRUN_COMMAND,
      args: ['simctl', 'install', device.udid, appPath],
      cwd: worktreePath,
      label: 'Simulator 앱 설치',
      timeoutMs: RUNTIME_TIMEOUTS.install
    },
    'installing'
  )

  if (input.privacyPermissions.length > 0) {
    input.onProgress(
      'preparing',
      `${device.name}에 개인정보 권한 ${input.privacyPermissions.length.toLocaleString('ko-KR')}개를 준비하고 있습니다.`,
      { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
    )
    for (const permission of input.privacyPermissions) {
      const action = permission.state === 'granted'
        ? 'grant'
        : permission.state === 'denied'
          ? 'revoke'
          : 'reset'
      await executeRequired(
        execute,
        {
          command: XCRUN_COMMAND,
          args: [
            'simctl',
            'privacy',
            device.udid,
            action,
            permission.service,
            product.bundleIdentifier
          ],
          cwd: worktreePath,
          label: `Simulator ${permission.service} 권한 ${action}`,
          timeoutMs: RUNTIME_TIMEOUTS.inspect
        },
        'preparing'
      )
    }
  }

  input.onProgress(
    'launching',
    `${product.bundleIdentifier} 앱을 실행하고 있습니다.`,
    { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
  )
  const launchResult = await executeRequired(
    execute,
    {
      command: XCRUN_COMMAND,
      args: [
        'simctl',
        'launch',
        '--terminate-running-process',
        device.udid,
        product.bundleIdentifier
      ],
      cwd: worktreePath,
      label: 'Simulator 앱 실행',
      timeoutMs: RUNTIME_TIMEOUTS.launch,
      environment: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(input.launchVariables ?? {}).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value])
        )
      }
    },
    'launching'
  )

  let fixtureResponse: RuntimeDebugBridgeResponse | null = null
  if (input.debugBridge && input.debugFixture) {
    input.onProgress(
      'acting',
      `${device.name}의 Debug bridge에 fixture ${input.debugFixture.id}를 적용하고 있습니다.`,
      { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
    )
    try {
      fixtureResponse = await requestIosDebugBridge({
        deviceId: device.udid,
        bundleIdentifier: product.bundleIdentifier,
        cwd: worktreePath,
        fixture: input.debugFixture,
        captureState: false,
        timeoutSeconds: input.debugBridge.responseTimeoutSeconds,
        execute,
        wait: input.wait
      })
    } catch (error) {
      throw new IosRuntimeStageError(
        'acting',
        error instanceof IosDebugBridgeError ? error.message : String(error)
      )
    }
  }

  let accessibilityEvidence: RuntimeAccessibilityEvidence | null = null
  let uiActionEvidence: RuntimeUiActionEvidence | null = null
  if (input.captureAccessibility || input.uiActions.length > 0) {
    const automationStatus: RuntimeSessionStatus = input.uiActions.length > 0
      ? 'acting'
      : 'observing'
    const automationMessage = input.uiActions.length > 0
      ? `${device.name}에서 accessibility identifier UI 조작 ${input.uiActions.length.toLocaleString('ko-KR')}단계를 실행하고 있습니다.`
      : `${device.name}에서 ${product.bundleIdentifier} 앱의 접근성 트리를 수집하고 있습니다.`
    input.onProgress(
      automationStatus,
      automationMessage,
      { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
    )
    const observer = await prepareAccessibilityObserver(
      resolvedSessionRoot,
      product.bundleIdentifier,
      input.captureAccessibility,
      input.uiActions,
      input.accessibilityObserverTemplateRoot
    )
    const observerRequest: RuntimeCommandRequest = {
        command: XCRUN_COMMAND,
        args: [
          'xcodebuild',
          '-project',
          observer.projectPath,
          '-scheme',
          ACCESSIBILITY_OBSERVER_NAME,
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          `id=${device.udid}`,
          '-derivedDataPath',
          observer.derivedDataPath,
          `-only-testing:${ACCESSIBILITY_OBSERVER_NAME}Tests/AccessibilitySnapshotTests/testRunRuntimeAutomation`,
          'test'
        ],
        cwd: worktreePath,
        label: input.uiActions.length > 0
          ? 'Simulator identifier UI 조작'
          : 'Simulator 접근성 트리 수집',
        timeoutMs: RUNTIME_TIMEOUTS.accessibility
      }
    const observerResult = await execute(observerRequest)
    const observerOutput = observerResult.stdout || observerResult.output
    if (observerResult.code !== 0) {
      const failureEvidence: Partial<Pick<IosSimulatorLaunchResult, 'screenEvidence' | 'accessibilityEvidence' | 'uiActionEvidence'>> = {}
      let failureMessage: string | null = null
      try {
        const failure = parseUiFailureObserverOutput(observerOutput, product.bundleIdentifier)
        failureMessage = failure.failure.message
        const actionEvidence = await writeRuntimeJsonEvidence(
          resolvedSessionRoot,
          'ui-actions-failed',
          failure,
          MAX_UI_ACTION_EVIDENCE_BYTES,
          'acting',
          '실패한 UI 조작 증거'
        )
        failureEvidence.uiActionEvidence = {
          path: actionEvidence.path,
          mimeType: 'application/json',
          sizeBytes: actionEvidence.sizeBytes,
          executedAt: failure.failedAt,
          actionCount: failure.failure.completedActionCount,
          content: actionEvidence.content
        }
      } catch {
        // XCTest가 기계 판독 marker를 남기지 못해도 나머지 실패 증거를 계속 수집합니다.
      }
      try {
        const accessibility = parseAccessibilityObserverOutput(observerOutput, product.bundleIdentifier)
        const treeEvidence = await writeRuntimeJsonEvidence(
          resolvedSessionRoot,
          'accessibility-failed',
          accessibility,
          MAX_ACCESSIBILITY_EVIDENCE_BYTES,
          'observing',
          '실패 시점 접근성 증거'
        )
        failureEvidence.accessibilityEvidence = {
          path: treeEvidence.path,
          mimeType: 'application/json',
          sizeBytes: treeEvidence.sizeBytes,
          capturedAt: accessibility.capturedAt,
          nodeCount: accessibility.nodeCount,
          truncated: accessibility.truncated,
          content: treeEvidence.content
        }
      } catch {
        // 접근성 트리가 손상돼도 Simulator 화면 캡처를 시도합니다.
      }
      try {
        await mkdir(resolve(resolvedSessionRoot, 'evidence'), { recursive: true })
        const evidenceRoot = await requireContainedDirectory(resolvedSessionRoot, 'evidence', 'runtime evidence')
        const screenshotPath = resolve(evidenceRoot, `screen-failed-${randomUUID()}.png`)
        const screenshotResult = await execute({
          command: XCRUN_COMMAND,
          args: ['simctl', 'io', device.udid, 'screenshot', '--type=png', screenshotPath],
          cwd: worktreePath,
          label: '실패 시점 Simulator 화면 캡처',
          timeoutMs: RUNTIME_TIMEOUTS.observe
        })
        const screenshotStats = screenshotResult.code === 0 ? await lstat(screenshotPath).catch(() => null) : null
        if (screenshotStats?.isFile() && !screenshotStats.isSymbolicLink() && screenshotStats.size > 0 && screenshotStats.size <= MAX_SCREENSHOT_BYTES) {
          failureEvidence.screenEvidence = {
            path: await realpath(screenshotPath),
            mimeType: 'image/png',
            sizeBytes: screenshotStats.size,
            capturedAt: new Date().toISOString()
          }
        }
      } catch {
        // 화면 캡처 자체가 실패해도 원래 XCTest 오류와 이미 모은 증거는 보존합니다.
      }
      const detail = observerResult.output.trim().slice(-2_000)
      const exactFailure = observerResult.output.match(/UI action\s+\d+: identifier '[^']+' (?:요소를 찾지 못했습니다\.|요소가 \d+개여서 조작을 중단했습니다\.)/)?.[0]
      throw new IosRuntimeStageError(
        automationStatus,
        exactFailure ?? failureMessage ?? (detail ? `${observerRequest.label} 실패\n${detail}` : `${observerRequest.label} 실패`),
        Object.keys(failureEvidence).length > 0 ? failureEvidence : null
      )
    }
    if (input.uiActions.length > 0) {
      const payload = parseUiActionObserverOutput(
        observerOutput,
        product.bundleIdentifier,
        input.uiActions
      )
      const evidence = await writeRuntimeJsonEvidence(
        resolvedSessionRoot,
        'ui-actions',
        payload,
        MAX_UI_ACTION_EVIDENCE_BYTES,
        'acting',
        'UI 조작 증거'
      )
      uiActionEvidence = {
        path: evidence.path,
        mimeType: 'application/json',
        sizeBytes: evidence.sizeBytes,
        executedAt: payload.executedAt,
        actionCount: payload.actionCount,
        content: evidence.content
      }
    }
    if (input.captureAccessibility) {
      const payload = parseAccessibilityObserverOutput(
        observerOutput,
        product.bundleIdentifier
      )
      const evidence = await writeRuntimeJsonEvidence(
        resolvedSessionRoot,
        'accessibility',
        payload,
        MAX_ACCESSIBILITY_EVIDENCE_BYTES,
        'observing',
        '접근성 증거'
      )
      accessibilityEvidence = {
        path: evidence.path,
        mimeType: 'application/json',
        sizeBytes: evidence.sizeBytes,
        capturedAt: payload.capturedAt,
        nodeCount: payload.nodeCount,
        truncated: payload.truncated,
        content: evidence.content
      }
    }
  }

  let stateResponse: RuntimeDebugBridgeResponse | null = null
  if (input.debugBridge && input.captureState) {
    input.onProgress(
      'observing',
      `${device.name}의 Debug bridge에서 최종 앱 상태를 수집하고 있습니다.`,
      { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
    )
    try {
      stateResponse = await requestIosDebugBridge({
        deviceId: device.udid,
        bundleIdentifier: product.bundleIdentifier,
        cwd: worktreePath,
        fixture: null,
        captureState: true,
        timeoutSeconds: input.debugBridge.responseTimeoutSeconds,
        execute,
        wait: input.wait
      })
    } catch (error) {
      throw new IosRuntimeStageError(
        'observing',
        error instanceof IosDebugBridgeError ? error.message : String(error)
      )
    }
  }

  let debugStateEvidence: RuntimeDebugStateEvidence | null = null
  if (fixtureResponse || stateResponse) {
    const capturedAt = stateResponse?.completedAt ?? fixtureResponse?.completedAt ?? new Date().toISOString()
    const payload = {
      schemaVersion: 1,
      bundleIdentifier: product.bundleIdentifier,
      capturedAt,
      fixture: fixtureResponse?.fixture ?? null,
      ...(stateResponse?.state === undefined ? {} : { state: stateResponse.state })
    }
    const evidence = await writeRuntimeJsonEvidence(
      resolvedSessionRoot,
      'debug-state',
      payload,
      MAX_DEBUG_STATE_EVIDENCE_BYTES,
      stateResponse ? 'observing' : 'acting',
      'Debug state·fixture 증거'
    )
    debugStateEvidence = {
      path: evidence.path,
      mimeType: 'application/json',
      sizeBytes: evidence.sizeBytes,
      capturedAt,
      hasState: stateResponse?.state !== undefined,
      fixtureId: fixtureResponse?.fixture?.id ?? null,
      content: evidence.content
    }
  }

  let screenEvidence: RuntimeScreenEvidence | null = null
  if (input.captureScreen) {
    input.onProgress(
      'observing',
      `${device.name}의 최종 실행 화면을 증거로 캡처하고 있습니다.`,
      { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
    )
    await (input.wait ?? wait)(SCREEN_SETTLE_MS)
    await mkdir(resolve(resolvedSessionRoot, 'evidence'), { recursive: true })
    const evidenceRoot = await requireContainedDirectory(
      resolvedSessionRoot,
      'evidence',
      'runtime evidence'
    )
    const screenshotPath = resolve(evidenceRoot, `screen-${randomUUID()}.png`)
    await executeRequired(
      execute,
      {
        command: XCRUN_COMMAND,
        args: ['simctl', 'io', device.udid, 'screenshot', '--type=png', screenshotPath],
        cwd: worktreePath,
        label: 'Simulator 화면 캡처',
        timeoutMs: RUNTIME_TIMEOUTS.observe
      },
      'observing'
    )
    const screenshotStats = await lstat(screenshotPath).catch(() => {
      throw new IosRuntimeStageError('observing', 'Simulator 화면 증거 파일이 생성되지 않았습니다.')
    })
    if (!screenshotStats.isFile() || screenshotStats.isSymbolicLink()) {
      throw new IosRuntimeStageError('observing', '화면 증거가 일반 PNG 파일로 생성되지 않았습니다.')
    }
    if (screenshotStats.size <= 0 || screenshotStats.size > MAX_SCREENSHOT_BYTES) {
      throw new IosRuntimeStageError(
        'observing',
        `화면 증거 크기가 허용 범위를 벗어났습니다: ${screenshotStats.size.toLocaleString('ko-KR')} bytes`
      )
    }
    const resolvedScreenshotPath = await realpath(screenshotPath)
    if (!resolvedScreenshotPath.startsWith(`${evidenceRoot}/`)) {
      throw new IosRuntimeStageError('observing', '화면 증거가 작업별 runtime 경로 밖을 가리킵니다.')
    }
    screenEvidence = {
      path: resolvedScreenshotPath,
      mimeType: 'image/png',
      sizeBytes: screenshotStats.size,
      capturedAt: new Date().toISOString()
    }
  }

  return {
    deviceId: device.udid,
    deviceName: device.name,
    bundleIdentifier: product.bundleIdentifier,
    processId: parseProcessId(launchResult.stdout || launchResult.output),
    appPath,
    screenEvidence,
    accessibilityEvidence,
    uiActionEvidence,
    debugStateEvidence
  }
}

export async function stopIosSimulatorRuntime(
  input: IosSimulatorStopInput
): Promise<void> {
  if (!input.session.deviceId || !input.session.bundleIdentifier) return
  await executeRequired(
    input.execute,
    {
      command: XCRUN_COMMAND,
      args: ['simctl', 'terminate', input.session.deviceId, input.session.bundleIdentifier],
      cwd: input.cwd,
      label: 'Simulator 앱 종료',
      timeoutMs: RUNTIME_TIMEOUTS.stop
    },
    'stopped'
  )
}

export const iosSimulatorRuntimeAdapter: IosSimulatorRuntimeAdapter = {
  launch: launchIosSimulatorRuntime,
  stop: stopIosSimulatorRuntime
}
