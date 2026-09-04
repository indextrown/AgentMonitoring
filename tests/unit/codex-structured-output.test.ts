import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractCodexFailureMessage,
  extractCodexFinalMessage,
  readCodexStructuredOutput
} from '../../electron/main/codex-structured-output'

describe('Codex structured output', () => {
  it('reads the output-last-message file when Codex created it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-monitoring-output-test-'))
    const outputPath = join(directory, 'result.json')
    try {
      await writeFile(outputPath, JSON.stringify({ summary: '파일 결과' }), 'utf8')

      await expect(readCodexStructuredOutput(outputPath, '', '테스트')).resolves.toEqual({
        summary: '파일 결과'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('recovers the final agent message when the output file is missing', async () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify({ summary: '이벤트 결과' }) }
      }),
      JSON.stringify({ type: 'turn.completed' })
    ].join('\n')

    await expect(
      readCodexStructuredOutput('/missing/result.json', stdout, '검증 시나리오')
    ).resolves.toEqual({ summary: '이벤트 결과' })
  })

  it('uses the last completed agent message', () => {
    const stdout = [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"revision":1}' }
      }),
      'non-json diagnostic',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"revision":2}' }
      })
    ].join('\n')

    expect(extractCodexFinalMessage(stdout)).toBe('{"revision":2}')
  })

  it('falls back to an earlier valid agent message', async () => {
    const stdout = [
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"revision":1}' }
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'incomplete final message' }
      })
    ].join('\n')

    await expect(
      readCodexStructuredOutput('/missing/result.json', stdout, '테크스펙')
    ).resolves.toEqual({ revision: 1 })
  })

  it('extracts the reason from a failed turn', async () => {
    const stdout = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'model context window exceeded' }
    })

    expect(extractCodexFailureMessage(stdout)).toBe('model context window exceeded')
    await expect(
      readCodexStructuredOutput('/missing/result.json', stdout, '테크스펙')
    ).rejects.toThrow('model context window exceeded')
  })

  it('explains when Codex did not return a final response', async () => {
    await expect(
      readCodexStructuredOutput(
        '/missing/result.json',
        JSON.stringify({ type: 'turn.completed' }),
        '검증 시나리오'
      )
    ).rejects.toThrow('최종 응답을 남기지 않았습니다')
  })

  it('explains when every available response is invalid JSON', async () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'not-json' }
    })

    await expect(
      readCodexStructuredOutput('/missing/result.json', stdout, '검증 시나리오')
    ).rejects.toThrow('JSON으로 해석하지 못했습니다')
  })
})
