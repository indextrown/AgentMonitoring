import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ProjectCapabilityManifest } from './project-capabilities'
import type { RuntimeSessionRecord, RuntimeSessionStatus } from '../../src/shared/types'

export interface RuntimeCommandRequest {
  command: string
  args: string[]
  cwd: string
  label: string
  timeoutMs: number
}

export interface RuntimeCommandResult {
  code: number
  output: string
  stdout: string
}

export type RuntimeCommandExecutor = (
  request: RuntimeCommandRequest
) => Promise<RuntimeCommandResult>

export interface IosSimulatorLaunchInput {
  taskId: string
  worktreePath: string
  runtimeRoot: string
  contract: ProjectCapabilityManifest['adapter']
  captureScreen: boolean
  captureAccessibility: boolean
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

export interface IosSimulatorLaunchResult {
  deviceId: string
  deviceName: string
  bundleIdentifier: string
  processId: number | null
  appPath: string
  screenEvidence: RuntimeScreenEvidence | null
  accessibilityEvidence: RuntimeAccessibilityEvidence | null
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
const ACCESSIBILITY_BEGIN_MARKER = 'AGENTMONITOR_ACCESSIBILITY_BEGIN'
const ACCESSIBILITY_END_MARKER = 'AGENTMONITOR_ACCESSIBILITY_END'
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

export class IosRuntimeStageError extends Error {
  constructor(
    readonly status: RuntimeSessionStatus,
    message: string
  ) {
    super(message)
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    throw new IosRuntimeStageError('failed', `${label} JSON을 해석할 수 없습니다.`)
  }
}

export function parseAccessibilityObserverOutput(
  source: string,
  expectedBundleIdentifier: string
): AccessibilityTreePayload {
  const beginIndex = source.lastIndexOf(ACCESSIBILITY_BEGIN_MARKER)
  const endIndex = source.indexOf(ACCESSIBILITY_END_MARKER, beginIndex)
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
    throw new IosRuntimeStageError(
      'observing',
      'XCTest observer 출력에서 접근성 트리 marker를 찾지 못했습니다.'
    )
  }
  const encodedLines = source
    .slice(beginIndex + ACCESSIBILITY_BEGIN_MARKER.length, endIndex)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (
    encodedLines.length === 0 ||
    encodedLines.some((line) => !/^[A-Za-z0-9+/=]+$/.test(line))
  ) {
    throw new IosRuntimeStageError('observing', '접근성 트리 payload가 올바른 base64가 아닙니다.')
  }
  const encoded = encodedLines.join('')
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_ACCESSIBILITY_JSON_BYTES) {
    throw new IosRuntimeStageError(
      'observing',
      `접근성 트리 크기가 허용 범위를 벗어났습니다: ${decoded.byteLength.toLocaleString('ko-KR')} bytes`
    )
  }

  let payload: AccessibilityTreePayload
  try {
    payload = accessibilityTreePayloadSchema.parse(JSON.parse(decoded.toString('utf8')))
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

function accessibilityTestPlan(bundleIdentifier: string): string {
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
    accessibilityTestPlan(bundleIdentifier),
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

export async function launchIosSimulatorRuntime(
  input: IosSimulatorLaunchInput
): Promise<IosSimulatorLaunchResult> {
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
    input.execute,
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
    input.execute,
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
    input.execute,
    {
      command: '/usr/bin/open',
      args: ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid],
      cwd: worktreePath,
      label: 'Simulator 창 열기',
      timeoutMs: RUNTIME_TIMEOUTS.inspect
    },
    'booting'
  )

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
    derivedDataPath
  ]

  input.onProgress(
    'building',
    `${input.contract.scheme} ${input.contract.configuration} 앱을 격리 worktree에서 빌드하고 있습니다.`
  )
  await executeRequired(
    input.execute,
    {
      command: XCRUN_COMMAND,
      args: ['xcodebuild', ...commonXcodeArguments, 'build'],
      cwd: worktreePath,
      label: 'Swift 앱 빌드',
      timeoutMs: RUNTIME_TIMEOUTS.build
    },
    'building'
  )
  const buildSettings = await executeRequired(
    input.execute,
    {
      command: XCRUN_COMMAND,
      args: ['xcodebuild', ...commonXcodeArguments, '-showBuildSettings', '-json'],
      cwd: worktreePath,
      label: '앱 산출물 설정 확인',
      timeoutMs: RUNTIME_TIMEOUTS.inspect
    },
    'building'
  )
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
  await executeRequired(
    input.execute,
    {
      command: XCRUN_COMMAND,
      args: ['simctl', 'install', device.udid, appPath],
      cwd: worktreePath,
      label: 'Simulator 앱 설치',
      timeoutMs: RUNTIME_TIMEOUTS.install
    },
    'installing'
  )

  input.onProgress(
    'launching',
    `${product.bundleIdentifier} 앱을 실행하고 있습니다.`,
    { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
  )
  const launchResult = await executeRequired(
    input.execute,
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
      timeoutMs: RUNTIME_TIMEOUTS.launch
    },
    'launching'
  )

  let screenEvidence: RuntimeScreenEvidence | null = null
  if (input.captureScreen) {
    input.onProgress(
      'observing',
      `${device.name}의 실행 화면을 증거로 캡처하고 있습니다.`,
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
      input.execute,
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

  let accessibilityEvidence: RuntimeAccessibilityEvidence | null = null
  if (input.captureAccessibility) {
    input.onProgress(
      'observing',
      `${device.name}에서 ${product.bundleIdentifier} 앱의 접근성 트리를 수집하고 있습니다.`,
      { deviceId: device.udid, deviceName: device.name, bundleIdentifier: product.bundleIdentifier }
    )
    const observer = await prepareAccessibilityObserver(
      resolvedSessionRoot,
      product.bundleIdentifier,
      input.accessibilityObserverTemplateRoot
    )
    const observerResult = await executeRequired(
      input.execute,
      {
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
          `-only-testing:${ACCESSIBILITY_OBSERVER_NAME}Tests/AccessibilitySnapshotTests/testCaptureAccessibilityTree`,
          'test'
        ],
        cwd: worktreePath,
        label: 'Simulator 접근성 트리 수집',
        timeoutMs: RUNTIME_TIMEOUTS.accessibility
      },
      'observing'
    )
    const payload = parseAccessibilityObserverOutput(
      observerResult.stdout || observerResult.output,
      product.bundleIdentifier
    )
    await mkdir(resolve(resolvedSessionRoot, 'evidence'), { recursive: true })
    const evidenceRoot = await requireContainedDirectory(
      resolvedSessionRoot,
      'evidence',
      'runtime evidence'
    )
    const accessibilityPath = resolve(
      evidenceRoot,
      `accessibility-${randomUUID()}.json`
    )
    const accessibilityContent = `${JSON.stringify(payload, null, 2)}\n`
    const accessibilitySizeBytes = Buffer.byteLength(accessibilityContent)
    if (
      accessibilitySizeBytes <= 0 ||
      accessibilitySizeBytes > MAX_ACCESSIBILITY_EVIDENCE_BYTES
    ) {
      throw new IosRuntimeStageError(
        'observing',
        `접근성 증거 크기가 허용 범위를 벗어났습니다: ${accessibilitySizeBytes.toLocaleString('ko-KR')} bytes`
      )
    }
    await writeFile(accessibilityPath, accessibilityContent, 'utf8')
    const resolvedAccessibilityPath = await realpath(accessibilityPath)
    if (!resolvedAccessibilityPath.startsWith(`${evidenceRoot}/`)) {
      throw new IosRuntimeStageError('observing', '접근성 증거가 작업별 runtime 경로 밖을 가리킵니다.')
    }
    accessibilityEvidence = {
      path: resolvedAccessibilityPath,
      mimeType: 'application/json',
      sizeBytes: accessibilitySizeBytes,
      capturedAt: payload.capturedAt,
      nodeCount: payload.nodeCount,
      truncated: payload.truncated,
      content: accessibilityContent
    }
  }

  return {
    deviceId: device.udid,
    deviceName: device.name,
    bundleIdentifier: product.bundleIdentifier,
    processId: parseProcessId(launchResult.stdout || launchResult.output),
    appPath,
    screenEvidence,
    accessibilityEvidence
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
