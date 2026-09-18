import type {
  AgentSideConnection,
  ContentBlock,
  ElicitationSchema,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { todoResultToPlanEntries, toolResultToText } from './translate/pi-tools.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  supportsFormElicitation?: boolean
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>
type ElicitationResponse = Awaited<ReturnType<AgentSideConnection['createElicitation']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'
const ELICITATION_CHOICE_FIELD = 'choice'
const ELICITATION_OTHER_FIELD = 'other'
const ELICITATION_ANSWER_FIELD = 'answer'
const FREEFORM_CHOICE_RE = /\b(?:type|enter|write)\s+(?:a\s+)?(?:custom|free[- ]?form)\s+(?:answer|response)\b/i

type AskUserOption = { title: string; description?: string }
type AskUserPrompt = {
  question?: string
  context?: string
  options: AskUserOption[]
}

function askUserPrompt(args: unknown): AskUserPrompt {
  if (!args || typeof args !== 'object') return { options: [] }
  const record = args as Record<string, unknown>
  const options = Array.isArray(record.options)
    ? record.options.flatMap(option => {
        if (typeof option === 'string') return [{ title: option }]
        if (!option || typeof option !== 'object') return []

        const item = option as Record<string, unknown>
        if (typeof item.title !== 'string') return []
        return [
          {
            title: item.title,
            ...(typeof item.description === 'string' ? { description: item.description } : {})
          }
        ]
      })
    : []

  return {
    ...(typeof record.question === 'string' ? { question: record.question } : {}),
    ...(typeof record.context === 'string' ? { context: record.context } : {}),
    options
  }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

export function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

function toUsageUpdate(stats: unknown): SessionUpdate | undefined {
  const record = stats as
    | {
        contextUsage?: { tokens?: unknown; contextWindow?: unknown }
        cost?: unknown
      }
    | null
    | undefined
  const used = record?.contextUsage?.tokens
  const size = record?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return undefined

  const cost = record?.cost
  return {
    sessionUpdate: 'usage_update',
    used: Math.round(used),
    size: Math.round(size),
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? { cost: { amount: cost, currency: 'USD' } }
      : {})
  }
}

export class SessionManager {
  private sessions = new Map<string, MagPiAcpSession>()

  constructor(private readonly store = new SessionStore()) {}

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): MagPiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async fork(params: {
    entryId?: string
    cwd: string
    piCommand?: string
    sourceSessionFile: string
  }): Promise<string> {
    const proc = await PiRpcProcess.spawn({
      cwd: params.cwd,
      piCommand: params.piCommand,
      sessionPath: params.sourceSessionFile
    })
    try {
      if (params.entryId) {
        const messages = await proc.getForkMessages()
        if (!messages.some(message => message.entryId === params.entryId)) {
          throw RequestError.invalidParams(`Pi entry is not forkable: ${params.entryId}`)
        }
        await proc.fork(params.entryId)
      } else {
        await proc.clone()
      }
      const state = (await proc.getState()) as {
        sessionFile?: unknown
        sessionId?: unknown
      }
      if (typeof state.sessionId !== 'string' || typeof state.sessionFile !== 'string') {
        throw RequestError.internalError({}, 'Pi did not return the forked session identity.')
      }
      this.store.upsert({
        cwd: params.cwd,
        sessionFile: state.sessionFile,
        sessionId: state.sessionId
      })
      return state.sessionId
    } finally {
      proc.dispose()
    }
  }

  async create(params: SessionCreateParams): Promise<MagPiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new MagPiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      supportsFormElicitation: params.supportsFormElicitation,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): MagPiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): MagPiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new MagPiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      supportsFormElicitation: params.supportsFormElicitation,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class MagPiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly supportsFormElicitation: boolean
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()
  private activeAskUser?: AskUserPrompt & { toolCallId: string }

  // pi can emit multiple low-level runs for one user prompt (e.g. retries or compaction).
  // The overall agent loop completes when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    supportsFormElicitation?: boolean
    fileCommands?: FileSlashCommand[]
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.supportsFormElicitation = opts.supportsFormElicitation ?? false
    this.fileCommands = opts.fileCommands ?? []

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /** Best-effort attempt to send startup info after the client creates its session UI. */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async sendUsageUpdate(): Promise<void> {
    try {
      const update = toUsageUpdate(await this.proc.getSessionStats())
      if (update) this.emit(update)
    } catch {
      // Usage display is optional; it must not affect the agent turn.
    }
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify the client that a prompt was queued.
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { magPiAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { magPiAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    if (this.activeAskUser?.toolCallId === toolCallId) this.activeAskUser = undefined
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { magPiAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Pi may emit multiple low-level runs; the full prompt ends at `agent_settled`.
    const prompt = this.proc.prompt(t.message, t.images)

    prompt.catch(err => {
      // If the subprocess errors before we get an `agent_settled`, treat as error unless cancelled.
      // Also ensure we flush any already-enqueued updates first.
      void this.flushEmits().finally(() => {
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null
        this.inAgentLoop = false

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { magPiAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
      })
      void err
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls immediately so clients can show a loading state.
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (toolName === 'ask_user') {
          this.activeAskUser = { toolCallId, ...askUserPrompt(args) }
        }

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const toolName = String((ev as any).toolName ?? '')
        const todoEntries = toolName === 'todo' && !isError ? todoResultToPlanEntries(result) : undefined
        if (todoEntries) this.emit({ sessionUpdate: 'plan', entries: todoEntries })

        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'turn_end':
      case 'agent_end': {
        // These end one low-level run. Pi may still retry, compact, or continue queued work.
        break
      }

      case 'agent_settled': {
        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        void this.sendUsageUpdate()
          .finally(() => this.flushEmits())
          .finally(() => {
            const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
            this.pendingTurn?.resolve(reason)
            this.pendingTurn = null
            this.inAgentLoop = false

            // Start next queued prompt, if any.
            const next = this.turnQueue.shift()
            if (next) {
              this.emit({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
              })
              this.startTurn(next)
            } else {
              this.emit({
                sessionUpdate: 'session_info_update',
                _meta: { magPiAcp: { queueDepth: 0, running: false } }
              })
            }
          })
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      if (this.supportsFormElicitation) {
        await this.handleExtensionSelectElicitation(ev, id)
      } else {
        await this.handleExtensionSelect(ev, id)
      }
      return
    }

    if (method === 'confirm') {
      if (this.supportsFormElicitation) {
        await this.handleExtensionConfirmElicitation(ev, id)
      } else {
        await this.handleExtensionConfirm(ev, id)
      }
      return
    }

    if (method === 'input' || method === 'editor') {
      if (this.supportsFormElicitation) {
        await this.handleExtensionTextElicitation(ev, id, method)
        return
      }

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelectElicitation(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const choices = options.filter(option => !FREEFORM_CHOICE_RE.test(option))
    const properties: NonNullable<ElicitationSchema['properties']> = {}

    if (choices.length) {
      properties[ELICITATION_CHOICE_FIELD] = {
        type: 'string',
        title: 'Suggested answers',
        oneOf: choices.map(option => {
          const description = this.activeAskUser?.options.find(candidate => candidate.title === option)?.description
          return {
            const: option,
            title: option,
            ...(description ? { _meta: { magPiAcp: { description } } } : {})
          }
        })
      }
    }

    properties[ELICITATION_OTHER_FIELD] = {
      type: 'string',
      title: 'Custom response',
      description: 'Optional. Add a custom answer or context for the selected suggestion.'
    }

    const response = await this.requestExtensionElicitation(
      ev,
      {
        type: 'object',
        ...(this.activeAskUser?.context ? { description: this.activeAskUser.context } : {}),
        properties
      },
      this.activeAskUser?.question
    )

    if (response?.action !== 'accept') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const other = elicitationString(response, ELICITATION_OTHER_FIELD)?.trim() || null
    const choice = elicitationString(response, ELICITATION_CHOICE_FIELD)
    const value = choice && other ? `${choice}\n\n${other}` : (other ?? choice)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirmElicitation(ev: PiRpcEvent, id: string): Promise<void> {
    const message = stringProp(ev, 'message')
    const response = await this.requestExtensionElicitation(ev, {
      type: 'object',
      properties: {
        [ELICITATION_CHOICE_FIELD]: {
          type: 'string',
          title: message || 'Response',
          oneOf: [
            { const: 'yes', title: 'Yes' },
            { const: 'no', title: 'No' }
          ]
        }
      },
      required: [ELICITATION_CHOICE_FIELD]
    })

    if (response?.action !== 'accept') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const choice = elicitationString(response, ELICITATION_CHOICE_FIELD)
    if (choice !== 'yes' && choice !== 'no') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: choice === 'yes' })
  }

  private async handleExtensionTextElicitation(ev: PiRpcEvent, id: string, method: 'input' | 'editor'): Promise<void> {
    const hint = method === 'input' ? stringProp(ev, 'placeholder') : null
    const prefill = method === 'editor' ? stringProp(ev, 'prefill') : null
    const response = await this.requestExtensionElicitation(ev, {
      type: 'object',
      properties: {
        [ELICITATION_ANSWER_FIELD]: {
          type: 'string',
          title: 'Answer',
          ...(hint ? { description: hint } : {}),
          ...(prefill !== null ? { default: prefill } : {})
        }
      }
    })

    if (response?.action !== 'accept') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({
      id,
      value: elicitationString(response, ELICITATION_ANSWER_FIELD) ?? ''
    })
  }

  private async requestExtensionElicitation(
    ev: PiRpcEvent,
    requestedSchema: ElicitationSchema,
    message?: string
  ): Promise<ElicitationResponse | null> {
    try {
      return await this.conn.createElicitation({
        sessionId: this.sessionId,
        mode: 'form',
        message: message ?? stringProp(ev, 'title') ?? 'Pi requests input',
        requestedSchema
      })
    } catch {
      return null
    }
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function elicitationString(response: ElicitationResponse, key: string): string | null {
  if (response.action !== 'accept' || !('content' in response)) return null
  const content = response.content
  if (!content || typeof content !== 'object') return null
  const value = (content as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
