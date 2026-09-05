import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectProjectSetupCommand,
  environmentFailureMessage,
  isDependencyManifestPath,
  isEnvironmentFailureOutput
} from '../../electron/main/project-environment'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('project environment', () => {
  it('detects the Tuist dependency setup command', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'agent-monitoring-environment-'))
    temporaryDirectories.push(repository)
    await mkdir(join(repository, 'Tuist'))
    await writeFile(join(repository, 'Tuist', 'Package.swift'), '// dependencies\n')

    await expect(detectProjectSetupCommand(repository)).resolves.toBe('tuist install')
  })

  it('recognizes dependency manifests without treating source files as manifests', () => {
    expect(isDependencyManifestPath('Tuist/Package.swift')).toBe(true)
    expect(isDependencyManifestPath('Package.resolved')).toBe(true)
    expect(isDependencyManifestPath('pnpm-lock.yaml')).toBe(true)
    expect(isDependencyManifestPath('Sources/App.swift')).toBe(false)
  })

  it('classifies dependency, network, and authentication failures', () => {
    expect(isEnvironmentFailureOutput('MapboxMaps is not a valid configured external dependency')).toBe(true)
    expect(environmentFailureMessage('Run tuist install before you continue')).toContain('Tuist 외부 의존성')
    expect(environmentFailureMessage('Could not resolve host github.com')).toContain('네트워크')
    expect(environmentFailureMessage('Authentication failed for repository')).toContain('인증')
    expect(isEnvironmentFailureOutput('XCTAssertEqual failed: expected 1, got 2')).toBe(false)
  })

  it('classifies Simulator service and invalid workspace failures as environment problems', () => {
    expect(isEnvironmentFailureOutput('CoreSimulatorService connection became invalid')).toBe(true)
    expect(environmentFailureMessage('Failed to initialize simulator device set')).toContain('Simulator 서비스')
    expect(isEnvironmentFailureOutput("'Yeobaek.xcworkspace' is not a workspace file")).toBe(true)
    expect(environmentFailureMessage("'Yeobaek.xcworkspace' is not a workspace file")).toContain('Xcode workspace')
  })
})
