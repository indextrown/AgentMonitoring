import { readFile } from 'node:fs/promises'

interface CodexJsonEvent {
  type?: unknown
  item?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function extractCodexFinalMessage(stdout: string): string | null {
  let finalMessage: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as CodexJsonEvent
      if (event.type !== 'item.completed') continue
      const item = asRecord(event.item)
      if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        finalMessage = item.text
      }
    } catch {
      // Codex may include a non-JSON diagnostic line. Only valid JSON events are considered.
    }
  }
  return finalMessage
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
  const eventOutput = extractCodexFinalMessage(stdout)
  const candidates = [fileOutput, eventOutput]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))

  if (candidates.length === 0) {
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
