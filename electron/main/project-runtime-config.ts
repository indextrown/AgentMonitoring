import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type {
  IosRuntimeAdapterConfig,
  ProjectRuntimeConfigSource
} from '../../src/shared/types'
import { readProjectCapabilityManifest } from './project-capabilities'

const execFileAsync = promisify(execFile)
const DISCOVERY_TIMEOUT_MS = 30_000
const MAX_GIT_OUTPUT_BYTES = 4_000_000

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
  return [...containers].sort((left, right) => {
    const leftWorkspace = left.endsWith('.xcworkspace') ? 0 : 1
    const rightWorkspace = right.endsWith('.xcworkspace') ? 0 : 1
    return leftWorkspace - rightWorkspace || left.split('/').length - right.split('/').length || left.localeCompare(right)
  })
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

  const container = findTrackedXcodeContainers(files)[0]
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
