import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRuntimeEnvironmentService, type RuntimeSecretCipher } from '../../electron/main/runtime-environment'
import { AppStore } from '../../electron/main/store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const cipher: RuntimeSecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from([...Buffer.from(value)].reverse()),
  decryptString: (value) => Buffer.from([...value].reverse()).toString('utf8')
}

describe('project runtime environment', () => {
  it('keeps values encrypted and resolves them only for their project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runtime-environment-'))
    temporaryDirectories.push(directory)
    const store = new AppStore(join(directory, 'test.sqlite'))
    const first = store.addProject('First', join(directory, 'First'))
    const second = store.addProject('Second', join(directory, 'Second'))
    const service = new ProjectRuntimeEnvironmentService(store, cipher)

    const entries = service.upsert({
      projectId: first.id,
      key: 'mapbox-public-token',
      label: 'Mapbox 공개 토큰',
      scope: 'both',
      buildSetting: 'MAPBOX_ACCESS_TOKEN',
      launchVariable: 'UITEST_MAPBOX_ACCESS_TOKEN',
      value: 'pk.private-value'
    })

    expect(entries).toEqual([
      expect.objectContaining({ key: 'mapbox-public-token', configured: true })
    ])
    expect(JSON.stringify(entries)).not.toContain('pk.private-value')
    expect(service.resolve(first.id, ['mapbox-public-token'])).toEqual({
      buildSettings: { MAPBOX_ACCESS_TOKEN: 'pk.private-value' },
      launchVariables: { UITEST_MAPBOX_ACCESS_TOKEN: 'pk.private-value' }
    })
    expect(() => service.resolve(second.id, ['mapbox-public-token'])).toThrow('필수 실행 환경값')
    const encrypted = store.getProjectRuntimeEnvironmentSecret(first.id, 'mapbox-public-token')?.encryptedValue
    expect(encrypted?.toString('utf8')).not.toContain('pk.private-value')
    store.close()
  })

  it('never falls back to plain text when encryption is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-runtime-environment-'))
    temporaryDirectories.push(directory)
    const store = new AppStore(join(directory, 'test.sqlite'))
    const project = store.addProject('Demo', join(directory, 'Demo'))
    const service = new ProjectRuntimeEnvironmentService(store, {
      ...cipher,
      isEncryptionAvailable: () => false
    })

    expect(() => service.upsert({
      projectId: project.id,
      key: 'private-token',
      label: '비밀 토큰',
      scope: 'launch',
      launchVariable: 'PRIVATE_TOKEN',
      value: 'secret'
    })).toThrow('보안 저장소')
    expect(service.list(project.id)).toEqual([])
    store.close()
  })
})
