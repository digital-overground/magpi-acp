import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getPiCommand, shouldUseShellForPiCommand } from "./command.js";
import { PiRpcSpawnError } from "./spawn-error.js";
import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from "./tree-command.js";

export { PiRpcSpawnError } from "./spawn-error.js";

const ESC = String.fromCodePoint(0x1b);
const CSI = String.fromCodePoint(0x9b);

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "gu"
);

const stripAnsi = (s: string): string =>
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  s.replace(ANSI_ESCAPE_REGEX, "");

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

type PiRpcCommand =
  | { type: "prompt"; id?: string; message: string; images?: unknown[] }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  // Model
  | { type: "get_available_models"; id?: string }
  | { type: "set_model"; id?: string; provider: string; modelId: string }
  // Thinking
  | {
      type: "set_thinking_level";
      id?: string;
      level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    }
  // Modes
  | { type: "set_follow_up_mode"; id?: string; mode: "all" | "one-at-a-time" }
  | { type: "set_steering_mode"; id?: string; mode: "all" | "one-at-a-time" }
  // Compaction
  | { type: "compact"; id?: string; customInstructions?: string }
  | { type: "set_auto_compaction"; id?: string; enabled: boolean }
  // Session
  | { type: "get_session_stats"; id?: string }
  | { type: "set_session_name"; id?: string; name: string }
  | { type: "export_html"; id?: string; outputPath?: string }
  | { type: "switch_session"; id?: string; sessionPath: string }
  | { type: "fork"; id?: string; entryId: string }
  | { type: "clone"; id?: string }
  | { type: "get_fork_messages"; id?: string }
  | { type: "get_tree"; id?: string }
  // Messages
  | { type: "get_messages"; id?: string }
  // Commands
  | { type: "get_commands"; id?: string };

interface PiRpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingResponse {
  events: EventTarget;
  value?: { response?: PiRpcResponse; error?: unknown };
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type PiRpcEvent = Record<string, unknown>;
export interface PiForkMessage {
  entryId: string;
  text: string;
}
export interface PiSessionEntry {
  id: string;
  type: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}
export interface PiSessionTreeNode {
  entry: PiSessionEntry;
  children: PiSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

interface SpawnParams {
  cwd: string;
  /** Optional override for `pi` executable name/path */
  piCommand?: string;
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string;
}

const treeExtensionPath = (): string => {
  const bundledPath = fileURLToPath(
    new URL("pi-tree-extension.js", import.meta.url)
  );
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  const sourcePath = fileURLToPath(
    new URL("../pi-extension/tree.ts", import.meta.url)
  );
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  throw new PiRpcSpawnError(
    "Could not locate the bundled magpi-acp tree extension."
  );
};

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly writeToStdin: (line: string) => Promise<void>;
  private eventHandlers: ((ev: PiRpcEvent) => void)[] = [];
  private readonly preludeLines: string[] = [];

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.writeToStdin = promisify(child.stdin.write.bind(child.stdin)) as (
      line: string
    ) => Promise<void>;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(line) as unknown;
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd();
        if (cleaned) {
          this.preludeLines.push(cleaned);
        }
        return;
      }

      const record = asRecord(msg);
      if (record?.type === "response") {
        const id = typeof record.id === "string" ? record.id : undefined;
        if (id) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.value = {
              response: record as unknown as PiRpcResponse,
            };
            pending.events.dispatchEvent(new Event("response"));
            return;
          }
        }
      }

      for (const h of this.eventHandlers) {
        h(record ?? {});
      }
    });

    child.on("exit", (code, signal) => {
      const error = new Error(
        `pi process exited (code=${code}, signal=${signal})`
      );
      this.rejectPending(error);
    });

    child.on("error", (error) => {
      this.rejectPending(error);
    });
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand);

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = [
      "--mode",
      "rpc",
      "--no-themes",
      "--extension",
      treeExtensionPath(),
    ];
    if (params.sessionPath) {
      args.push("--session", params.sessionPath);
    }

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd),
      stdio: "pipe",
    });

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await once(child, "spawn");
    } catch (error: unknown) {
      const errorRecord = asRecord(error);
      const code =
        typeof errorRecord?.code === "string" ? errorRecord.code : undefined;
      if (code === "ENOENT") {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { cause: error, code }
        );
      }

      if (code === "EACCES") {
        throw new PiRpcSpawnError(
          `Could not start pi: permission denied (command: ${cmd}).`,
          { cause: error, code }
        );
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, {
        cause: error,
        code,
      });
    }

    child.stderr.on("data", () => {
      // leave stderr untouched; ACP clients may capture it.
    });

    const proc = new PiRpcProcess(child);

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = asRecord(await proc.getState());
      const sessionFile =
        typeof state?.sessionFile === "string" ? state.sessionFile : null;
      if (sessionFile) {
        mkdirSync(path.dirname(sessionFile), { recursive: true });
      }
    } catch {
      // ignore for now
    }

    return proc;
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  dispose(signal: NodeJS.Signals | number = "SIGTERM"): void {
    if (this.child.killed) {
      return;
    }
    try {
      this.child.kill(signal);
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0);
    return lines;
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ images, message, type: "prompt" });
    if (!res.success) {
      throw new Error(
        `pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async fork(entryId: string): Promise<void> {
    const res = await this.request({ entryId, type: "fork" });
    if (!res.success) {
      throw new Error(
        `pi fork failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    if ((res.data as { cancelled?: unknown } | undefined)?.cancelled === true) {
      throw new Error("Pi cancelled the fork.");
    }
  }

  async clone(): Promise<void> {
    const res = await this.request({ type: "clone" });
    if (!res.success) {
      throw new Error(
        `pi clone failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    if ((res.data as { cancelled?: unknown } | undefined)?.cancelled === true) {
      throw new Error("Pi cancelled the clone.");
    }
  }

  async getForkMessages(): Promise<PiForkMessage[]> {
    const res = await this.request({ type: "get_fork_messages" });
    if (!res.success) {
      throw new Error(
        `pi get_fork_messages failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    const messages = (res.data as { messages?: unknown } | undefined)?.messages;
    return Array.isArray(messages) ? (messages as PiForkMessage[]) : [];
  }

  async getTree(): Promise<{
    tree: PiSessionTreeNode[];
    leafId: string | null;
  }> {
    const res = await this.request({ type: "get_tree" });
    if (!res.success) {
      throw new Error(
        `pi get_tree failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data as { tree: PiSessionTreeNode[]; leafId: string | null };
  }

  async navigateTree(entryId: string): Promise<void> {
    let failure: Error | undefined;
    const settled = new EventTarget();
    const unsubscribe = this.onEvent((event) => {
      if (event.type === "extension_error") {
        failure = new Error(
          String(event.error ?? "Pi tree navigation extension failed.")
        );
      }
      if (event.type === "agent_settled") {
        settled.dispatchEvent(new Event("settled"));
      }
    });

    const settledPromise = once(settled, "settled");
    try {
      await this.prompt(`/${MAGPI_ACP_NAVIGATE_TREE_COMMAND} ${entryId}`);
      await settledPromise;
      if (failure) {
        throw failure;
      }
    } finally {
      unsubscribe();
    }
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: "abort" });
    if (!res.success) {
      throw new Error(
        `pi abort failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: "get_state" });
    if (!res.success) {
      throw new Error(
        `pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: "get_available_models" });
    if (!res.success) {
      throw new Error(
        `pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ modelId, provider, type: "set_model" });
    if (!res.success) {
      throw new Error(
        `pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async setThinkingLevel(
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  ): Promise<void> {
    const res = await this.request({ level, type: "set_thinking_level" });
    if (!res.success) {
      throw new Error(
        `pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    const res = await this.request({ mode, type: "set_follow_up_mode" });
    if (!res.success) {
      throw new Error(
        `pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    const res = await this.request({ mode, type: "set_steering_mode" });
    if (!res.success) {
      throw new Error(
        `pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ customInstructions, type: "compact" });
    if (!res.success) {
      throw new Error(
        `pi compact failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ enabled, type: "set_auto_compaction" });
    if (!res.success) {
      throw new Error(
        `pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: "get_session_stats" });
    if (!res.success) {
      throw new Error(
        `pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ name, type: "set_session_name" });
    if (!res.success) {
      throw new Error(
        `pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ outputPath, type: "export_html" });
    if (!res.success) {
      throw new Error(
        `pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    const data = asRecord(res.data);
    return { path: String(data?.path ?? "") };
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ sessionPath, type: "switch_session" });
    if (!res.success) {
      throw new Error(
        `pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: "get_messages" });
    if (!res.success) {
      throw new Error(
        `pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: "get_commands" });
    if (!res.success) {
      throw new Error(
        `pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`
      );
    }
    return res.data;
  }

  async sendExtensionUiResponse(
    response: PiExtensionUiResponse
  ): Promise<void> {
    await this.writeLine(
      `${JSON.stringify({ type: "extension_ui_response", ...response })}\n`
    );
  }

  private rejectPending(error: unknown): void {
    for (const [, pending] of this.pending) {
      pending.value = { error };
      pending.events.dispatchEvent(new Event("response"));
    }
    this.pending.clear();
  }

  private async request(cmd: PiRpcCommand): Promise<PiRpcResponse> {
    const id = crypto.randomUUID();
    const line = `${JSON.stringify({ ...cmd, id })}\n`;
    const pending: PendingResponse = { events: new EventTarget() };
    this.pending.set(id, pending);
    const responsePromise = once(pending.events, "response");

    try {
      await this.writeLine(line);
      await responsePromise;
      if (pending.value?.error !== undefined) {
        throw pending.value.error;
      }
      if (pending.value?.response === undefined) {
        throw new Error("Pi returned an invalid RPC response.");
      }
      return pending.value.response;
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }

  private async writeLine(line: string): Promise<void> {
    await this.writeToStdin(line);
  }
}
