import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  IosRuntimeAdapterConfig,
  ProjectRuntimeConfigSource
} from '../../src/shared/types'
import { readProjectCapabilityManifest } from './project-capabilities'

const execFileAsync = promisify(execFile)
const DISCOVERY_TIMEOUT_MS = 30_000
const MAX_GIT_OUTPUT_BYTES = 4_000_000
const MAX_DISCOVERY_DEPTH = 4
const MAX_DISCOVERY_DIRECTORIES = 2_000
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

async function listSchemes(projectPath: string, container: string): Promise<string[]> {
  const containerFlag = container.endsWith('.xcworkspace') ? '-workspace' : '-project'
  try {
    const result = await execFileAsync(
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

export async function resolveProjectRuntimeConfig(
  projectPath: string
): Promise<ResolvedProjectRuntimeConfig | null> {
  const manifest = await readProjectCapabilityManifest(projectPath)
  if (manifest.state === 'valid') {
    return { adapter: manifest.value.adapter, source: 'manifest' }
  }

  let files: string[]
  try {
    const result = await execFileAsync('git', ['-C', projectPath, 'ls-files'], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: DISCOVERY_TIMEOUT_MS
    })
    files = result.stdout.split(/\r?\n/).filter(Boolean)
  } catch {
    return null
  }

  const trackedContainers = findTrackedXcodeContainers(files)
  const container = selectXcodeContainer(
    trackedContainers,
    trackedContainers.length > 0 ? [] : await findXcodeContainersOnDisk(projectPath)
  )
  if (!container) return null
  const schemes = await listSchemes(projectPath, container)
  const fallbackScheme = basename(container).replace(/\.(?:xcworkspace|xcodeproj)$/, '')
  const scheme = schemes.find((candidate) => candidate === fallbackScheme) ?? schemes[0] ?? fallbackScheme

  return {
    source: 'detected',
    adapter: {
      kind: 'ios-simulator',
      container,
      scheme,
      configuration: 'Debug',
      deviceFamily: 'iphone'
    }
  }
}
