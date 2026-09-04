import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

export async function resolveGithubCommand(): Promise<string> {
  const configured = process.env.GITHUB_CLI_PATH
  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, 'gh'))
  const candidates = [
    configured && isAbsolute(configured) ? configured : null,
    ...pathCandidates,
    join(homedir(), '.local', 'bin', 'gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh'
  ]

  for (const candidate of new Set(candidates.filter((value): value is string => Boolean(value)))) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through known GitHub CLI installation locations.
    }
  }
  return 'gh'
}
