import { execFile } from 'node:child_process'
import { mkdir, lstat, realpath, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  IosRuntimeAdapterConfig,
  ProjectRecord,
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
  deviceId: string
  bundleIdentifier: string
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

function initialSession(projectId: string): ProjectSimulatorSession {
  return {
    projectId,
    source: {
      kind: 'project',
      taskId: null,
      branchName: null
    },
    status: 'idle',
    deviceId: null,
    deviceName: null,
    bundleIdentifier: null,
    processId: null,
    message: 'Simulator에서 앱을 실행할 준비가 되었습니다.',
    error: null,
    updatedAt: new Date().toISOString()
  }
}

export class ProjectSimulatorService {
  private readonly sessions = new Map<string, ProjectSimulatorSession>()
  private readonly runtimes = new Map<string, ProjectSimulatorRuntime>()
  private readonly busyProjects = new Set<string>()

  constructor(
    private readonly runtimeRoot: string,
    private readonly publish: ProjectSimulatorPublisher = () => undefined,
    private readonly execute: RuntimeCommandExecutor = executeCommand
  ) {}

  getStatus(project: ProjectRecord): ProjectSimulatorSession {
    this.requireIosProject(project)
    return this.sessions.get(project.id) ?? initialSession(project.id)
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
    }
  ): Promise<ProjectSimulatorSession> {
    return this.runExclusive(project, async (adapter) => {
      this.update(project.id, 'preparing', `${adapter.scheme}이 실행 가능한 iOS 앱인지 확인하고 있습니다.`, {
        source: target.source
      })
      const projectRoot = await realpath(target.path)
      const containerPath = await this.requireContainer(projectRoot, adapter.container)
      const projectRuntimeRoot = resolve(this.runtimeRoot, project.id)
      await rm(projectRuntimeRoot, { recursive: true, force: true })
      await mkdir(resolve(projectRuntimeRoot, 'DerivedData'), { recursive: true })
      const derivedDataPath = await realpath(resolve(projectRuntimeRoot, 'DerivedData'))
      const familyLabel = adapter.deviceFamily === 'iphone' ? 'iPhone' : 'iPad'

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
          'iphonesimulator',
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
          `${adapter.scheme} Scheme은 Simulator에 설치할 수 있는 iOS 앱이 아닙니다. 프로젝트 설정에서 실행 설정을 다시 찾고 앱 Scheme을 선택하세요.`
        )
      }

      this.update(project.id, 'preparing', `${familyLabel} Simulator 기기를 찾고 있습니다.`)
      const deviceList = await this.required({
        command: XCRUN_COMMAND,
        args: ['simctl', 'list', 'devices', 'available', '--json'],
        cwd: projectRoot,
        label: '사용 가능한 Simulator 조회',
        timeoutMs: TIMEOUTS.inspect
      })
      const device = parseAvailableSimulatorDevices(deviceList.stdout, adapter.deviceFamily)[0]
      if (!device) {
        throw new Error(`사용 가능한 ${familyLabel} Simulator가 없습니다. Xcode에서 기기를 만든 뒤 다시 실행하세요.`)
      }

      this.update(project.id, 'booting', `${device.name} Simulator를 준비하고 있습니다.`, {
        deviceId: device.udid,
        deviceName: device.name
      })
      if (device.state !== 'Booted') {
        const boot = await this.execute({
          command: XCRUN_COMMAND,
          args: ['simctl', 'boot', device.udid],
          cwd: projectRoot,
          label: `${device.name} 부팅 시작`,
          timeoutMs: TIMEOUTS.boot
        })
        if (boot.code !== 0 && !/already booted|current state:\s*Booted/i.test(boot.output)) {
          throw new Error(boot.output.trim().slice(-2_000) || `${device.name} 부팅 시작에 실패했습니다.`)
        }
      }
      await this.required({
        command: XCRUN_COMMAND,
        args: ['simctl', 'bootstatus', device.udid, '-b'],
        cwd: projectRoot,
        label: `${device.name} 부팅 확인`,
        timeoutMs: TIMEOUTS.boot
      })
      await this.required({
        command: '/usr/bin/open',
        args: ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', device.udid],
        cwd: projectRoot,
        label: 'Simulator 창 열기',
        timeoutMs: TIMEOUTS.inspect
      })

      const commonArguments = [
        ...xcodeContainerArguments(containerPath),
        '-scheme',
        adapter.scheme,
        '-configuration',
        adapter.configuration,
        '-sdk',
        'iphonesimulator',
        '-destination',
        `id=${device.udid}`,
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

      this.update(project.id, 'installing', `${device.name}에 ${product.wrapperName}을 설치하고 있습니다.`, {
        bundleIdentifier: product.bundleIdentifier
      })
      await this.required({
        command: XCRUN_COMMAND,
        args: ['simctl', 'install', device.udid, appPath],
        cwd: projectRoot,
        label: 'Simulator 앱 설치',
        timeoutMs: TIMEOUTS.install
      })
      const launch = await this.required({
        command: XCRUN_COMMAND,
        args: ['simctl', 'launch', '--terminate-running-process', device.udid, product.bundleIdentifier],
        cwd: projectRoot,
        label: 'Simulator 앱 실행',
        timeoutMs: TIMEOUTS.launch
      })
      this.runtimes.set(project.id, {
        cwd: projectRoot,
        deviceId: device.udid,
        bundleIdentifier: product.bundleIdentifier
      })
      return this.update(project.id, 'running', `${device.name}에서 앱을 실행하고 있습니다.`, {
        deviceId: device.udid,
        deviceName: device.name,
        bundleIdentifier: product.bundleIdentifier,
        processId: parseProcessId(launch.output)
      })
    }, true)
  }

  restart(project: ProjectRecord): Promise<ProjectSimulatorSession> {
    return this.runExclusive(project, async () => {
      const runtime = this.requireRuntime(project.id)
      const current = this.getStatus(project)
      this.update(project.id, 'restarting', '설치된 앱을 다시 실행하고 있습니다.')
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
      return this.update(project.id, 'running', `${current.deviceName ?? 'Simulator'}에서 앱을 다시 실행했습니다.`, {
        processId: parseProcessId(launch.output)
      })
    })
  }

  stop(project: ProjectRecord): Promise<ProjectSimulatorSession> {
    return this.runExclusive(project, async () => {
      const runtime = this.requireRuntime(project.id)
      const current = this.getStatus(project)
      this.update(project.id, 'stopping', 'Simulator 앱을 종료하고 있습니다.')
      const result = await this.execute({
        command: XCRUN_COMMAND,
        args: ['simctl', 'terminate', runtime.deviceId, runtime.bundleIdentifier],
        cwd: runtime.cwd,
        label: 'Simulator 앱 종료',
        timeoutMs: TIMEOUTS.stop
      })
      if (result.code !== 0 && !/not running|found nothing to terminate|NSPOSIXErrorDomain.*3/i.test(result.output)) {
        throw new Error(result.output.trim().slice(-2_000) || 'Simulator 앱 종료에 실패했습니다.')
      }
      return this.update(project.id, 'stopped', `${current.deviceName ?? 'Simulator'}에서 앱을 종료했습니다.`, {
        processId: null
      })
    })
  }

  async dispose(): Promise<void> {
    const stops = [...this.runtimes.entries()].map(async ([projectId, runtime]) => {
      await this.execute({
        command: XCRUN_COMMAND,
        args: ['simctl', 'terminate', runtime.deviceId, runtime.bundleIdentifier],
        cwd: runtime.cwd,
        label: 'AgentMonitoring 종료 시 Simulator 앱 정리',
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
      throw new Error('이 프로젝트의 Simulator 명령이 이미 실행 중입니다.')
    }
    this.busyProjects.add(project.id)
    try {
      return await operation(adapter)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.update(project.id, 'failed', 'Simulator 명령을 완료하지 못했습니다.', { error: message })
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
      throw new Error('프로젝트 설정에서 iOS Simulator 실행 영역을 먼저 연결하세요.')
    }
    return project.runtimeAdapter
  }

  private requireRuntime(projectId: string): ProjectSimulatorRuntime {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) throw new Error('먼저 이 프로젝트를 Simulator에서 실행하세요.')
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
