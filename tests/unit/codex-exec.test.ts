import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execCodexFile } from '../../electron/main/codex-exec'

describe('Codex process execution', () => {
  it('closes stdin so Codex can start without waiting for additional piped input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-codex-stdin-'))
    const executable = join(directory, 'fake-codex.mjs')
    try {
      await writeFile(executable, [
        '#!/usr/bin/env node',
        "process.stdin.resume()",
        "process.stdin.once('end', () => console.log('stdin-closed'))"
      ].join('\n'), 'utf8')
      await chmod(executable, 0o700)

      await expect(execCodexFile(executable, [], {
        cwd: directory,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 16_384,
        timeout: 1_000
      })).resolves.toMatchObject({ stdout: 'stdin-closed\n' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a timeout even when the terminated process exits with code zero', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-codex-timeout-'))
    const executable = join(directory, 'fake-codex.mjs')
    try {
      await writeFile(executable, [
        '#!/usr/bin/env node',
        "process.on('SIGTERM', () => process.exit(0))",
        'setInterval(() => {}, 1_000)'
      ].join('\n'), 'utf8')
      await chmod(executable, 0o700)

      await expect(execCodexFile(executable, [], {
        cwd: directory,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 16_384,
        timeout: 100
      })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
