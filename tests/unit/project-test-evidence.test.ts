import { lstat, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectProjectTestEvidence, findProjectTestBundle, projectTestFailureFingerprint, type ProjectTestEvidenceInput } from '../../electron/main/project-test-evidence'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<{ input: ProjectTestEvidenceInput; bundle: string; calls: string[][] }> {
  const root = await mkdtemp(join(tmpdir(), 'project-test-evidence-'))
  roots.push(root)
  const worktreePath = join(root, 'worktree')
  const derivedDataRoot = join(root, 'DerivedData')
  const bundle = join(derivedDataRoot, 'App-abc', 'Logs/Test/Current.xcresult')
  await mkdir(worktreePath)
  await mkdir(bundle, { recursive: true })
  await writeFile(join(derivedDataRoot, 'App-abc/info.plist'), 'fixture')
  const calls: string[][] = []
  const input: ProjectTestEvidenceInput = {
    worktreePath, derivedDataRoot, commandLine: 'tuist test', since: Date.now() - 1_000,
    evidenceDirectory: join(root, 'evidence'),
    execute: async (request) => {
      calls.push(request.args)
      let stdout = ''
      if (request.command === '/usr/bin/plutil') stdout = join(worktreePath, 'App.xcworkspace')
      else if (request.args.includes('summary')) stdout = JSON.stringify({
        finishTime: Date.now() / 1_000,
        testFailures: [{ testIdentifierString: 'Buttons/testLocation()', failureText: 'XCTAssertTrue failed', targetName: 'AppUITests' }]
      })
      else if (request.args.includes('activities')) stdout = JSON.stringify({ testRuns: [{ activities: [
        { title: 'Waiting 10s for "location-button" Button', attachments: [
          { name: 'App UI hierarchy ../../../ignored', payloadId: 'tree-id' },
          { name: '../../../screen.png', payloadId: 'screen-id' },
          { name: 'App UI hierarchy duplicate', payloadId: 'tree-id' },
          { name: 'App UI hierarchy bad', payloadId: '../invalid' }
        ] },
        { title: 'XCTAssertTrue failed' }
      ] }] })
      else if (request.args.includes('export')) {
        const path = request.args[request.args.indexOf('--output-path') + 1]
        const id = request.args[request.args.indexOf('--id') + 1]
        await writeFile(path, id === 'screen-id'
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
          : 'Other identifier: location-button\n  Button identifier: location.fill\npk.test-secret-not-for-prompts')
      }
      return { code: 0, stdout, output: stdout }
    }
  }
  return { input, bundle, calls }
}

describe('project UI test evidence', () => {
  it('extracts actual element types, activities and valid images into a redacted persisted diagnostic', async () => {
    const { input, bundle, calls } = await fixture()
    const result = await collectProjectTestEvidence(input)
    expect(result?.bundlePath).toBe(bundle)
    expect(result?.context).toContain('Other identifier: location-button')
    expect(result?.context).toContain('Button identifier: location.fill')
    expect(result?.context).toContain('Waiting 10s')
    expect(result?.context).not.toContain('pk.test-secret')
    expect(result?.imagePaths).toHaveLength(1)
    expect(calls.filter((args) => args.includes('export'))).toHaveLength(2)
    expect(await readFile(result!.artifactPath, 'utf8')).toContain('[REDACTED]')
    expect(await readFile(join(input.evidenceDirectory, 'attachment-1.txt'), 'utf8')).not.toContain('pk.test-secret')
    if (process.platform !== 'win32') {
      expect((await lstat(input.evidenceDirectory)).mode & 0o777).toBe(0o700)
      expect((await lstat(join(input.evidenceDirectory, 'attachment-1.txt'))).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects results from another checkout with the same workspace name', async () => {
    const { input } = await fixture()
    input.execute = async () => ({ code: 0, stdout: join(input.worktreePath + '-other', 'App.xcworkspace'), output: '' })
    expect(await findProjectTestBundle(input)).toBeNull()
  })

  it('rejects stale bundles even when they are the latest result for this checkout', async () => {
    const { input, bundle } = await fixture()
    await utimes(bundle, new Date(0), new Date(0))
    expect(await collectProjectTestEvidence(input)).toBeNull()
  })

  it('checks result finish time too, rather than trusting directory mtime alone', async () => {
    const { input } = await fixture()
    const execute = input.execute
    input.execute = async (request) => request.args.includes('summary')
      ? { code: 0, stdout: JSON.stringify({ finishTime: 0, testFailures: [{ testIdentifierString: 'Old/test()' }] }), output: '' }
      : execute(request)
    expect(await collectProjectTestEvidence(input)).toBeNull()
  })

  it('accepts the failed run even if reading its bundle updated directory mtime later', async () => {
    const { input, bundle } = await fixture()
    const finished = Date.now() - 500
    input.until = finished + 10
    await utimes(bundle, new Date(), new Date(Date.now() + 60_000))
    const execute = input.execute
    input.execute = async (request) => request.args.includes('summary')
      ? { code: 0, stdout: JSON.stringify({ finishTime: finished / 1_000 }), output: '' }
      : execute(request)
    expect(await findProjectTestBundle(input)).toBe(bundle)
  })

  it('does not send invalid image attachments and removes their exported files', async () => {
    const { input } = await fixture()
    const execute = input.execute
    input.execute = async (request) => {
      const result = await execute(request)
      if (request.args.includes('export') && request.args.includes('screen-id')) {
        await writeFile(request.args[request.args.indexOf('--output-path') + 1], 'not an image')
      }
      return result
    }
    const evidence = await collectProjectTestEvidence(input)
    expect(evidence?.imagePaths).toEqual([])
    await expect(lstat(join(input.evidenceDirectory, 'attachment-2.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not follow a symlinked explicitly configured result bundle', async () => {
    const { input, bundle } = await fixture()
    const link = join(input.worktreePath, 'Linked.xcresult')
    await symlink(bundle, link)
    input.commandLine = 'xcodebuild test -resultBundlePath Linked.xcresult'
    input.derivedDataRoot = join(input.worktreePath, 'missing')
    expect(await findProjectTestBundle(input)).toBeNull()
  })

  it('honors an explicit result path with spaces', async () => {
    const { input, bundle } = await fixture()
    const path = join(input.worktreePath, 'Test result.xcresult')
    await mkdir(path)
    await utimes(bundle, new Date(0), new Date(0))
    input.commandLine = 'xcodebuild test -resultBundlePath "Test result.xcresult"'
    expect(await findProjectTestBundle(input)).toBe(path)
  })

  it('preserves test failure details when activities or individual attachments cannot be read', async () => {
    const { input } = await fixture()
    const execute = input.execute
    input.execute = async (request) => request.args.includes('activities')
      ? { code: 1, stdout: '', output: 'unsupported Xcode' }
      : execute(request)
    const result = await collectProjectTestEvidence(input)
    expect(result?.context).toContain('XCTAssertTrue failed')
    expect(result?.context).toContain('추출하지 못했습니다')
  })

  it('fingerprints failures independently of ordering but distinguishes changed failures', () => {
    const failures = [{ testIdentifierString: 'A', failureText: 'one' }, { testIdentifierString: 'B', failureText: 'two' }]
    expect(projectTestFailureFingerprint(failures)).toBe(projectTestFailureFingerprint([...failures].reverse()))
    expect(projectTestFailureFingerprint(failures)).not.toBe(projectTestFailureFingerprint(failures.slice(1)))
  })
})
