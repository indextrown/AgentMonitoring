import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  IosRuntimeAdapterConfig,
  ProjectRuntimeDiscovery,
  ProjectRuntimeConfigSource
} from '../../src/shared/types'
import { readProjectCapabilityManifest } from './project-capabilities'

const execFileAsync = promisify(execFile)
const DISCOVERY_TIMEOUT_MS = 30_000
const MAX_GIT_OUTPUT_BYTES = 4_000_000
const MAX_DISCOVERY_DEPTH = 4
const MAX_DISCOVERY_DIRECTORIES = 2_000
const SCHEME_INSPECTION_CONCURRENCY = 3
const DISCOVERY_CACHE_TTL_MS = 5 * 60_000
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  '.build',
  '.git',
  'Carthage',
  'DerivedData',
  'Pods',
  'build',
  'dist',
  'node_modules'
])

export interface ResolvedProjectRuntimeConfig {
  adapter: IosRuntimeAdapterConfig
  source: ProjectRuntimeConfigSource
}

interface ProjectRuntimeCommandResult {
  stdout: string
}

interface ProjectRuntimeCommandOptions {
  cwd: string
  encoding: 'utf8'
  maxBuffer: number
  timeout: number
}

export type ProjectRuntimeCommandExecutor = (
  command: string,
  args: string[],
  options: ProjectRuntimeCommandOptions
) => Promise<ProjectRuntimeCommandResult>

export interface ProjectRuntimeDiscoveryOptions {
  force?: boolean
  execute?: ProjectRuntimeCommandExecutor
}

interface CachedProjectRuntimeDiscovery {
  expiresAt: number
  value: Promise<ProjectRuntimeDiscovery>
}

const runtimeDiscoveryCache = new Map<string, CachedProjectRuntimeDiscovery>()

const defaultProjectRuntimeExecutor: ProjectRuntimeCommandExecutor = async (
  command,
  args,
  options
) => execFileAsync(command, args, options)

export function findTrackedXcodeContainers(files: string[]): string[] {
  const containers = new Set<string>()
  for (const file of files) {
    const workspaceMatch = file.match(/^(.+\.xcworkspace)\/contents\.xcworkspacedata$/)
    if (workspaceMatch && !workspaceMatch[1].includes('.xcodeproj/')) {
      containers.add(workspaceMatch[1])
      continue
    }
    const projectMatch = file.match(/^(.+\.xcodeproj)\/project\.pbxproj$/)
    if (projectMatch) containers.add(projectMatch[1])
  }
  return sortXcodeContainers([...containers])
}

function sortXcodeContainers(containers: string[]): string[] {
  return [...new Set(containers)].sort((left, right) => {
    const leftWorkspace = left.endsWith('.xcworkspace') ? 0 : 1
    const rightWorkspace = right.endsWith('.xcworkspace') ? 0 : 1
    return leftWorkspace - rightWorkspace || left.split('/').length - right.split('/').length || left.localeCompare(right)
  })
}

export function selectXcodeContainer(
  trackedContainers: string[],
  diskContainers: string[]
): string | null {
  const candidates = trackedContainers.length > 0 ? trackedContainers : diskContainers
  return sortXcodeContainers(candidates)[0] ?? null
}

async function isXcodeContainer(path: string, name: string): Promise<boolean> {
  const marker = name.endsWith('.xcworkspace') ? 'contents.xcworkspacedata' : 'project.pbxproj'
  try {
    const stats = await lstat(join(path, marker))
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

export async function findXcodeContainersOnDisk(projectPath: string): Promise<string[]> {
  const root = resolve(projectPath)
  const containers: string[] = []
  let visitedDirectories = 0

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (visitedDirectories >= MAX_DISCOVERY_DIRECTORIES) return
    visitedDirectories += 1
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (IGNORED_DISCOVERY_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      const absolutePath = join(directory, entry.name)
      const isContainer = entry.name.endsWith('.xcworkspace') || entry.name.endsWith('.xcodeproj')
      if (isContainer) {
        if (await isXcodeContainer(absolutePath, entry.name)) {
          containers.push(relative(root, absolutePath).split(sep).join('/'))
        }
        continue
      }
      if (depth + 1 < MAX_DISCOVERY_DEPTH) await visit(absolutePath, depth + 1)
    }
  }

  await visit(root, 0)
  return sortXcodeContainers(containers)
}

export function parseXcodeSchemes(output: string): string[] {
  try {
    const value = JSON.parse(output) as Record<string, unknown>
    const container = (value.workspace ?? value.project) as Record<string, unknown> | undefined
    if (!container || !Array.isArray(container.schemes)) return []
    return container.schemes.filter((scheme): scheme is string => typeof scheme === 'string' && scheme.trim().length > 0)
  } catch {
    return []
  }
}

async function listSchemes(
  projectPath: string,
  container: string,
  execute: ProjectRuntimeCommandExecutor
): Promise<string[]> {
  const containerFlag = container.endsWith('.xcworkspace') ? '-workspace' : '-project'
  try {
    const result = await execute(
      'xcodebuild',
      ['-list', '-json', containerFlag, container],
      {
        cwd: projectPath,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: DISCOVERY_TIMEOUT_MS
      }
    )
    return parseXcodeSchemes(result.stdout)
  } catch {
    return []
  }
}

interface XcodeBuildSettingsEntry {
  target?: unknown
  buildSettings?: Record<string, unknown>
}

export function parseIosAppTargets(output: string): string[] {
  try {
    const payload = JSON.parse(output) as unknown
    if (!Array.isArray(payload)) return []
    return [...new Set((payload as XcodeBuildSettingsEntry[]).flatMap((entry) => {
      const settings = entry.buildSettings ?? {}
      const productType = String(settings.PRODUCT_TYPE ?? '')
      const wrapperExtension = String(settings.WRAPPER_EXTENSION ?? '')
      const bundleIdentifier = String(settings.PRODUCT_BUNDLE_IDENTIFIER ?? '')
      const supportedPlatforms = String(settings.SUPPORTED_PLATFORMS ?? '')
      const supportsSimulator = !supportedPlatforms || supportedPlatforms.split(/\s+/).includes('iphonesimulator')
      if (
        productType !== 'com.apple.product-type.application' ||
        wrapperExtension !== 'app' ||
        !bundleIdentifier ||
        !supportsSimulator
      ) return []
      const target = typeof entry.target === 'string' ? entry.target.trim() : ''
      return target ? [target] : []
    }))]
  } catch {
    return []
  }
}

function normalizeSchemeName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '')
}

export function selectAppSchemeCandidates(
  candidates: ProjectRuntimeDiscovery['appSchemes']
): ProjectRuntimeDiscovery['appSchemes'] {
  const directCandidates = candidates.filter((candidate) => {
    const scheme = normalizeSchemeName(candidate.scheme)
    return candidate.targets.some((target) => normalizeSchemeName(target) === scheme)
  })
  return directCandidates.length > 0 ? directCandidates : candidates
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  transform: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await transform(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function inspectAppSchemes(
  projectPath: string,
  container: string,
  schemes: string[],
  execute: ProjectRuntimeCommandExecutor
): Promise<ProjectRuntimeDiscovery['appSchemes']> {
  const containerFlag = container.endsWith('.xcworkspace') ? '-workspace' : '-project'
  const candidates = await mapWithConcurrency(schemes, SCHEME_INSPECTION_CONCURRENCY, async (scheme) => {
    try {
      const result = await execute(
        'xcodebuild',
        [
          containerFlag,
          container,
          '-scheme',
          scheme,
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-showBuildSettings',
          '-json'
        ],
        {
          cwd: projectPath,
          encoding: 'utf8',
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeout: DISCOVERY_TIMEOUT_MS
        }
      )
      const targets = parseIosAppTargets(result.stdout)
      return targets.length > 0 ? { scheme, targets } : null
    } catch {
      return null
    }
  })
  return selectAppSchemeCandidates(candidates.filter((candidate) => candidate !== null))
}

function discoveryMessage(
  container: string | null,
  candidates: ProjectRuntimeDiscovery['appSchemes']
): string {
  if (!container) {
    return 'Xcode 프로젝트 또는 Workspace를 찾지 못했습니다. Tuist 프로젝트라면 `tuist generate` 후 다시 찾으세요.'
  }
  if (candidates.length === 0) {
    return `${container}에서 Simulator에 설치할 수 있는 iOS 앱 Scheme을 찾지 못했습니다.`
  }
  if (candidates.length === 1) {
    return `${candidates[0].scheme} iOS 앱 Scheme을 찾았습니다.`
  }
  return `실행 가능한 iOS 앱 Scheme ${candidates.length}개를 찾았습니다. 사용할 앱을 선택하세요.`
}

async function discoverProjectRuntimeConfigUncached(
  projectPath: string,
  execute: ProjectRuntimeCommandExecutor
): Promise<ProjectRuntimeDiscovery> {
  let files: string[] = []
  try {
    const result = await execute('git', ['-C', projectPath, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: DISCOVERY_TIMEOUT_MS,
      cwd: projectPath
    })
    files = result.stdout.split(/\r?\n/).filter(Boolean)
  } catch {
    // Generated Tuist containers may exist only on disk, so discovery can continue.
  }

  const trackedContainers = findTrackedXcodeContainers(files)
  const container = selectXcodeContainer(
    trackedContainers,
    trackedContainers.length > 0 ? [] : await findXcodeContainersOnDisk(projectPath)
  )
  if (!container) {
    return {
      state: 'unavailable',
      container: null,
      appSchemes: [],
      selectedScheme: null,
      message: discoveryMessage(null, [])
    }
  }

  const schemes = await listSchemes(projectPath, container, execute)
  const appSchemes = await inspectAppSchemes(projectPath, container, schemes, execute)
  const state = appSchemes.length === 1
    ? 'ready'
    : appSchemes.length > 1
      ? 'selection-required'
      : 'unavailable'
  return {
    state,
    container,
    appSchemes,
    selectedScheme: state === 'ready' ? appSchemes[0].scheme : null,
    message: discoveryMessage(container, appSchemes)
  }
}

export async function discoverProjectRuntimeConfig(
  projectPath: string,
  options: ProjectRuntimeDiscoveryOptions = {}
): Promise<ProjectRuntimeDiscovery> {
  const execute = options.execute ?? defaultProjectRuntimeExecutor
  if (options.execute) return discoverProjectRuntimeConfigUncached(projectPath, execute)

  const cacheKey = resolve(projectPath)
  const cached = runtimeDiscoveryCache.get(cacheKey)
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.value

  const value = discoverProjectRuntimeConfigUncached(projectPath, execute)
  runtimeDiscoveryCache.set(cacheKey, {
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    value
  })
  try {
    return await value
  } catch (error) {
    runtimeDiscoveryCache.delete(cacheKey)
    throw error
  }
}

export async function resolveProjectRuntimeConfig(
  projectPath: string
): Promise<ResolvedProjectRuntimeConfig | null> {
  const manifest = await readProjectCapabilityManifest(projectPath)
  if (manifest.state === 'valid') {
    return { adapter: manifest.value.adapter, source: 'manifest' }
  }

  const discovery = await discoverProjectRuntimeConfig(projectPath)
  if (discovery.state !== 'ready' || !discovery.container || !discovery.selectedScheme) return null

  return {
    source: 'detected',
    adapter: {
      kind: 'ios-simulator',
      container: discovery.container,
      scheme: discovery.selectedScheme,
      configuration: 'Debug',
      deviceFamily: 'iphone'
    }
  }
}
