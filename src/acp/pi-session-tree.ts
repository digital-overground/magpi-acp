import { readFileSync } from 'node:fs'

type SessionEntry = {
  id?: unknown
  parentId?: unknown
  type?: unknown
  summary?: unknown
  message?: {
    role?: unknown
    [key: string]: unknown
  }
}

export type ActiveSessionMessage = {
  id: string
  message: NonNullable<SessionEntry['message']>
}

export function activeSessionMessages(sessionFile: string, leafId?: string | null): ActiveSessionMessage[] {
  let contents: string
  try {
    contents = readFileSync(sessionFile, 'utf8')
  } catch {
    return []
  }

  const entries: Array<SessionEntry & { id: string; parentId: string | null }> = []
  const entriesById = new Map<string, SessionEntry & { id: string; parentId: string | null }>()

  for (const line of contents.split('\n')) {
    if (!line.trim()) continue

    try {
      const entry = JSON.parse(line) as SessionEntry
      if (typeof entry.id !== 'string') continue
      if (entry.parentId !== null && typeof entry.parentId !== 'string') continue

      const normalized = entry as SessionEntry & { id: string; parentId: string | null }
      entries.push(normalized)
      entriesById.set(normalized.id, normalized)
    } catch {
      // Ignore an incomplete trailing line while Pi is still flushing the session.
    }
  }

  const path: typeof entries = []
  const visited = new Set<string>()
  let current = leafId === undefined ? entries.at(-1) : leafId === null ? undefined : entriesById.get(leafId)

  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    path.push(current)
    current = current.parentId === null ? undefined : entriesById.get(current.parentId)
  }

  path.reverse()
  return path.flatMap(entry => {
    if (entry.type === 'message' && entry.message) return [{ id: entry.id, message: entry.message }]
    if (entry.type === 'branch_summary' && typeof entry.summary === 'string') {
      return [{ id: entry.id, message: { role: 'branchSummary', content: entry.summary } }]
    }
    return []
  })
}
