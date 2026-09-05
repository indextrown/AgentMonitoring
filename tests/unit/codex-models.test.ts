import { describe, expect, it } from 'vitest'
import {
  codexModelArguments,
  resolveCodexModelPlan
} from '../../src/shared/codex-models'
import type { CodexModelCatalog } from '../../src/shared/types'

const catalog: CodexModelCatalog = {
  defaultModelId: 'gpt-default',
  loadedAt: '2026-09-05T00:00:00.000Z',
  models: [
    {
      id: 'gpt-default',
      displayName: 'Default',
      description: '',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'high', description: '' }
      ],
      defaultReasoningEffort: 'low',
      inputModalities: ['text', 'image'],
      isDefault: true,
      upgrade: null
    },
    {
      id: 'gpt-review',
      displayName: 'Review',
      description: '',
      supportedReasoningEfforts: [{ reasoningEffort: 'xhigh', description: '' }],
      defaultReasoningEffort: 'xhigh',
      inputModalities: ['text', 'image'],
      isDefault: false,
      upgrade: null
    }
  ]
}

describe('Codex model profiles', () => {
  it('freezes the current Codex recommendation into every task role', () => {
    const plan = resolveCodexModelPlan(catalog, null, 'codex-recommended', '2026-09-05T01:00:00.000Z')
    expect(plan.source).toBe('codex-recommended')
    expect(Object.values(plan.roles).every((selection) => selection.model === 'gpt-default')).toBe(true)
    expect(plan.roles.implementer.reasoningEffort).toBe('low')
  })

  it('uses explicit role overrides and validates supported effort', () => {
    const plan = resolveCodexModelPlan(catalog, {
      version: 1,
      mode: 'role-based',
      selection: { model: 'gpt-default', reasoningEffort: 'high' },
      roleSelections: { reviewer: { model: 'gpt-review', reasoningEffort: 'xhigh' } }
    }, 'project')
    expect(plan.roles.implementer).toEqual({ model: 'gpt-default', reasoningEffort: 'high' })
    expect(plan.roles.reviewer).toEqual({ model: 'gpt-review', reasoningEffort: 'xhigh' })
    expect(() => resolveCodexModelPlan(catalog, {
      version: 1,
      mode: 'single',
      selection: { model: 'gpt-review', reasoningEffort: 'low' },
      roleSelections: {}
    }, 'task')).toThrow('지원하지 않습니다')
  })

  it('builds per-run CLI arguments without changing global config', () => {
    expect(codexModelArguments({ model: 'gpt-review', reasoningEffort: 'xhigh' })).toEqual([
      '--model',
      'gpt-review',
      '--config',
      'model_reasoning_effort="xhigh"'
    ])
  })
})
