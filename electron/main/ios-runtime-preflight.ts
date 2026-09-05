import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IosRuntimeAdapterConfig } from '../../src/shared/types'
import type { RuntimeCommandExecutor, RuntimeCommandResult } from './ios-simulator-runtime'

const SIMULATOR_PROBE_TIMEOUT_MS = 30_000
const TUIST_GENERATE_TIMEOUT_MS = 10 * 60_000
const SIMULATOR_RECOVERY_ATTEMPTS = 2

const CORE_SIMULATOR_FAILURE_PATTERNS = [
  /CoreSimulatorService connection became invalid/i,
  /not connected to CoreSimulatorService/i,
  /failed to initialize simulator device set/i,
  /Simulator services will no longer be available/i,
  /Unable to boot the Simulator/i,
  /com\.apple\.CoreSimulator/i
]

export interface IosRuntimePreflightInput {
  worktreePath: string
  adapter: IosRuntimeAdapterConfig
  execute: RuntimeCommandExecutor
  wait?: (milliseconds: number) => Promise<void>
}

export interface IosRuntimePreflightResult {
  containerGenerated: boolean
  simulatorRecovered: boolean
}

export class IosRuntimePreflightError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly output: string
  ) {
    super(message)
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isXcodeContainerReady(
  worktreePath: string,
  container: string
): Promise<boolean> {
  const containerPath = resolve(worktreePath, container)
  if (!isPathInside(worktreePath, containerPath) || !(await isDirectory(containerPath))) return false
  if (container.endsWith('.xcworkspace')) {
    return isFile(resolve(containerPath, 'contents.xcworkspacedata'))
  }
  if (container.endsWith('.xcodeproj')) {
    return isFile(resolve(containerPath, 'project.pbxproj'))
  }
  return false
}

async function isTuistProject(worktreePath: string): Promise<boolean> {
  return await isFile(resolve(worktreePath, 'Tuist.swift')) ||
    await isFile(resolve(worktreePath, 'Workspace.swift')) ||
    await isFile(resolve(worktreePath, 'Project.swift'))
}

function commandOutput(result: RuntimeCommandResult): string {
  return result.output.trim() || result.stdout.trim()
}

export function isCoreSimulatorServiceFailureOutput(output: string): boolean {
  return CORE_SIMULATOR_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
}

async function ensureXcodeContainer(
  input: IosRuntimePreflightInput
): Promise<boolean> {
  if (await isXcodeContainerReady(input.worktreePath, input.adapter.container)) return false

  if (!(await isTuistProject(input.worktreePath))) {
    throw new IosRuntimePreflightError(
      `Xcode container를 찾을 수 없습니다: ${input.adapter.container}`,
      '프로젝트 설정 > Simulator 실행 대상',
      ''
    )
  }

  const result = await input.execute({
    command: 'tuist',
    args: ['generate', '--no-open'],
    cwd: input.worktreePath,
    label: 'Tuist Xcode container 생성',
    timeoutMs: TUIST_GENERATE_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new IosRuntimePreflightError(
      'Tuist가 Simulator 검증에 필요한 Xcode workspace를 만들지 못했습니다.',
      'tuist generate --no-open',
      commandOutput(result)
    )
  }
  if (!(await isXcodeContainerReady(input.worktreePath, input.adapter.container))) {
    throw new IosRuntimePreflightError(
      `Tuist 생성 후에도 Xcode container가 준비되지 않았습니다: ${input.adapter.container}`,
      'tuist generate --no-open',
      commandOutput(result)
    )
  }
  return true
}

async function probeSimulator(
  input: IosRuntimePreflightInput
): Promise<RuntimeCommandResult> {
  return input.execute({
    command: '/usr/bin/xcrun',
    args: ['simctl', 'list', 'devices', 'available', '--json'],
    cwd: input.worktreePath,
    label: 'Simulator 서비스 상태 확인',
    timeoutMs: SIMULATOR_PROBE_TIMEOUT_MS
  })
}

async function ensureSimulatorService(
  input: IosRuntimePreflightInput
): Promise<boolean> {
  const initial = await probeSimulator(input)
  if (initial.code === 0) return false

  const initialOutput = commandOutput(initial)
  if (!isCoreSimulatorServiceFailureOutput(initialOutput)) {
    throw new IosRuntimePreflightError(
      '사용 가능한 Simulator를 확인하지 못했습니다.',
      'xcrun simctl list devices available --json',
      initialOutput
    )
  }

  const opened = await input.execute({
    command: '/usr/bin/open',
    args: ['-a', 'Simulator'],
    cwd: input.worktreePath,
    label: 'Simulator 서비스 자동 복구',
    timeoutMs: SIMULATOR_PROBE_TIMEOUT_MS
  })
  if (opened.code !== 0) {
    throw new IosRuntimePreflightError(
      'Simulator 앱을 열어 서비스를 복구하지 못했습니다.',
      'open -a Simulator',
      commandOutput(opened)
    )
  }

  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds)
  }))
  let lastOutput = initialOutput
  for (let attempt = 0; attempt < SIMULATOR_RECOVERY_ATTEMPTS; attempt += 1) {
    await wait(1_000)
    const retry = await probeSimulator(input)
    if (retry.code === 0) return true
    lastOutput = commandOutput(retry)
  }

  throw new IosRuntimePreflightError(
    'Simulator 서비스를 다시 열었지만 연결이 복구되지 않았습니다. Xcode와 Simulator를 확인한 뒤 다시 실행하세요.',
    'open -a Simulator',
    lastOutput
  )
}

export async function prepareIosRuntimeEnvironment(
  input: IosRuntimePreflightInput
): Promise<IosRuntimePreflightResult> {
  const containerGenerated = await ensureXcodeContainer(input)
  const simulatorRecovered = await ensureSimulatorService(input)
  return { containerGenerated, simulatorRecovered }
}
