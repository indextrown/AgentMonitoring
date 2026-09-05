import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  IosRuntimeAdapterConfig,
  ProjectRecord,
  ProjectRunDestination,
  ProjectRunDestinationKind,
  ProjectSimulatorSession,
  ProjectSimulatorSource,
  ProjectSimulatorStatus
} from '../../src/shared/types'
import {
  parseAvailableSimulatorDevices,
  parseXcodeAppProduct,
  type RuntimeCommandExecutor,
  type RuntimeCommandRequest,
  type RuntimeCommandResult
} from './ios-simulator-runtime'
import { redactProcessOutput } from './process-output'

const execFileAsync = promisify(execFile)
const XCRUN_COMMAND = '/usr/bin/xcrun'
const MAX_OUTPUT_BYTES = 8_000_000
const DESTINATION_CACHE_MS = 5_000
const TIMEOUTS = {
  inspect: 30_000,
  boot: 5 * 60_000,
  build: 30 * 60_000,
  install: 2 * 60_000,
  launch: 60_000,
  stop: 30_000
} as const

interface ProjectSimulatorRuntime {
  cwd: string
  destinationKind: ProjectRunDestinationKind
  deviceId: string
  bundleIdentifier: string
  processId: number | null
}

export interface ProjectSimulatorLaunchTarget {
  path: string
  source: ProjectSimulatorSource
}

export type ProjectSimulatorPublisher = (session: ProjectSimulatorSession) => void

async function executeCommand(request: RuntimeCommandRequest): Promise<RuntimeCommandResult> {
  try {
    const result = await execFileAsync(request.command, request.args, {
      cwd: request.cwd,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: request.timeoutMs,
      env: process.env
    })
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    return {
      code: 0,
      stdout,
      output: [stdout, stderr].filter(Boolean).join('\n')
    }
  } catch (error) {
    const failure = error as {
      code?: number | string
      stdout?: string
      stderr?: string
      killed?: boolean
      message?: string
    }
    const output = redactProcessOutput([
      failure.stdout,
      failure.stderr,
      failure.killed ? `${request.label} 제한 시간 초과` : failure.message
    ].filter(Boolean).join('\n')).slice(-4_000)
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      output
    }
  }
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nestedProcessId(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = nestedProcessId(item)
      if (result) return result
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  for (const key of ['processIdentifier', 'pid', 'processID']) {
    const candidate = source[key]
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  for (const child of Object.values(source).filter((item) => typeof item === 'object' && item !== null)) {
    const result = nestedProcessId(child)
    if (result) return result
  }
  return null
}

function simulatorOsVersion(runtime: string): string | null {
  const match = runtime.match(/\.iOS-(\d+)-(\d+)$/)
  return match ? `iOS ${match[1]}.${match[2]}` : null
}

function destinationIdentifier(kind: ProjectRunDestinationKind, deviceId: string): string {
  return `${kind}:${deviceId}`
}

function destinationDeviceId(destinationId: string, kind: ProjectRunDestinationKind): string | null {
  const prefix = `${kind}:`
  return destinationId.startsWith(prefix) ? destinationId.slice(prefix.length) || null : null
}

export function parsePhysicalRunDestinations(
  source: string,
  family: IosRuntimeAdapterConfig['deviceFamily']
): ProjectRunDestination[] {
  const root = record(JSON.parse(source))
  const devices = record(root.result).devices
  if (!Array.isArray(devices)) return []
  return devices.flatMap((entry): ProjectRunDestination[] => {
    const device = record(entry)
    const deviceProperties = record(device.deviceProperties)
    const hardwareProperties = record(device.hardwareProperties)
    const connectionProperties = record(device.connectionProperties)
    if (textValue(hardwareProperties.platform)?.toLowerCase() !== 'ios') return []
    const deviceType = textValue(hardwareProperties.deviceType)?.toLowerCase()
    const deviceFamily = deviceType === 'iphone' ? 'iphone' : deviceType === 'ipad' ? 'ipad' : null
    if (!deviceFamily || deviceFamily !== family) return []
    const deviceId = textValue(hardwareProperties.udid) ?? textValue(device.identifier)
    const name = textValue(deviceProperties.name) ?? textValue(hardwareProperties.marketingName)
    if (!deviceId || !name) return []
    const pairingState = textValue(connectionProperties.pairingState)?.toLowerCase()
    const tunnelState = textValue(connectionProperties.tunnelState)?.toLowerCase()
    const developerMode = textValue(deviceProperties.developerModeStatus)?.toLowerCase()
    const servicesAvailable = deviceProperties.ddiServicesAvailable === true
    const connected = tunnelState === 'connected' || servicesAvailable
    const available = pairingState === 'paired' && developerMode === 'enabled' && connected
    const statusLabel = pairingState !== 'paired'
      ? '페어링 필요'
      : developerMode !== 'enabled'
        ? '개발자 모드 필요'
        : connected
          ? '연결됨'
          : '연결 안 됨'
    const osVersion = textValue(deviceProperties.osVersionNumber)
    return [{
      id: destinationIdentifier('physical', deviceId),
      name,
      kind: 'physical',
      deviceFamily,
      osVersion: osVersion ? `iOS ${osVersion}` : null,
      available,
      statusLabel,
      detail: ['실기기', osVersion ? `iOS ${osVersion}` : null, statusLabel].filter(Boolean).join(' · ')
    }]
  })
}

function initialSession(projectId: string): ProjectSimulatorSession {
  return {
    projectId,
    source: {
      kind: 'project',
      taskId: null,
      branchName: null
    },
    status: 'idle',
    destinationKind: null,
    deviceId: null,
    deviceName: null,
    bundleIdentifier: null,
    processId: null,
    message: '실행할 Simulator 또는 실기기를 선택하세요.',
    error: null,
    updatedAt: new Date().toISOString()
  }
}

export class ProjectSimulatorService {
  private readonly sessions = new Map<string, ProjectSimulatorSession>()
  private readonly runtimes = new Map<string, ProjectSimulatorRuntime>()
  private readonly busyProjects = new Set<string>()
  private readonly destinationCache = new Map<string, { destinations: ProjectRunDestination[]; expiresAt: number }>()
  private readonly destinationRequests = new Map<string, Promise<ProjectRunDestination[]>>()

  constructor(
    private readonly runtimeRoot: string,
    private readonly publish: ProjectSimulatorPublisher = () => undefined,
    private readonly execute: RuntimeCommandExecutor = executeCommand
  ) {}

  getStatus(project: ProjectRecord): ProjectSimulatorSession {
    this.requireIosProject(project)
    return this.sessions.get(project.id) ?? initialSession(project.id)
  }

  async listDestinations(
    project: ProjectRecord,
    refresh = false
  ): Promise<ProjectRunDestination[]> {
    const adapter = this.requireIosProject(project)
    const cached = this.destinationCache.get(project.id)
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.destinations
    const pending = this.destinationRequests.get(project.id)
    if (!refresh && pending) return pending
    const request = realpath(project.path)
      .then((projectRoot) => this.discoverDestinations(projectRoot, adapter.deviceFamily))
      .then((destinations) => {
        this.destinationCache.set(project.id, {
          destinations,
          expiresAt: Date.now() + DESTINATION_CACHE_MS
        })
        return destinations
      })
      .finally(() => this.destinationRequests.delete(project.id))
    this.destinationRequests.set(project.id, request)
    return request
  }

  launch(
    project: ProjectRecord,
    target: ProjectSimulatorLaunchTarget = {
      path: project.path,
      source: {
        kind: 'project',
        taskId: null,
        branchName: null
      }
    },
    destinationId?: string
  ): Promise<ProjectSimulatorSession> {
    return this.runExclusive(project, async (adapter) => {
      const destinationKind: ProjectRunDestinationKind = destinationId?.startsWith('physical:')
        ? 'physical'
        : 'simulator'
      const requestedDeviceId = destinationId
        ? destinationDeviceId(destinationId, destinationKind)
        : null
      if (destinationId && !requestedDeviceId) {
        throw new Error('선택한 iOS 실행 기기 식별자가 올바르지 않습니다.')
      }
      this.update(project.id, 'preparing', '선택한 iOS 실행 기기를 확인하고 있습니다.', {
        source: target.source,
        destinationKind
      })
      const projectRoot = await realpath(target.path)
      const containerPath = await this.requireContainer(projectRoot, adapter.container)
      const familyLabel = adapter.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'
      const sdk = destinationKind === 'physical' ? 'iphoneos' : 'iphonesimulator'
      const destinations = destinationKind === 'physical'
        ? await this.discoverPhysicalDestinations(projectRoot, adapter.deviceFamily)
        : await this.discoverSimulatorDestinations(projectRoot, adapter.deviceFamily)
      const destination = destinationId
        ? destinations.find((item) => item.id === destinationId)
        : destinations.find((item) => item.available)
      if (!destination) {
        throw new Error(destinationKind === 'physical'
          ? `선택한 ${familyLabel} 실기기를 찾을 수 없습니다. 기기를 잠금 해제하고 같은 네트워크 또는 USB로 연결하세요.`
          : `사용 가능한 ${familyLabel} Simulator가 없습니다. Xcode에서 기기를 만든 뒤 다시 실행하세요.`)
      }
      if (!destination.available) {
        throw new Error(`${destination.name}을(를) 사용할 수 없습니다: ${destination.statusLabel}`)
      }
      const deviceId = destinationDeviceId(destination.id, destination.kind)!

      const projectRuntimeRoot = resolve(this.runtimeRoot, project.id)
      await rm(projectRuntimeRoot, { recursive: true, force: true })
      await mkdir(resolve(projectRuntimeRoot, 'DerivedData'), { recursive: true })
      const derivedDataPath = await realpath(resolve(projectRuntimeRoot, 'DerivedData'))
      this.update(project.id, 'preparing', `${adapter.scheme}이 ${destination.name}에서 실행 가능한 iOS 앱인지 확인하고 있습니다.`)
      const schemeSettings = await this.required({
        command: XCRUN_COMMAND,
        args: [
          'xcodebuild',
          ...xcodeContainerArguments(containerPath),
          '-scheme',
          adapter.scheme,
          '-configuration',
          adapter.configuration,
          '-sdk',
          sdk,
          '-destination',
          `id=${deviceId}`,
          '-showBuildSettings',
          '-json'
        ],
        cwd: projectRoot,
        label: 'iOS 앱 Scheme 사전 확인',
        timeoutMs: TIMEOUTS.inspect
      })
      try {
        parseXcodeAppProduct(schemeSettings.stdout)
      } catch {
        throw new Error(
          `${adapter.scheme} Scheme은 선택한 iOS 기기에 설치할 수 있는 앱이 아닙니다. 프로젝트 설정에서 앱 Scheme을 선택하세요.`
        )
      }

      this.update(project.id, 'booting', `${destination.name}을(를) 준비하고 있습니다.`, {
        destinationKind: destination.kind,
        deviceId,
        deviceName: destination.name
      })
      if (destination.kind === 'simulator' && destination.statusLabel !== '부팅됨') {
        const boot = await this.execute({
          command: XCRUN_COMMAND,
          args: ['simctl', 'boot', deviceId],
          cwd: projectRoot,
          label: `${destination.name} 부팅 시작`,
          timeoutMs: TIMEOUTS.boot
        })
        if (boot.code !== 0 && !/already booted|current state:\s*Booted/i.test(boot.output)) {
          throw new Error(boot.output.trim().slice(-2_000) || `${destination.name} 부팅 시작에 실패했습니다.`)
        }
      }
      if (destination.kind === 'simulator') {
        await this.required({
          command: XCRUN_COMMAND,
          args: ['simctl', 'bootstatus', deviceId, '-b'],
          cwd: projectRoot,
          label: `${destination.name} 부팅 확인`,
          timeoutMs: TIMEOUTS.boot
        })
        await this.required({
          command: '/usr/bin/open',
          args: ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', deviceId],
          cwd: projectRoot,
          label: 'Simulator 창 열기',
          timeoutMs: TIMEOUTS.inspect
        })
      }

      const commonArguments = [
        ...xcodeContainerArguments(containerPath),
        '-scheme',
        adapter.scheme,
        '-configuration',
        adapter.configuration,
        '-sdk',
        sdk,
        '-destination',
        `id=${deviceId}`,
        '-derivedDataPath',
        derivedDataPath
      ]
      this.update(project.id, 'building', `${adapter.scheme} 앱을 빌드하고 있습니다.`)
      await this.required({
        command: XCRUN_COMMAND,
        args: ['xcodebuild', ...commonArguments, 'build'],
        cwd: projectRoot,
        label: 'Swift 앱 빌드',
        timeoutMs: TIMEOUTS.build
      })
      const buildSettings = await this.required({
        command: XCRUN_COMMAND,
        args: ['xcodebuild', ...commonArguments, '-showBuildSettings', '-json'],
        cwd: projectRoot,
        label: '앱 산출물 설정 확인',
        timeoutMs: TIMEOUTS.inspect
      })
      const product = parseXcodeAppProduct(buildSettings.stdout)
      const appPath = await this.requireBuiltApp(
        derivedDataPath,
        resolve(product.targetBuildDirectory, product.wrapperName)
      )

      this.update(project.id, 'installing', `${destination.name}에 ${product.wrapperName}을 설치하고 있습니다.`, {
        bundleIdentifier: product.bundleIdentifier
      })
      const processId = destination.kind === 'simulator'
        ? await this.installAndLaunchSimulator(projectRoot, deviceId, appPath, product.bundleIdentifier)
        : await this.installAndLaunchPhysicalDevice(projectRoot, deviceId, appPath, product.bundleIdentifier)
      this.runtimes.set(project.id, {
        cwd: projectRoot,
        destinationKind: destination.kind,
        deviceId,
        bundleIdentifier: product.bundleIdentifier,
        processId
      })
      return this.update(project.id, 'running', `${destination.name}에서 앱을 실행하고 있습니다.`, {
        destinationKind: destination.kind,
        deviceId,
        deviceName: destination.name,
        bundleIdentifier: product.bundleIdentifier,
        processId
      })
    }, true)
  }

  private async discoverDestinations(
    projectRoot: string,
    family: IosRuntimeAdapterConfig['deviceFamily']
  ): Promise<ProjectRunDestination[]> {
    const [simulators, physicalDevices] = await Promise.allSettled([
      this.discoverSimulatorDestinations(projectRoot, family),
      this.discoverPhysicalDestinations(projectRoot, family)
    ])
    const destinations = [
      ...(simulators.status === 'fulfilled' ? simulators.value : []),
      ...(physicalDevices.status === 'fulfilled' ? physicalDevices.value : [])
    ]
    if (destinations.length === 0 && simulators.status === 'rejected' && physicalDevices.status === 'rejected') {
      throw new Error(`iOS 실행 기기를 조회하지 못했습니다. ${String(simulators.reason)}`)
    }
    return destinations
  }

  private async discoverSimulatorDestinations(
    projectRoot: string,
    family: IosRuntimeAdapterConfig['deviceFamily']
  ): Promise<ProjectRunDestination[]> {
    const deviceList = await this.required({
      command: XCRUN_COMMAND,
      args: ['simctl', 'list', 'devices', 'available', '--json'],
      cwd: projectRoot,
      label: '사용 가능한 Simulator 조회',
      timeoutMs: TIMEOUTS.inspect
    })
    return parseAvailableSimulatorDevices(deviceList.stdout, family).map((device) => ({
      id: destinationIdentifier('simulator', device.udid),
      name: device.name,
      kind: 'simulator',
      deviceFamily: family,
      osVersion: simulatorOsVersion(device.runtime),
      available: device.isAvailable,
      statusLabel: device.state === 'Booted' ? '부팅됨' : '사용 가능',
      detail: [
        'Simulator',
        simulatorOsVersion(device.runtime),
        device.state === 'Booted' ? '부팅됨' : '종료됨'
      ].filter(Boolean).join(' · ')
    }))
  }

  private async discoverPhysicalDestinations(
    projectRoot: string,
    family: IosRuntimeAdapterConfig['deviceFamily']
  ): Promise<ProjectRunDestination[]> {
    const payload = await this.runDevicectlJson(
      ['list', 'devices', '--timeout', '5'],
      projectRoot,
      '페어링된 iOS 실기기 조회',
      TIMEOUTS.inspect
    )
    return parsePhysicalRunDestinations(payload, family)
  }

  private async installAndLaunchSimulator(
    projectRoot: string,
    deviceId: string,
    appPath: string,
    bundleIdentifier: string
  ): Promise<number | null> {
    await this.required({
      command: XCRUN_COMMAND,
      args: ['simctl', 'install', deviceId, appPath],
      cwd: projectRoot,
      label: 'Simulator 앱 설치',
      timeoutMs: TIMEOUTS.install
    })
    const launch = await this.required({
      command: XCRUN_COMMAND,
      args: ['simctl', 'launch', '--terminate-running-process', deviceId, bundleIdentifier],
      cwd: projectRoot,
      label: 'Simulator 앱 실행',
      timeoutMs: TIMEOUTS.launch
    })
    return parseProcessId(launch.output)
  }

  private async installAndLaunchPhysicalDevice(
    projectRoot: string,
    deviceId: string,
    appPath: string,
    bundleIdentifier: string
  ): Promise<number | null> {
    await this.required({
      command: XCRUN_COMMAND,
      args: ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath],
      cwd: projectRoot,
      label: 'iOS 실기기 앱 설치',
      timeoutMs: TIMEOUTS.install
    })
    return this.launchPhysicalDevice(projectRoot, deviceId, bundleIdentifier)
  }

  private async launchPhysicalDevice(
    projectRoot: string,
    deviceId: string,
    bundleIdentifier: string
  ): Promise<number | null> {
    const payload = await this.runDevicectlJson(
      ['device', 'process', 'launch', '--device', deviceId, '--terminate-existing', bundleIdentifier],
      projectRoot,
      'iOS 실기기 앱 실행',
      TIMEOUTS.launch
    )
    return nestedProcessId(JSON.parse(payload))
  }

  restart(project: ProjectRecord): Promise<ProjectSimulatorSession> {
    return this.runExclusive(project, async () => {
      const runtime = this.requireRuntime(project.id)
      const current = this.getStatus(project)
      this.update(project.id, 'restarting', '설치된 앱을 다시 실행하고 있습니다.')
      let processId: number | null
      if (runtime.destinationKind === 'simulator') {
        await this.required({
          command: '/usr/bin/open',
          args: ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', runtime.deviceId],
          cwd: runtime.cwd,
          label: 'Simulator 창 열기',
          timeoutMs: TIMEOUTS.inspect
        })
        const launch = await this.required({
          command: XCRUN_COMMAND,
          args: ['simctl', 'launch', '--terminate-running-process', runtime.deviceId, runtime.bundleIdentifier],
          cwd: runtime.cwd,
          label: 'Simulator 앱 재실행',
          timeoutMs: TIMEOUTS.launch
        })
        processId = parseProcessId(launch.output)
      } else {
        processId = await this.launchPhysicalDevice(runtime.cwd, runtime.deviceId, runtime.bundleIdentifier)
      }
      runtime.processId = processId
      return this.update(project.id, 'running', `${current.deviceName ?? 'iOS 기기'}에서 앱을 다시 실행했습니다.`, {
        processId
      })
    })
  }

  stop(project: ProjectRecord): Promise<ProjectSimulatorSession> {
    return this.runExclusive(project, async () => {
      const runtime = this.requireRuntime(project.id)
      const current = this.getStatus(project)
      this.update(project.id, 'stopping', 'iOS 앱을 종료하고 있습니다.')
      if (runtime.destinationKind === 'physical' && !runtime.processId) {
        throw new Error('실기기 앱의 실행 PID를 확인하지 못해 종료할 수 없습니다. 기기에서 앱을 직접 종료하세요.')
      }
      const result = await this.execute({
        command: XCRUN_COMMAND,
        args: runtime.destinationKind === 'simulator'
          ? ['simctl', 'terminate', runtime.deviceId, runtime.bundleIdentifier]
          : ['devicectl', 'device', 'process', 'terminate', '--device', runtime.deviceId, '--pid', String(runtime.processId)],
        cwd: runtime.cwd,
        label: runtime.destinationKind === 'simulator' ? 'Simulator 앱 종료' : 'iOS 실기기 앱 종료',
        timeoutMs: TIMEOUTS.stop
      })
      if (result.code !== 0 && !/not running|found nothing to terminate|no matching process|NSPOSIXErrorDomain.*3/i.test(result.output)) {
        throw new Error(result.output.trim().slice(-2_000) || 'iOS 앱 종료에 실패했습니다.')
      }
      runtime.processId = null
      return this.update(project.id, 'stopped', `${current.deviceName ?? 'iOS 기기'}에서 앱을 종료했습니다.`, {
        processId: null
      })
    })
  }

  async dispose(): Promise<void> {
    const stops = [...this.runtimes.entries()].map(async ([projectId, runtime]) => {
      if (runtime.destinationKind === 'physical' && !runtime.processId) {
        this.runtimes.delete(projectId)
        return
      }
      await this.execute({
        command: XCRUN_COMMAND,
        args: runtime.destinationKind === 'simulator'
          ? ['simctl', 'terminate', runtime.deviceId, runtime.bundleIdentifier]
          : ['devicectl', 'device', 'process', 'terminate', '--device', runtime.deviceId, '--pid', String(runtime.processId)],
        cwd: runtime.cwd,
        label: 'AgentMonitoring 종료 시 iOS 앱 정리',
        timeoutMs: TIMEOUTS.stop
      }).catch(() => undefined)
      this.runtimes.delete(projectId)
    })
    await Promise.all(stops)
    await rm(this.runtimeRoot, { recursive: true, force: true })
  }

  private async runExclusive(
    project: ProjectRecord,
    operation: (adapter: IosRuntimeAdapterConfig) => Promise<ProjectSimulatorSession>,
    cleanupBuild = false
  ): Promise<ProjectSimulatorSession> {
    const adapter = this.requireIosProject(project)
    if (this.busyProjects.has(project.id)) {
      throw new Error('이 프로젝트의 iOS 실행 명령이 이미 실행 중입니다.')
    }
    this.busyProjects.add(project.id)
    try {
      return await operation(adapter)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update(project.id, 'failed', 'iOS 실행 명령을 완료하지 못했습니다.', { error: message })
      throw error
    } finally {
      this.busyProjects.delete(project.id)
      if (cleanupBuild) {
        await rm(resolve(this.runtimeRoot, project.id), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private requireIosProject(project: ProjectRecord): IosRuntimeAdapterConfig {
    if (project.isDemo) throw new Error('데모 프로젝트에서는 Simulator를 직접 실행할 수 없습니다.')
    if (!project.runtimeAdapter || project.runtimeAdapter.kind !== 'ios-simulator') {
      throw new Error('프로젝트 설정에서 iOS 실행 영역을 먼저 연결하세요.')
    }
    return project.runtimeAdapter
  }

  private requireRuntime(projectId: string): ProjectSimulatorRuntime {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error('먼저 이 프로젝트를 Simulator 또는 실기기에서 실행하세요.')
    return runtime
  }

  private async requireContainer(projectRoot: string, container: string): Promise<string> {
    const candidate = resolve(projectRoot, container)
    if (!candidate.startsWith(`${projectRoot}${sep}`)) {
      throw new Error('Xcode container가 프로젝트 저장소 밖을 가리킵니다.')
    }
    const stats = await lstat(candidate)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Xcode container는 저장소 안의 실제 디렉터리여야 합니다.')
    }
    const resolved = await realpath(candidate)
    if (!resolved.startsWith(`${projectRoot}${sep}`)) {
      throw new Error('Xcode container의 실제 경로가 프로젝트 저장소 밖을 가리킵니다.')
    }
    return resolved
  }

  private async requireBuiltApp(derivedDataPath: string, appPath: string): Promise<string> {
    const candidate = resolve(appPath)
    const resolvedDerivedData = await realpath(derivedDataPath)
    if (!candidate.startsWith(`${resolvedDerivedData}${sep}`)) {
      throw new Error('빌드된 앱이 전용 DerivedData 밖을 가리킵니다.')
    }
    const stats = await lstat(candidate)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('빌드된 앱 산출물을 찾지 못했습니다.')
    }
    const resolved = await realpath(candidate)
    if (!resolved.startsWith(`${resolvedDerivedData}${sep}`)) {
      throw new Error('빌드된 앱의 실제 경로가 전용 DerivedData 밖을 가리킵니다.')
    }
    return resolved
  }

  private async runDevicectlJson(
    args: string[],
    cwd: string,
    label: string,
    timeoutMs: number
  ): Promise<string> {
    await mkdir(this.runtimeRoot, { recursive: true })
    const outputDirectory = await mkdtemp(resolve(this.runtimeRoot, 'devicectl-'))
    const outputPath = resolve(outputDirectory, 'result.json')
    try {
      const result = await this.execute({
        command: XCRUN_COMMAND,
        args: ['devicectl', ...args, '--json-output', outputPath, '--quiet'],
        cwd,
        label,
        timeoutMs
      })
      if (result.code !== 0) {
        throw new Error(result.output.trim().slice(-2_000) || `${label}에 실패했습니다.`)
      }
      try {
        return await readFile(outputPath, 'utf8')
      } catch {
        throw new Error(`${label} 결과를 읽지 못했습니다. Xcode에서 기기 연결 상태를 확인하세요.`)
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async required(request: RuntimeCommandRequest): Promise<RuntimeCommandResult> {
    const result = await this.execute(request)
    if (result.code !== 0) {
      throw new Error(result.output.trim().slice(-2_000) || `${request.label}에 실패했습니다.`)
    }
    return result
  }

  private update(
    projectId: string,
    status: ProjectSimulatorStatus,
    message: string,
    patch: Partial<ProjectSimulatorSession> = {}
  ): ProjectSimulatorSession {
    const session = {
      ...(this.sessions.get(projectId) ?? initialSession(projectId)),
      ...patch,
      projectId,
      status,
      message,
      error: patch.error ?? null,
      updatedAt: new Date().toISOString()
    }
    this.sessions.set(projectId, session)
    this.publish(session)
    return session
  }
}
