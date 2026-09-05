import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { CodexAuthStatus } from '../../src/shared/types'
import { CodexAuthManager } from '../../electron/main/codex-auth'

const temporaryDirectories: string[] = []
const originalRecordPath = process.env.AGENT_MONITORING_AUTH_TEST_RECORD
const originalApiKey = process.env.OPENAI_API_KEY

afterEach(async () => {
  if (originalRecordPath === undefined) delete process.env.AGENT_MONITORING_AUTH_TEST_RECORD
  else process.env.AGENT_MONITORING_AUTH_TEST_RECORD = originalRecordPath
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalApiKey
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CodexAuthManager', () => {
  it('runs the app-server OAuth flow in an isolated CODEX_HOME', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-auth-'))
    temporaryDirectories.push(directory)
    const codexHome = join(directory, 'codex-home')
    const recordPath = join(directory, 'environment.jsonl')
    const fakeCodex = join(directory, 'fake-codex.mjs')
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const codexHome = process.env.CODEX_HOME
const statePath = join(codexHome, 'fake-authenticated')
mkdirSync(codexHome, { recursive: true })
appendFileSync(process.env.AGENT_MONITORING_AUTH_TEST_RECORD, JSON.stringify({
  codexHome,
  apiKey: process.env.OPENAI_API_KEY ?? null,
  args: process.argv.slice(2)
}) + '\\n')

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } })
  if (message.method === 'account/read') {
    send({ id: message.id, result: { account: existsSync(statePath) ? {
      type: 'chatgpt', email: 'agent@example.com', planType: 'plus'
    } : null, requiresOpenaiAuth: true } })
  }
  if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [{
      id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'GPT Fixture', description: 'fixture model',
      hidden: false, supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'fast' },
        { reasoningEffort: 'high', description: 'deep' }
      ], defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], isDefault: true, upgrade: null
    }], nextCursor: null } })
  }
  if (message.method === 'account/login/start') {
    send({ id: message.id, result: {
      type: 'chatgpt', loginId: 'login-fixture', authUrl: 'https://chatgpt.com/codex/auth-fixture'
    } })
    setTimeout(() => {
      writeFileSync(statePath, 'ok')
      send({ method: 'account/login/completed', params: {
        loginId: 'login-fixture', success: true, error: null
      } })
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } })
    }, 10)
  }
  if (message.method === 'account/logout') {
    rmSync(statePath, { force: true })
    send({ id: message.id, result: {} })
  }
  if (message.method === 'account/login/cancel') send({ id: message.id, result: {} })
})
`
    )
    await chmod(fakeCodex, 0o755)

    process.env.AGENT_MONITORING_AUTH_TEST_RECORD = recordPath
    process.env.OPENAI_API_KEY = 'must-not-be-inherited'
    const published: CodexAuthStatus[] = []
    const manager = new CodexAuthManager(codexHome, (status) => published.push(status), fakeCodex)

    expect((await manager.status()).state).toBe('signed_out')
    let openedUrl = ''
    const authenticated = await manager.login(async (url) => {
      openedUrl = url
    })

    expect(openedUrl).toBe('https://chatgpt.com/codex/auth-fixture')
    expect(authenticated).toMatchObject({
      state: 'signed_in',
      authMode: 'chatgpt',
      email: 'agent@example.com',
      planType: 'plus'
    })
    expect((await manager.status()).state).toBe('signed_in')
    expect(await manager.models()).toMatchObject({
      defaultModelId: 'gpt-fixture',
      models: [{ id: 'gpt-fixture', defaultReasoningEffort: 'low', isDefault: true }]
    })
    expect((await manager.logout()).state).toBe('signed_out')
    expect(published.some((status) => status.state === 'signing_in')).toBe(true)

    const records = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(records.every((record) => record.codexHome === codexHome)).toBe(true)
    expect(records.every((record) => record.apiKey === null)).toBe(true)
    expect(records.every((record) => record.args.includes('forced_login_method="chatgpt"'))).toBe(true)
  })
})
