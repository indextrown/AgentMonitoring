import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  requestIosDebugBridge,
  type RuntimeDebugBridgeRequestInput
} from '../../electron/main/ios-debug-bridge'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createBridgeFixture(): Promise<{
  container: string
  requests: string
  responses: string
  baseInput: Omit<RuntimeDebugBridgeRequestInput, 'fixture' | 'captureState' | 'wait'>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-debug-bridge-'))
  temporaryDirectories.push(directory)
  const container = join(directory, 'AppData')
  const requests = join(
    container,
    'Library',
    'Application Support',
    'AgentMonitoring',
    'Requests'
  )
  const responses = join(
    container,
    'Library',
    'Application Support',
    'AgentMonitoring',
    'Responses'
  )
  await mkdir(container)
  return {
    container,
    requests,
    responses,
    baseInput: {
      deviceId: 'IPHONE-UDID',
      bundleIdentifier: 'com.example.PopPang',
      cwd: directory,
      timeoutSeconds: 10,
      execute: async (request) => {
        expect(request.command).toBe('/usr/bin/xcrun')
        expect(request.args).toEqual([
          'simctl',
          'get_app_container',
          'IPHONE-UDID',
          'com.example.PopPang',
          'data'
        ])
        return { code: 0, output: container, stdout: `${container}\n` }
      }
    }
  }
}

describe('iOS Debug state bridge', () => {
  it('applies a fixture and removes the UUID request and response after validation', async () => {
    const fixture = await createBridgeFixture()
    let requestPayload: Record<string, unknown> | null = null
    const result = await requestIosDebugBridge({
      ...fixture.baseInput,
      fixture: {
        id: 'signed-in-home',
        payload: { accountID: 'fixture-user', unreadCount: 3 }
      },
      captureState: false,
      wait: async () => {
        const [requestFile] = await readdir(fixture.requests)
        requestPayload = JSON.parse(await readFile(join(fixture.requests, requestFile), 'utf8'))
        const requestId = String(requestPayload?.requestId)
        await writeFile(
          join(fixture.responses, `${requestId}.json`),
          JSON.stringify({
            schemaVersion: 1,
            requestId,
            completedAt: '2026-09-03T00:00:00Z',
            fixture: { id: 'signed-in-home', appliedAt: '2026-09-03T00:00:00Z' }
          })
        )
      }
    })

    expect(requestPayload).toMatchObject({
      schemaVersion: 1,
      captureState: false,
      fixture: {
        id: 'signed-in-home',
        payload: { accountID: 'fixture-user', unreadCount: 3 }
      }
    })
    expect(result).toMatchObject({
      fixture: { id: 'signed-in-home' }
    })
    expect(await readdir(fixture.requests)).toEqual([])
    expect(await readdir(fixture.responses)).toEqual([])
  })

  it('collects a JSON state response for the exact request', async () => {
    const fixture = await createBridgeFixture()
    const result = await requestIosDebugBridge({
      ...fixture.baseInput,
      fixture: null,
      captureState: true,
      wait: async () => {
        const [requestFile] = await readdir(fixture.requests)
        const request = JSON.parse(await readFile(join(fixture.requests, requestFile), 'utf8'))
        await writeFile(
          join(fixture.responses, `${request.requestId}.json`),
          JSON.stringify({
            schemaVersion: 1,
            requestId: request.requestId,
            completedAt: '2026-09-03T00:00:00Z',
            fixture: null,
            state: { route: 'navigation', isNavigating: true }
          })
        )
      }
    })

    expect(result).toMatchObject({
      fixture: null,
      state: { route: 'navigation', isNavigating: true }
    })
  })

  it('rejects a response for a different request', async () => {
    const fixture = await createBridgeFixture()
    await expect(
      requestIosDebugBridge({
        ...fixture.baseInput,
        fixture: null,
        captureState: true,
        wait: async () => {
          const [requestFile] = await readdir(fixture.requests)
          const request = JSON.parse(await readFile(join(fixture.requests, requestFile), 'utf8'))
          await writeFile(
            join(fixture.responses, `${request.requestId}.json`),
            JSON.stringify({
              schemaVersion: 1,
              requestId: '00000000-0000-4000-8000-000000000999',
              completedAt: '2026-09-03T00:00:00Z',
              fixture: null,
              state: { route: 'navigation', isNavigating: true }
            })
          )
        }
      })
    ).rejects.toThrow('request ID가 요청과 다릅니다.')
  })

  it('surfaces a bounded target-app bridge error', async () => {
    const fixture = await createBridgeFixture()
    await expect(
      requestIosDebugBridge({
        ...fixture.baseInput,
        fixture: null,
        captureState: true,
        wait: async () => {
          const [requestFile] = await readdir(fixture.requests)
          const request = JSON.parse(await readFile(join(fixture.requests, requestFile), 'utf8'))
          await writeFile(
            join(fixture.responses, `${request.requestId}.json`),
            JSON.stringify({
              schemaVersion: 1,
              requestId: request.requestId,
              completedAt: '2026-09-03T00:00:00Z',
              fixture: null,
              error: { message: '앱 상태 제공자가 연결되지 않았습니다.' }
            })
          )
        }
      })
    ).rejects.toThrow('대상 앱 Debug bridge 실패')
  })

  it('rejects app-container bridge directories that escape through a symbolic link', async () => {
    const fixture = await createBridgeFixture()
    const external = join(fixture.container, '..', 'external-library')
    await mkdir(external)
    await symlink(external, join(fixture.container, 'Library'))

    await expect(
      requestIosDebugBridge({
        ...fixture.baseInput,
        fixture: { id: 'signed-in-home', payload: {} },
        captureState: false
      })
    ).rejects.toThrow('심볼릭 링크가 아닌 디렉터리여야 합니다.')
    expect(await readdir(external)).toEqual([])
  })
})
