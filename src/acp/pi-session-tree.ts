import { readFileSync } from 'node:fs'
import { MAGPI_ACP_CLIENT_MESSAGE_ENTRY_TYPE } from '../pi-rpc/tree-command.js'

type SessionEntry = {
  id?: unknown
  parentId?: unknown
  type?: unknown
  message?: {
    role?: unknown
    [key: string]: unknown
  }
  customType?: unknown
  data?: {
    clientMessageId?: unknown
    userEntryId?: unknown
  }
}

export function userMessageEntryId(sessionFile: string, clientMessageId: string): string | undefined {
  let contents: string
  try {
    contents = readFileSync(sessionFile, 'utf8')
  } catch {
    return undefined
  }

  const entries = contents
    .split('\n')
    .filter(line => line.trim())
    .flatMap(line => {
      try {
        return [JSON.parse(line) as SessionEntry]
      } catch {
        return []
      }
    })
  const direct = entries.find(
    entry => entry.id === clientMessageId && entry.type === 'message' && entry.message?.role === 'user'
  )
  if (typeof direct?.id === 'string') return direct.id

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const marker = entries[index]
    if (
      marker.type !== 'custom' ||
      marker.customType !== MAGPI_ACP_CLIENT_MESSAGE_ENTRY_TYPE ||
      marker.data?.clientMessageId !== clientMessageId
    ) {
      continue
    }
    const child = entries.find(
      entry => entry.parentId === marker.id && entry.type === 'message' && entry.message?.role === 'user'
    )
    if (typeof child?.id === 'string') return child.id

    const recorded = entries.find(
      entry => entry.id === marker.data?.userEntryId && entry.type === 'message' && entry.message?.role === 'user'
    )
    if (typeof recorded?.id === 'string') return recorded.id
  }
  return undefined
}

export type ActiveSessionMessage = {
  id: string
  message: NonNullable<SessionEntry['message']>
}

export function activeSessionMessages(sessionFile: string): ActiveSessionMessage[] {
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
  let current = entries.at(-1)

  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    path.push(current)
    current = current.parentId === null ? undefined : entriesById.get(current.parentId)
  }

  path.reverse()
  return path.flatMap(entry =>
    entry.type === 'message' && entry.message ? [{ id: entry.id, message: entry.message }] : []
  )
}

export function activeUserMessageEntryIds(sessionFile: string): string[] {
  return activeSessionMessages(sessionFile)
    .filter(entry => entry.message.role === 'user')
    .map(entry => entry.id)
}
