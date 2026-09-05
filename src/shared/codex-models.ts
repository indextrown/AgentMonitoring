import type {
  CodexModelCatalog,
  CodexExecutionMode,
  CodexModelProfile,
  CodexModelRole,
  CodexModelSelection,
  CodexResolvedModelPlan
} from './types'

export const CODEX_MODEL_ROLES: CodexModelRole[] = [
  'planning',
  'test-designer',
  'critic',
  'implementer',
  'reviewer'
]

export const CODEX_MODEL_ROLE_LABELS: Record<CodexModelRole, string> = {
  planning: '테크스펙·검증 준비',
  'test-designer': 'Test Designer',
  critic: 'Critic',
  implementer: 'Implementer',
  reviewer: 'Reviewer'
}

export const RECOMMENDED_CODEX_MODEL_PROFILE: CodexModelProfile = {
  version: 1,
  mode: 'recommended',
  executionMode: 'independent',
  selection: null,
  roleSelections: {}
}

function requireCatalogModel(catalog: CodexModelCatalog, modelId: string) {
  const model = catalog.models.find((candidate) => candidate.id === modelId)
  if (!model) {
    throw new Error(`선택한 Codex 모델 '${modelId}'은 현재 계정에서 사용할 수 없습니다. 모델 설정을 다시 확인하세요.`)
  }
  return model
}

export function validateCodexModelSelection(
  catalog: CodexModelCatalog,
  selection: CodexModelSelection
): CodexModelSelection {
  const model = requireCatalogModel(catalog, selection.model)
  if (!model.supportedReasoningEfforts.some((option) => option.reasoningEffort === selection.reasoningEffort)) {
    throw new Error(`${model.displayName}은 ${selection.reasoningEffort} 추론 강도를 지원하지 않습니다.`)
  }
  return { ...selection }
}

function recommendedSelection(catalog: CodexModelCatalog): CodexModelSelection {
  const model = requireCatalogModel(catalog, catalog.defaultModelId)
  return {
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort
  }
}

export function resolveCodexModelPlan(
  catalog: CodexModelCatalog,
  profile: CodexModelProfile | null | undefined,
  source: CodexResolvedModelPlan['source'],
  resolvedAt = new Date().toISOString()
): CodexResolvedModelPlan {
  const configured = profile ?? RECOMMENDED_CODEX_MODEL_PROFILE
  const fallback = configured.mode === 'recommended'
    ? recommendedSelection(catalog)
    : configured.selection
      ? validateCodexModelSelection(catalog, configured.selection)
      : null
  if (!fallback) throw new Error('선택한 모델 프로필에 기본 모델이 없습니다.')

  const roles = Object.fromEntries(CODEX_MODEL_ROLES.map((role) => {
    const selection = configured.mode === 'role-based' && configured.roleSelections[role]
      ? validateCodexModelSelection(catalog, configured.roleSelections[role]!)
      : fallback
    return [role, { ...selection }]
  })) as CodexResolvedModelPlan['roles']

  return {
    version: 1,
    source,
    executionMode: configured.executionMode ?? 'independent',
    roles,
    resolvedAt
  }
}

export function codexExecutionMode(
  value: Pick<CodexModelProfile, 'executionMode'> | Pick<CodexResolvedModelPlan, 'executionMode'> | null | undefined
): CodexExecutionMode {
  return value?.executionMode === 'root-subagents' ? 'root-subagents' : 'independent'
}

export function codexModelArguments(selection: CodexModelSelection | null | undefined): string[] {
  // All direct roles and pre-task generators opt out of implicit delegation.
  // Hierarchical stages explicitly override this per invocation below.
  const independentArguments = ['--config', 'agents.enabled=false']
  if (!selection) return independentArguments
  return [
    ...independentArguments,
    '--model',
    selection.model,
    '--config',
    `model_reasoning_effort="${selection.reasoningEffort}"`
  ]
}

export function codexSubagentArguments(selection: CodexModelSelection): string[] {
  return [
    '--config',
    'agents.enabled=true',
    '--config',
    'agents.max_concurrent_threads_per_session=1',
    '--config',
    `agents.default_subagent_model=${JSON.stringify(selection.model)}`,
    '--config',
    `agents.default_subagent_reasoning_effort=${JSON.stringify(selection.reasoningEffort)}`
  ]
}

export function codexModelLabel(selection: CodexModelSelection | null | undefined): string {
  return selection
    ? `${selection.model} · ${selection.reasoningEffort}`
    : 'Codex 추천 기본값'
}
