import { readFile } from 'node:fs/promises'

interface CodexJsonEvent {
  type?: unknown
  item?: unknown
  message?: unknown
  error?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function extractCodexAgentMessages(stdout: string): string[] {
  const messages: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as CodexJsonEvent
      if (event.type !== 'item.completed') continue
      const item = asRecord(event.item)
      if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        messages.push(item.text)
      }
    } catch {
      // Codex may include a non-JSON diagnostic line. Only valid JSON events are considered.
    }
  }
  return messages
}

export function extractCodexFinalMessage(stdout: string): string | null {
  return extractCodexAgentMessages(stdout).at(-1) ?? null
}

function normalizedErrorMessage(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, 500)
  const record = asRecord(value)
  if (typeof record?.message === 'string' && record.message.trim()) {
    return record.message.trim().replace(/\s+/g, ' ').slice(0, 500)
  }
  return null
}

export function extractCodexFailureMessage(stdout: string): string | null {
  let failureMessage: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as CodexJsonEvent
      if (event.type !== 'turn.failed' && event.type !== 'error') continue
      failureMessage = normalizedErrorMessage(event.message)
        ?? normalizedErrorMessage(event.error)
        ?? 'Codex가 원인을 제공하지 않고 실행을 중단했습니다.'
    } catch {
      // Ignore non-JSON diagnostics and keep looking for a structured failure event.
    }
  }
  return failureMessage
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function readCodexStructuredOutput(
  outputPath: string,
  stdout: string,
  responseLabel: string
): Promise<unknown> {
  const fileOutput = await readOptionalFile(outputPath)
  const eventOutputs = extractCodexAgentMessages(stdout).reverse()
  const candidates = [fileOutput, ...eventOutputs]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))

  if (candidates.length === 0) {
    const failureMessage = extractCodexFailureMessage(stdout)
    if (failureMessage) {
      throw new Error(`Codex가 ${responseLabel} 생성 중 실패했습니다: ${failureMessage}`)
    }
    throw new Error(
      `Codex가 정상 종료됐지만 ${responseLabel} 최종 응답을 남기지 않았습니다. 잠시 후 다시 시도해 주세요.`
    )
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // A valid stdout event can recover a missing or incomplete output file.
    }
  }

  throw new Error(`Codex가 반환한 ${responseLabel} 응답을 JSON으로 해석하지 못했습니다. 다시 시도해 주세요.`)
}
