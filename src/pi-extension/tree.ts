import {
  PI_ACP_MARK_CLIENT_MESSAGE_COMMAND,
  PI_ACP_REWIND_CLIENT_MESSAGE_COMMAND,
  PI_ACP_TREE_COMMAND,
  PI_ACP_TREE_SELECTION_TITLE,
  PI_ACP_TREE_SUMMARY_TITLE
} from '../pi-rpc/tree-command.js'

const CLIENT_MESSAGE_ENTRY_TYPE = 'pi-acp-client-message'

type MessageContent = string | Array<{ type?: string; text?: string }>

type SessionEntry = {
  id: string
  parentId: string | null
  type: string
  timestamp?: string
  message?: {
    role?: string
    content?: MessageContent
  }
  content?: MessageContent
  summary?: string
  customType?: string
  data?: unknown
}

type SessionTreeNode = {
  entry: SessionEntry
  children: SessionTreeNode[]
  label?: string
}

type TreeCommandContext = {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>
    editor(title: string, prefill?: string): Promise<string | undefined>
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
  sessionManager: {
    getTree(): SessionTreeNode[]
    getLeafId(): string | null
    getEntries(): SessionEntry[]
    getEntry(id: string): SessionEntry | undefined
  }
  waitForIdle(): Promise<void>
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean
      customInstructions?: string
    }
  ): Promise<{ cancelled: boolean }>
}

type PiExtensionApi = {
  on(event: 'turn_start', handler: (_event: unknown, context: TreeCommandContext) => void | Promise<void>): void
  appendEntry<T>(customType: string, data: T): void
  registerCommand(
    name: string,
    command: {
      description: string
      handler(args: string, context: TreeCommandContext): Promise<void>
    }
  ): void
}

type ClientMessageEntryData = {
  clientMessageId: string
  userEntryId: string
}

type TreeChoice = {
  id: string
  option: string
  description: string
  isUserMessage: boolean
}

function contentText(content: MessageContent | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function oneLine(text: string, maxLength = 100): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function ageLabel(timestamp: string | undefined, now = Date.now()): string {
  if (!timestamp) return ''

  const entryTime = Date.parse(timestamp)
  if (!Number.isFinite(entryTime)) return ''

  const minutes = Math.max(0, Math.floor((now - entryTime) / 60_000))
  return ` · ${minutes} ${minutes === 1 ? 'min' : 'mins'}`
}

function describeEntry(entry: SessionEntry): { kind: string; text: string; isUserMessage: boolean } | null {
  if (entry.type === 'message') {
    const role = entry.message?.role
    const text = oneLine(contentText(entry.message?.content), 64)
    if (!text) return null

    if (role === 'user') return { kind: 'You', text, isUserMessage: true }
    if (role === 'assistant') return { kind: 'Pi', text, isUserMessage: false }
    return null
  }

  if (entry.type === 'custom_message') {
    const text = oneLine(contentText(entry.content), 64)
    return text ? { kind: 'Context', text, isUserMessage: false } : null
  }

  if (entry.type === 'compaction') {
    const text = oneLine(entry.summary ?? 'Compacted context', 64)
    return { kind: 'Compaction', text, isUserMessage: false }
  }

  if (entry.type === 'branch_summary') {
    const text = oneLine(entry.summary ?? 'Branch summary', 64)
    return { kind: 'Summary', text, isUserMessage: false }
  }

  return null
}

function treeChoices(tree: SessionTreeNode[], leafId: string | null): TreeChoice[] {
  const choices: TreeChoice[] = []

  const visit = (nodes: SessionTreeNode[]) => {
    for (const node of nodes) {
      const description = describeEntry(node.entry)

      if (description) {
        const label = node.label ? ` #${oneLine(node.label, 32)}` : ''
        const current = node.entry.id === leafId ? ' · current' : ''
        const age = ageLabel(node.entry.timestamp)
        const option = `${description.kind}: ${description.text}${label}${current}${age}`

        choices.push({
          id: node.entry.id,
          option,
          description: `${description.kind}: ${description.text}`,
          isUserMessage: description.isUserMessage
        })
      }

      visit(node.children)
    }
  }

  visit(tree)
  return choices
}

export default function registerPiAcpTree(pi: PiExtensionApi): void {
  let pendingClientMessageId: string | undefined

  pi.registerCommand(PI_ACP_MARK_CLIENT_MESSAGE_COMMAND, {
    description: 'Internal pi-acp client message marker',
    handler: async args => {
      const clientMessageId = args.trim()
      pendingClientMessageId = clientMessageId || undefined
    }
  })

  pi.on('turn_start', (_event, ctx) => {
    if (!pendingClientMessageId) return

    const userEntryId = ctx.sessionManager.getLeafId()
    if (!userEntryId) {
      pendingClientMessageId = undefined
      return
    }

    pi.appendEntry<ClientMessageEntryData>(CLIENT_MESSAGE_ENTRY_TYPE, {
      clientMessageId: pendingClientMessageId,
      userEntryId
    })
    pendingClientMessageId = undefined
  })

  pi.registerCommand(PI_ACP_REWIND_CLIENT_MESSAGE_COMMAND, {
    description: 'Internal pi-acp message rewind',
    handler: async (args, ctx) => {
      await ctx.waitForIdle()

      const clientMessageId = args.trim()
      if (!clientMessageId) throw new Error('Missing client message ID.')

      const entries = ctx.sessionManager.getEntries()
      let targetId: string | undefined

      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (entry.type !== 'custom' || entry.customType !== CLIENT_MESSAGE_ENTRY_TYPE) continue

        const data = entry.data as Partial<ClientMessageEntryData> | undefined
        if (data?.clientMessageId === clientMessageId && typeof data.userEntryId === 'string') {
          targetId = data.userEntryId
          break
        }
      }

      if (!targetId) {
        const directEntry = ctx.sessionManager.getEntry(clientMessageId)
        if (directEntry?.type === 'message' && directEntry.message?.role === 'user') {
          targetId = directEntry.id
        }
      }

      if (!targetId) throw new Error(`No Pi user message matches client message ${clientMessageId}.`)

      const result = await ctx.navigateTree(targetId, { summarize: false })
      if (result.cancelled) throw new Error('Pi cancelled tree navigation.')
    }
  })

  pi.registerCommand(PI_ACP_TREE_COMMAND, {
    description: 'Internal pi-acp session tree navigator',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()

      const leafId = ctx.sessionManager.getLeafId()
      const choices = treeChoices(ctx.sessionManager.getTree(), leafId)
      if (!choices.length) {
        ctx.ui.notify('The Pi session tree is empty.', 'warning')
        return
      }

      const selectedOption = await ctx.ui.select(
        PI_ACP_TREE_SELECTION_TITLE,
        choices.map(choice => choice.option)
      )
      if (!selectedOption) {
        ctx.ui.notify('Tree navigation cancelled.', 'info')
        return
      }

      const selected = choices.find(choice => choice.option === selectedOption)
      if (!selected) {
        ctx.ui.notify('Tree navigation cancelled because the selected entry was not recognized.', 'error')
        return
      }

      if (selected.id === leafId) {
        ctx.ui.notify('Pi is already at that point in the session tree.', 'info')
        return
      }

      const summaryChoice = await ctx.ui.select(PI_ACP_TREE_SUMMARY_TITLE, [
        'No summary',
        'Summarize',
        'Summarize with custom instructions'
      ])
      if (!summaryChoice) {
        ctx.ui.notify('Tree navigation cancelled.', 'info')
        return
      }

      let customInstructions: string | undefined
      if (summaryChoice === 'Summarize with custom instructions') {
        customInstructions = await ctx.ui.editor('Custom branch-summary instructions')
        if (customInstructions === undefined) {
          ctx.ui.notify('Tree navigation cancelled.', 'info')
          return
        }
      }

      const result = await ctx.navigateTree(selected.id, {
        summarize: summaryChoice !== 'No summary',
        customInstructions
      })
      if (result.cancelled) {
        ctx.ui.notify('Pi cancelled tree navigation.', 'warning')
        return
      }

      const destination = selected.isUserMessage ? `before “${selected.description}”` : `at “${selected.description}”`
      ctx.ui.notify(
        `Pi's active context moved ${destination}. Messages from the abandoned branch remain visible in this Zed view, but Pi will no longer receive them. Reopen the thread to replay only the active branch.`,
        'info'
      )
    }
  })
}
