import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ContentBlock,
  ElicitationSchema,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { PiRpcEvent, PiRpcProcess } from "../pi-rpc/process.js";
import { asRecord, stringValue } from "../unknown.js";
import { maybeAuthRequiredError } from "./auth-required.js";
import type { AgentClientConnection } from "./connection.js";
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool,
} from "./translate/bash.js";
import {
  todoResultToPlanEntries,
  toolResultToText,
} from "./translate/pi-tools.js";

export interface SessionCreateParams {
  cwd: string;
  mcpServers: McpServer[];
  conn: AgentClientConnection;
  supportsFormElicitation?: boolean;
  piCommand?: string;
}

export type StopReason = "end_turn" | "cancelled" | "error";

interface Deferred<Value> {
  promise: Promise<Value>;
  reject: (reason?: unknown) => void;
  resolve: (value: Value | PromiseLike<Value>) => void;
}

interface PendingTurn {
  resolve: (reason: StopReason) => void;
  reject: (err: unknown) => void;
}

interface QueuedTurn {
  message: string;
  images: unknown[];
  resolve: (reason: StopReason) => void;
  reject: (err: unknown) => void;
}

type PermissionResponse = Awaited<
  ReturnType<AgentClientConnection["requestPermission"]>
>;
type ElicitationResponse = Awaited<
  ReturnType<AgentClientConnection["createElicitation"]>
>;

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { kind: "allow_once", name: "Yes", optionId: "yes" },
  { kind: "reject_once", name: "No", optionId: "no" },
];
const EXTENSION_UI_RAW_INPUT_KEYS = [
  "title",
  "message",
  "options",
  "placeholder",
  "prefill",
] as const;
const CHOICE_OPTION_PREFIX = "choice-";
const ELICITATION_CHOICE_FIELD = "choice";
const ELICITATION_OTHER_FIELD = "other";
const ELICITATION_ANSWER_FIELD = "answer";
const FREEFORM_CHOICE_RE =
  /\b(?:type|enter|write)\s+(?:a\s+)?(?:custom|free[- ]?form)\s+(?:answer|response)\b/iu;

interface AskUserOption {
  title: string;
  description?: string;
}
interface AskUserPrompt {
  question?: string;
  context?: string;
  options: AskUserOption[];
}

const askUserPrompt = (args: unknown): AskUserPrompt => {
  const record = asRecord(args);
  if (record === undefined) {
    return { options: [] };
  }
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        if (typeof option === "string") {
          return [{ title: option }];
        }
        const item = asRecord(option);
        if (item === undefined) {
          return [];
        }
        if (typeof item.title !== "string") {
          return [];
        }
        return [
          {
            title: item.title,
            ...(typeof item.description === "string"
              ? { description: item.description }
              : {}),
          },
        ];
      })
    : [];

  return {
    ...(typeof record.question === "string"
      ? { question: record.question }
      : {}),
    ...(typeof record.context === "string" ? { context: record.context } : {}),
    options,
  };
};

const findUniqueLineNumber = (
  text: string,
  needle: string
): number | undefined => {
  if (needle.length === 0) {
    return undefined;
  }

  const first = text.indexOf(needle);
  if (first === -1) {
    return undefined;
  }

  const second = text.indexOf(needle, first + needle.length);
  if (second !== -1) {
    return undefined;
  }

  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.codePointAt(i) === 10) {
      line += 1;
    }
  }
  return line;
};

const getToolPath = (args: unknown): string | undefined => {
  const record = asRecord(args);
  if (typeof record?.path === "string") {
    return record.path;
  }
  if (typeof record?.file_path === "string") {
    return record.file_path;
  }
  return undefined;
};

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
const getParsedEdits = (
  args: unknown
): { oldText: string; newText: string }[] => {
  const record = asRecord(args);
  const parsed: { oldText: string; newText: string }[] = [];

  if (
    typeof record?.oldText === "string" &&
    typeof record?.newText === "string"
  ) {
    parsed.push({ newText: record.newText, oldText: record.oldText });
  }

  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits) as unknown;
    } catch {
      edits = undefined;
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = asRecord(edit);
      if (
        typeof item?.oldText === "string" &&
        typeof item?.newText === "string"
      ) {
        parsed.push({ newText: item.newText, oldText: item.oldText });
      }
    }
  }

  return parsed;
};

const getEditOldTexts = (args: unknown): string[] => {
  const record = asRecord(args);
  const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);

  if (
    typeof record?.oldText === "string" &&
    !oldTexts.includes(record.oldText)
  ) {
    oldTexts.push(record.oldText);
  }

  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits) as unknown;
    } catch {
      edits = undefined;
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = asRecord(edit)?.oldText;
      if (typeof oldText === "string" && !oldTexts.includes(oldText)) {
        oldTexts.push(oldText);
      }
    }
  }

  return oldTexts;
};

export const toToolCallLocations = (
  args: unknown,
  cwd: string,
  line?: number
): ToolCallLocation[] | undefined => {
  const toolPath = getToolPath(args);
  if (toolPath === undefined || toolPath.length === 0) {
    return undefined;
  }

  const resolvedPath = path.isAbsolute(toolPath)
    ? toolPath
    : path.resolve(cwd, toolPath);
  return [
    { path: resolvedPath, ...(typeof line === "number" ? { line } : {}) },
  ];
};

const toUsageUpdate = (stats: unknown): SessionUpdate | undefined => {
  const record = asRecord(stats);
  const contextUsage = asRecord(record?.contextUsage);
  const used = contextUsage?.tokens;
  const size = contextUsage?.contextWindow;

  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) {
    return undefined;
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return undefined;
  }

  const cost = record?.cost;
  return {
    sessionUpdate: "usage_update",
    size: Math.round(size),
    used: Math.round(used),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0
      ? { cost: { amount: cost, currency: "USD" } }
      : {}),
  };
};

const stringProp = (
  source: Record<string, unknown>,
  key: string
): string | null => {
  const value = source[key];
  return typeof value === "string" ? value : null;
};

const extensionUiToolCall = (id: string, ev: PiRpcEvent) => {
  const method = stringProp(ev, "method") ?? "ui";
  const title = stringProp(ev, "title") ?? `Pi ${method}`;
  const rawInput: Record<string, unknown> = { method };

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) {
      rawInput[key] = ev[key];
    }
  }

  return {
    kind: "other" as const,
    rawInput,
    status: "pending" as const,
    title,
    toolCallId: `pi-ui-${id}`,
  };
};

const elicitationString = (
  response: ElicitationResponse,
  key: string
): string | null => {
  if (response.action !== "accept" || !("content" in response)) {
    return null;
  }
  const { content } = response;
  const record = asRecord(content);
  if (record === undefined) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const optionIndex = (optionId: string): number | null => {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (rawIndex.length === 0) {
    return null;
  }

  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex
    ? index
    : null;
};

const formatAutoRetryMessage = (ev: PiRpcEvent): string => {
  const attempt = Number(ev.attempt);
  const maxAttempts = Number(ev.maxAttempts);
  const delayMs = Number(ev.delayMs);

  if (
    !Number.isFinite(attempt) ||
    !Number.isFinite(maxAttempts) ||
    !Number.isFinite(delayMs)
  ) {
    return "Retrying...";
  }

  let delaySeconds = Math.round(delayMs / 1000);
  if (delayMs > 0 && delaySeconds === 0) {
    delaySeconds = 1;
  }

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
};

interface StreamingToolCall {
  rawInput: unknown;
  toolCallId: string;
  toolName: string;
}

const streamingToolCall = (
  event: Record<string, unknown>
): StreamingToolCall | null => {
  const partial = asRecord(event.partial);
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const contentIndex =
    typeof event.contentIndex === "number" ? event.contentIndex : 0;
  const toolCall = asRecord(event.toolCall) ?? asRecord(content[contentIndex]);
  const toolCallId = stringValue(toolCall?.id);
  if (toolCallId.length === 0) {
    return null;
  }
  const args = toolCall?.arguments;
  if (args !== null && typeof args === "object") {
    return {
      rawInput: args,
      toolCallId,
      toolName: stringValue(toolCall?.name, "tool"),
    };
  }
  const partialArgs = stringValue(toolCall?.partialArgs);
  let rawInput: unknown;
  if (partialArgs.length > 0) {
    try {
      rawInput = JSON.parse(partialArgs) as unknown;
    } catch {
      rawInput = { partialArgs };
    }
  }
  return {
    rawInput,
    toolCallId,
    toolName: stringValue(toolCall?.name, "tool"),
  };
};

const deferred = <T>(): Deferred<T> => {
  type Outcome =
    | { state: "pending" }
    | { state: "resolved"; value: T | PromiseLike<T> }
    | { reason: unknown; state: "rejected" };

  const events = new EventTarget();
  const outcome: { current: Outcome } = { current: { state: "pending" } };
  const promise = (async (): Promise<T> => {
    await once(events, "settled");
    if (outcome.current.state === "resolved") {
      return await outcome.current.value;
    }
    if (outcome.current.state === "rejected") {
      throw outcome.current.reason instanceof Error
        ? outcome.current.reason
        : new Error("Deferred operation failed.");
    }
    throw new Error("Deferred operation settled without a result.");
  })();

  return {
    promise,
    reject: (reason?: unknown): void => {
      if (outcome.current.state === "pending") {
        outcome.current = { reason, state: "rejected" };
        events.dispatchEvent(new Event("settled"));
      }
    },
    resolve: (value: T | PromiseLike<T>): void => {
      if (outcome.current.state === "pending") {
        outcome.current = { state: "resolved", value };
        events.dispatchEvent(new Event("settled"));
      }
    },
  };
};

const toToolKind = (toolName: string): ToolKind => {
  switch (toolName) {
    case "read": {
      return "read";
    }
    case "write":
    case "edit": {
      return "edit";
    }
    case "bash": {
      return "execute";
    }
    default: {
      return "other";
    }
  }
};

export class MagPiAcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers: McpServer[];

  private startupInfo: string | null = null;
  private startupInfoSent = false;

  readonly proc: PiRpcProcess;
  private readonly conn: AgentClientConnection;
  private readonly supportsFormElicitation: boolean;

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false;

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null;
  private readonly turnQueue: QueuedTurn[] = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private readonly currentToolCalls = new Map<
    string,
    "pending" | "in_progress"
  >();
  private activeAskUser?: AskUserPrompt & { toolCallId: string };

  // pi can emit multiple low-level runs for one user prompt (e.g. retries or compaction).
  // The overall agent loop completes when `agent_settled` is emitted.
  private inAgentLoop = false;

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private readonly fileSnapshots = new Map<
    string,
    { path: string; oldText: string | null }
  >();
  private readonly fileMutationToolCallIds = new Set<string>();
  private readonly bashToolCallIds = new Set<string>();
  private readonly bashOutputSnapshots = new Map<string, string>();

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve();

  constructor(opts: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    proc: PiRpcProcess;
    conn: AgentClientConnection;
    supportsFormElicitation?: boolean;
  }) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.supportsFormElicitation = opts.supportsFormElicitation ?? false;

    this.proc.onEvent((ev) => {
      this.handlePiEvent(ev);
    });
  }

  setStartupInfo(text: string) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }

  /** Best-effort attempt to send startup info after the client creates its session UI. */
  sendStartupInfoIfPending(): void {
    if (
      this.startupInfoSent ||
      this.startupInfo === null ||
      this.startupInfo.length === 0
    ) {
      return;
    }
    this.startupInfoSent = true;

    this.emit({
      content: { text: this.startupInfo, type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
  }

  async sendUsageUpdate(): Promise<void> {
    try {
      const update = toUsageUpdate(await this.proc.getSessionStats());
      if (update) {
        this.emit(update);
      }
    } catch {
      // Usage display is optional; it must not affect the agent turn.
    }
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    const { promise, reject, resolve } = deferred<StopReason>();
    const queued: QueuedTurn = { images, message, reject, resolve };

    if (this.pendingTurn) {
      this.turnQueue.push(queued);
      this.emit({
        content: {
          text: `Queued message (position ${this.turnQueue.length}).`,
          type: "text",
        },
        sessionUpdate: "agent_message_chunk",
      });
    } else {
      this.startTurn(queued);
    }

    return await promise;
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true;

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0);
      for (const t of queued) {
        t.resolve("cancelled");
      }

      this.emit({
        content: { text: "Cleared queued prompts.", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort();
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested;
  }

  private emit(update: SessionUpdate): void {
    this.lastEmit = this.deliverUpdate(this.lastEmit, update);
  }

  private async deliverUpdate(
    previous: Promise<void>,
    update: SessionUpdate
  ): Promise<void> {
    await previous;
    try {
      await this.conn.sessionUpdate({ sessionId: this.sessionId, update });
    } catch {
      // Notification errors must not prevent prompt completion.
    }
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit;
  }

  private emitBashToolCall(params: {
    sessionUpdate: "tool_call" | "tool_call_update";
    toolCallId: string;
    toolName: string;
    args: unknown;
    status: "pending" | "in_progress";
    locations?: ToolCallLocation[];
    includeTerminal: boolean;
  }): void {
    this.bashToolCallIds.add(params.toolCallId);
    this.emit({
      kind: "execute",
      locations: params.locations,
      sessionUpdate: params.sessionUpdate,
      status: params.status,
      title: bashCommand(params.args) ?? params.toolName,
      toolCallId: params.toolCallId,
      ...(params.includeTerminal
        ? { content: bashTerminalContent(params.toolCallId) }
        : {}),
      ...(params.includeTerminal
        ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) }
        : {}),
    });
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string;
    status: "in_progress" | "completed" | "failed";
    result: unknown;
    isError?: boolean;
  }): void {
    const text = bashResultText(params.result);
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text);
    this.bashOutputSnapshots.set(params.toolCallId, text);

    this.emit({
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === "completed" || params.status === "failed"
          ? bashTerminalExitMeta(
              params.toolCallId,
              bashExitCode(params.result, Boolean(params.isError))
            )
          : {}),
      },
      sessionUpdate: "tool_call_update",
      status: params.status,
      toolCallId: params.toolCallId,
    });
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId);
    if (this.activeAskUser?.toolCallId === toolCallId) {
      this.activeAskUser = undefined;
    }
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false;
    this.inAgentLoop = false;

    this.pendingTurn = { reject: t.reject, resolve: t.resolve };

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Pi may emit multiple low-level runs; the full prompt ends at `agent_settled`.
    void this.runPrompt(t);
  }

  private async runPrompt(turn: QueuedTurn): Promise<void> {
    try {
      await this.proc.prompt(turn.message, turn.images);
    } catch (error) {
      await this.flushEmits();
      const authError = maybeAuthRequiredError(error);
      if (authError) {
        this.pendingTurn?.reject(authError);
      } else {
        const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
        this.pendingTurn?.resolve(reason);
      }
      this.pendingTurn = null;
      this.inAgentLoop = false;
    }
  }

  private handleMessageUpdate(ev: PiRpcEvent): void {
    const ame = asRecord(ev.assistantMessageEvent);
    // Stream assistant text.
    if (ame?.type === "text_delta" && typeof ame.delta === "string") {
      this.emit({
        content: { text: ame.delta, type: "text" } satisfies ContentBlock,
        sessionUpdate: "agent_message_chunk",
      });
      return;
    }
    if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
      this.emit({
        content: { text: ame.delta, type: "text" } satisfies ContentBlock,
        sessionUpdate: "agent_thought_chunk",
      });
      return;
    }
    // Surface tool calls immediately so clients can show a loading state.
    if (
      ame?.type === "toolcall_start" ||
      ame?.type === "toolcall_delta" ||
      ame?.type === "toolcall_end"
    ) {
      const toolCall = streamingToolCall(ame);
      if (toolCall) {
        this.emitStreamingToolCall(toolCall);
      }
    }
    // Ignore other delta/event types for now.
  }

  private emitStreamingToolCall(toolCall: StreamingToolCall): void {
    const { rawInput, toolCallId, toolName } = toolCall;
    const existingStatus = this.currentToolCalls.get(toolCallId);
    const status = existingStatus ?? "pending";
    if (isBashTool(toolName)) {
      if (!existingStatus) {
        this.currentToolCalls.set(toolCallId, "pending");
      }
      this.emitBashToolCall({
        args: rawInput,
        includeTerminal: !existingStatus,
        sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
        status,
        toolCallId,
        toolName,
      });
    } else if (existingStatus) {
      this.emit({
        rawInput,
        sessionUpdate: "tool_call_update",
        status,
        toolCallId,
      });
    } else {
      this.currentToolCalls.set(toolCallId, "pending");
      this.emit({
        kind: toToolKind(toolName),
        rawInput,
        sessionUpdate: "tool_call",
        status,
        title: toolName,
        toolCallId,
      });
    }
  }

  private handleToolExecutionStart(ev: PiRpcEvent): void {
    const toolCallId = stringValue(ev.toolCallId, crypto.randomUUID());
    const toolName = stringValue(ev.toolName, "tool");
    const { args } = ev;
    let line: number | undefined;
    if (toolName === "ask_user") {
      this.activeAskUser = { toolCallId, ...askUserPrompt(args) };
    }
    if (isBashTool(toolName)) {
      const locations = toToolCallLocations(args, this.cwd);
      const existingStatus = this.currentToolCalls.get(toolCallId);
      this.currentToolCalls.set(toolCallId, "in_progress");
      this.emitBashToolCall({
        args,
        includeTerminal: !existingStatus,
        locations,
        sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
        status: "in_progress",
        toolCallId,
        toolName,
      });
      return;
    }
    // Capture pre-mutation file contents so we can emit a structured ACP diff.
    const isFileMutation = toolName === "edit" || toolName === "write";
    let snapshotOldText: string | null | undefined;
    if (isFileMutation) {
      this.fileMutationToolCallIds.add(toolCallId);
      const p = getToolPath(args);
      if (p !== undefined && p.length > 0) {
        try {
          const abs = path.isAbsolute(p) ? p : path.resolve(this.cwd, p);
          snapshotOldText = readFileSync(abs, "utf-8");
          this.fileSnapshots.set(toolCallId, {
            oldText: snapshotOldText,
            path: p,
          });
          if (toolName === "edit") {
            for (const needle of getEditOldTexts(args)) {
              line = findUniqueLineNumber(snapshotOldText, needle);
              if (typeof line === "number") {
                break;
              }
            }
          }
        } catch {
          snapshotOldText = null;
          this.fileSnapshots.set(toolCallId, { oldText: null, path: p });
        }
      }
    }
    const locations = toToolCallLocations(args, this.cwd, line);
    // If we already surfaced the tool call while the model streamed it, just transition.
    const existingStatus = this.currentToolCalls.get(toolCallId);
    this.currentToolCalls.set(toolCallId, "in_progress");
    if (existingStatus === undefined) {
      this.emit({
        kind: toToolKind(toolName),
        locations,
        rawInput: args,
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: toolName,
        toolCallId,
      });
    } else {
      this.emit({
        locations,
        rawInput: args,
        sessionUpdate: "tool_call_update",
        status: "in_progress",
        toolCallId,
      });
    }
  }

  private handleToolExecutionUpdate(ev: PiRpcEvent): void {
    const toolCallId = stringValue(ev.toolCallId);
    if (toolCallId.length === 0) {
      return;
    }
    const partial = ev.partialResult;
    if (this.bashToolCallIds.has(toolCallId)) {
      this.emitBashOutputUpdate({
        result: partial,
        status: "in_progress",
        toolCallId,
      });
      return;
    }
    const text = this.fileMutationToolCallIds.has(toolCallId)
      ? ""
      : toolResultToText(partial);
    this.emit({
      content: text
        ? ([
            { content: { text, type: "text" }, type: "content" },
          ] satisfies ToolCallContent[])
        : undefined,
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      toolCallId,
      ...(this.fileMutationToolCallIds.has(toolCallId)
        ? {}
        : { rawOutput: partial }),
    });
  }

  private handleToolExecutionEnd(ev: PiRpcEvent): void {
    const toolCallId = stringValue(ev.toolCallId);
    if (toolCallId.length === 0) {
      return;
    }
    const { result } = ev;
    const isError = Boolean(ev.isError);
    const toolName = stringValue(ev.toolName);
    const todoEntries =
      toolName === "todo" && !isError
        ? todoResultToPlanEntries(result)
        : undefined;
    if (todoEntries !== undefined) {
      this.emit({ entries: todoEntries, sessionUpdate: "plan" });
    }
    if (this.bashToolCallIds.has(toolCallId)) {
      this.emitBashOutputUpdate({
        isError,
        result,
        status: isError ? "failed" : "completed",
        toolCallId,
      });
      this.cleanupToolCall(toolCallId);
      return;
    }
    const text = toolResultToText(result);
    const snapshot = this.fileSnapshots.get(toolCallId);
    let content: ToolCallContent[] | undefined;
    let hasStructuredDiff = false;
    if (!isError && snapshot) {
      try {
        const abs = path.isAbsolute(snapshot.path)
          ? snapshot.path
          : path.resolve(this.cwd, snapshot.path);
        const newText = readFileSync(abs, "utf-8");
        if (snapshot.oldText === null || newText !== snapshot.oldText) {
          hasStructuredDiff = true;
          content = [
            {
              newText,
              oldText: snapshot.oldText,
              path: snapshot.path,
              type: "diff",
            },
          ];
        }
      } catch {
        // ignore; fall back to text only
      }
    }
    if (!content && !hasStructuredDiff && text) {
      content = [
        { content: { text, type: "text" }, type: "content" },
      ] satisfies ToolCallContent[];
    }
    this.emit({
      content,
      sessionUpdate: "tool_call_update",
      status: isError ? "failed" : "completed",
      toolCallId,
      ...(hasStructuredDiff ? {} : { rawOutput: result }),
    });
    this.cleanupToolCall(toolCallId);
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = stringValue(ev.type);

    switch (type) {
      case "message_update": {
        this.handleMessageUpdate(ev);
        break;
      }

      case "tool_execution_start": {
        this.handleToolExecutionStart(ev);
        break;
      }

      case "tool_execution_update": {
        this.handleToolExecutionUpdate(ev);
        break;
      }

      case "tool_execution_end": {
        this.handleToolExecutionEnd(ev);
        break;
      }

      case "extension_ui_request": {
        void this.processExtensionUiRequest(ev);
        break;
      }

      case "auto_retry_start": {
        this.emit({
          content: {
            text: formatAutoRetryMessage(ev),
            type: "text",
          } satisfies ContentBlock,
          sessionUpdate: "agent_message_chunk",
        });
        break;
      }

      case "auto_retry_end": {
        this.emit({
          content: {
            text: "Retry finished, resuming.",
            type: "text",
          } satisfies ContentBlock,
          sessionUpdate: "agent_message_chunk",
        });
        break;
      }

      case "auto_compaction_start": {
        this.emit({
          content: {
            text: "Context nearing limit, running automatic compaction...",
            type: "text",
          } satisfies ContentBlock,
          sessionUpdate: "agent_message_chunk",
        });
        break;
      }

      case "auto_compaction_end": {
        this.emit({
          content: {
            text: "Automatic compaction finished; context was summarized to continue the session.",
            type: "text",
          } satisfies ContentBlock,
          sessionUpdate: "agent_message_chunk",
        });
        break;
      }

      case "agent_start": {
        this.inAgentLoop = true;
        break;
      }

      case "turn_end":
      case "agent_end": {
        // These end one low-level run. Pi may still retry, compact, or continue queued work.
        break;
      }

      case "agent_settled": {
        void this.settleAgent();
        break;
      }

      default: {
        break;
      }
    }
  }

  private async processExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    try {
      await this.handleExtensionUiRequest(ev);
    } catch {
      const id = stringProp(ev, "id");
      if (id === null || id.length === 0) {
        return;
      }
      try {
        await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      } catch {
        // The Pi process may already have exited.
      }
    }
  }

  private async settleAgent(): Promise<void> {
    await this.sendUsageUpdate();
    await this.flushEmits();
    const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn";
    this.pendingTurn?.resolve(reason);
    this.pendingTurn = null;
    this.inAgentLoop = false;
    const next = this.turnQueue.shift();
    if (next !== undefined) {
      this.emit({
        content: {
          text: `Starting queued message. (${this.turnQueue.length} remaining)`,
          type: "text",
        },
        sessionUpdate: "agent_message_chunk",
      });
      this.startTurn(next);
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, "id");
    const method = stringProp(ev, "method");
    if (id === null || id.length === 0) {
      return;
    }

    if (method === "select") {
      await (this.supportsFormElicitation
        ? this.handleExtensionSelectElicitation(ev, id)
        : this.handleExtensionSelect(ev, id));
      return;
    }

    if (method === "confirm") {
      await (this.supportsFormElicitation
        ? this.handleExtensionConfirmElicitation(ev, id)
        : this.handleExtensionConfirm(ev, id));
      return;
    }

    if (method === "input" || method === "editor") {
      if (this.supportsFormElicitation) {
        await this.handleExtensionTextElicitation(ev, id, method);
        return;
      }

      this.emit({
        content: {
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`,
          type: "text",
        } satisfies ContentBlock,
        sessionUpdate: "agent_message_chunk",
      });
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    if (method === "notify") {
      this.emit({
        content: {
          text: stringProp(ev, "message") ?? "Pi notification",
          type: "text",
        } satisfies ContentBlock,
        sessionUpdate: "agent_message_chunk",
      });
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    await this.proc.sendExtensionUiResponse({ cancelled: true, id });
  }

  private async handleExtensionSelectElicitation(
    ev: PiRpcEvent,
    id: string
  ): Promise<void> {
    const rawOptions = ev.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map(String) : [];
    if (options.length === 0) {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    const choices = options.filter(
      (option) => !FREEFORM_CHOICE_RE.test(option)
    );
    const properties: NonNullable<ElicitationSchema["properties"]> = {};

    if (choices.length > 0) {
      properties[ELICITATION_CHOICE_FIELD] = {
        oneOf: choices.map((option) => {
          const description = this.activeAskUser?.options.find(
            (candidate) => candidate.title === option
          )?.description;
          return {
            const: option,
            title: option,
            ...(description !== undefined && description.length > 0
              ? { description }
              : {}),
          };
        }),
        title: "Suggested answers",
        type: "string",
      };
    }

    properties[ELICITATION_OTHER_FIELD] = {
      description:
        "Optional. Add a custom answer or context for the selected suggestion.",
      title: "Custom response",
      type: "string",
    };

    const response = await this.requestExtensionElicitation(
      ev,
      {
        type: "object",
        ...(this.activeAskUser?.context !== undefined &&
        this.activeAskUser.context.length > 0
          ? { description: this.activeAskUser.context }
          : {}),
        properties,
      },
      this.activeAskUser?.question
    );

    if (response?.action !== "accept") {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    const otherText = elicitationString(
      response,
      ELICITATION_OTHER_FIELD
    )?.trim();
    const other =
      otherText === undefined || otherText.length === 0 ? null : otherText;
    const choice = elicitationString(response, ELICITATION_CHOICE_FIELD);
    const value =
      choice !== null && choice.length > 0 && other !== null
        ? `${choice}\n\n${other}`
        : (other ?? choice);
    await this.proc.sendExtensionUiResponse(
      value === null ? { cancelled: true, id } : { id, value }
    );
  }

  private async handleExtensionConfirmElicitation(
    ev: PiRpcEvent,
    id: string
  ): Promise<void> {
    const message = stringProp(ev, "message");
    const response = await this.requestExtensionElicitation(ev, {
      properties: {
        [ELICITATION_CHOICE_FIELD]: {
          oneOf: [
            { const: "yes", title: "Yes" },
            { const: "no", title: "No" },
          ],
          title:
            message === null || message.length === 0 ? "Response" : message,
          type: "string",
        },
      },
      required: [ELICITATION_CHOICE_FIELD],
      type: "object",
    });

    if (response?.action !== "accept") {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    const choice = elicitationString(response, ELICITATION_CHOICE_FIELD);
    if (choice !== "yes" && choice !== "no") {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    await this.proc.sendExtensionUiResponse({
      confirmed: choice === "yes",
      id,
    });
  }

  private async handleExtensionTextElicitation(
    ev: PiRpcEvent,
    id: string,
    method: "input" | "editor"
  ): Promise<void> {
    const hint = method === "input" ? stringProp(ev, "placeholder") : null;
    const prefill = method === "editor" ? stringProp(ev, "prefill") : null;
    const response = await this.requestExtensionElicitation(ev, {
      properties: {
        [ELICITATION_ANSWER_FIELD]: {
          title: "Answer",
          type: "string",
          ...(hint !== null && hint.length > 0 ? { description: hint } : {}),
          ...(prefill === null ? {} : { default: prefill }),
        },
      },
      type: "object",
    });

    if (response?.action !== "accept") {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    await this.proc.sendExtensionUiResponse({
      id,
      value: elicitationString(response, ELICITATION_ANSWER_FIELD) ?? "",
    });
  }

  private async requestExtensionElicitation(
    ev: PiRpcEvent,
    requestedSchema: ElicitationSchema,
    message?: string
  ): Promise<ElicitationResponse | null> {
    try {
      return await this.conn.createElicitation({
        message: message ?? stringProp(ev, "title") ?? "Pi requests input",
        mode: "form",
        requestedSchema,
        sessionId: this.sessionId,
      });
    } catch {
      return null;
    }
  }

  private async handleExtensionSelect(
    ev: PiRpcEvent,
    id: string
  ): Promise<void> {
    const rawOptions = ev.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map(String) : [];
    if (options.length === 0) {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    const permissionOptions: PermissionOption[] = options.map(
      (name, index) => ({
        kind: "allow_once",
        name,
        optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      })
    );

    const selected = await this.requestExtensionPermission(
      id,
      ev,
      permissionOptions
    );
    if (selected === null) {
      return;
    }

    const selectedOptionId =
      selected.outcome.outcome === "selected"
        ? selected.outcome.optionId
        : null;
    const index =
      selectedOptionId === null ? null : optionIndex(selectedOptionId);
    const value = index === null ? null : (options.at(index) ?? null);
    await this.proc.sendExtensionUiResponse(
      value === null ? { cancelled: true, id } : { id, value }
    );
  }

  private async handleExtensionConfirm(
    ev: PiRpcEvent,
    id: string
  ): Promise<void> {
    const selected = await this.requestExtensionPermission(
      id,
      ev,
      CONFIRM_PERMISSION_OPTIONS
    );
    if (selected === null) {
      return;
    }

    if (selected.outcome.outcome === "cancelled") {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return;
    }

    await this.proc.sendExtensionUiResponse({
      confirmed: selected.outcome.optionId === "yes",
      id,
    });
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        options,
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
      });
    } catch {
      await this.proc.sendExtensionUiResponse({ cancelled: true, id });
      return null;
    }
  }
}
