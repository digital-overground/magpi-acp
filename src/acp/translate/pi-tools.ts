import type { PlanEntry } from '@agentclientprotocol/sdk'

export function todoResultToPlanEntries(result: unknown): PlanEntry[] | undefined {
  const details = (result as { details?: { tasks?: unknown; todos?: unknown } } | null)?.details

  if (Array.isArray(details?.tasks)) {
    const entries: PlanEntry[] = []
    for (const task of details.tasks) {
      const item = task as { subject?: unknown; status?: unknown } | null
      if (typeof item?.subject !== 'string') return undefined
      if (item.status === 'deleted') continue
      if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') return undefined
      entries.push({ content: item.subject, priority: 'medium', status: item.status })
    }
    return entries
  }

  if (!Array.isArray(details?.todos)) return undefined

  let hasActiveTodo = false
  const entries: PlanEntry[] = []
  for (const todo of details.todos) {
    const item = todo as { text?: unknown; done?: unknown } | null
    if (typeof item?.text !== 'string' || typeof item.done !== 'boolean') return undefined

    const status = item.done ? 'completed' : hasActiveTodo ? 'pending' : 'in_progress'
    if (!item.done) hasActiveTodo = true
    entries.push({ content: item.text, priority: 'medium', status })
  }
  return entries
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
