import type {
  ProjectRuntimeEnvironmentEntry,
  UpsertProjectRuntimeEnvironmentInput
} from '../../src/shared/types'
import type { AppStore } from './store'

export interface RuntimeSecretCipher {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

export interface ResolvedProjectRuntimeEnvironment {
  buildSettings: Record<string, string>
  launchVariables: Record<string, string>
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENVIRONMENT_KEY_PATTERN = /^[a-z][a-z0-9-]*$/

export class ProjectRuntimeEnvironmentService {
  constructor(
    private readonly store: AppStore,
    private readonly cipher: RuntimeSecretCipher
  ) {}

  list(projectId: string): ProjectRuntimeEnvironmentEntry[] {
    return this.store.listProjectRuntimeEnvironment(projectId)
  }

  upsert(input: UpsertProjectRuntimeEnvironmentInput): ProjectRuntimeEnvironmentEntry[] {
    const key = input.key.trim()
    const label = input.label.trim()
    const buildSetting = input.buildSetting?.trim() || null
    const launchVariable = input.launchVariable?.trim() || null
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      throw new Error('환경 항목 key는 소문자 kebab-case로 입력하세요.')
    }
    if (!label) throw new Error('환경 항목 이름을 입력하세요.')
    if ((input.scope === 'build' || input.scope === 'both') && !buildSetting) {
      throw new Error('빌드에 주입할 Xcode build setting 이름을 입력하세요.')
    }
    if ((input.scope === 'launch' || input.scope === 'both') && !launchVariable) {
      throw new Error('앱 실행에 주입할 환경변수 이름을 입력하세요.')
    }
    if (buildSetting && !ENVIRONMENT_NAME_PATTERN.test(buildSetting)) {
      throw new Error('Xcode build setting 이름은 영문, 숫자, 밑줄만 사용할 수 있습니다.')
    }
    if (launchVariable && !ENVIRONMENT_NAME_PATTERN.test(launchVariable)) {
      throw new Error('앱 실행 환경변수 이름은 영문, 숫자, 밑줄만 사용할 수 있습니다.')
    }

    let encryptedValue: Buffer | undefined
    if (input.value !== undefined) {
      if (!input.value.length) throw new Error('환경값은 비워 둘 수 없습니다. 값을 제거하려면 항목을 삭제하세요.')
      if (!this.cipher.isEncryptionAvailable()) {
        throw new Error('운영체제 보안 저장소를 사용할 수 없어 환경값을 저장하지 않았습니다.')
      }
      encryptedValue = this.cipher.encryptString(input.value)
    }
    return this.store.upsertProjectRuntimeEnvironment({
      projectId: input.projectId,
      id: input.id,
      key,
      label,
      scope: input.scope,
      buildSetting: input.scope === 'launch' ? null : buildSetting,
      launchVariable: input.scope === 'build' ? null : launchVariable,
      encryptedValue
    })
  }

  delete(projectId: string, id: string): ProjectRuntimeEnvironmentEntry[] {
    return this.store.deleteProjectRuntimeEnvironment(projectId, id)
  }

  resolve(
    projectId: string,
    requiredKeys: string[]
  ): ResolvedProjectRuntimeEnvironment {
    const buildSettings: Record<string, string> = {}
    const launchVariables: Record<string, string> = {}
    const missing: string[] = []
    for (const key of [...new Set(requiredKeys)]) {
      const stored = this.store.getProjectRuntimeEnvironmentSecret(projectId, key)
      if (!stored?.encryptedValue || !stored.entry.configured) {
        missing.push(key)
        continue
      }
      if (!this.cipher.isEncryptionAvailable()) {
        throw new Error('운영체제 보안 저장소를 사용할 수 없어 등록된 실행 환경값을 읽지 못했습니다.')
      }
      let value: string
      try {
        value = this.cipher.decryptString(stored.encryptedValue)
      } catch {
        throw new Error(`실행 환경 '${stored.entry.label}' 값을 복호화하지 못했습니다. 프로젝트 설정에서 다시 저장하세요.`)
      }
      if (!value.length) {
        missing.push(key)
        continue
      }
      if (stored.entry.buildSetting) buildSettings[stored.entry.buildSetting] = value
      if (stored.entry.launchVariable) launchVariables[stored.entry.launchVariable] = value
    }
    if (missing.length > 0) {
      throw new Error(`필수 실행 환경값을 설정하세요: ${missing.join(', ')}`)
    }
    return { buildSettings, launchVariables }
  }
}
