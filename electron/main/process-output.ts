const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function redactProcessOutput(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/(?:sk|gh[pousr]|github_pat|xox[baprs])[-_][-_A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/Bearer\s+[-._A-Za-z0-9]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
}
