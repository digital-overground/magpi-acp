import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  Agent as ACPAgent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  AvailableCommand,
} from "@agentclientprotocol/sdk";

import { getPiCommand, shouldUseShellForPiCommand } from "../pi-rpc/command.js";
import { PiRpcProcess } from "../pi-rpc/process.js";
import type { PiSessionEntry, PiSessionTreeNode } from "../pi-rpc/process.js";
import {
  MAGPI_ACP_FORK_ENTRY_ID_META,
  MAGPI_ACP_FORK_MESSAGES_METHOD,
  MAGPI_ACP_FORK_PICKER_CAPABILITY,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
  MAGPI_ACP_TREE_METHOD,
  MAGPI_ACP_TREE_PICKER_CAPABILITY,
} from "../pi-rpc/tree-command.js";
import { maybeAuthRequiredError } from "./auth-required.js";
import { getAuthMethods } from "./auth.js";
import { toAvailableCommandsFromPiGetCommands } from "./pi-commands.js";
import { activeSessionMessages } from "./pi-session-tree.js";
import { listPiSessions, findPiSession } from "./pi-sessions.js";
import {
  getEnableSkillCommands,
  getQuietStartup,
  getRoles,
} from "./pi-settings.js";
import type { PiRole } from "./pi-settings.js";
import { SessionManager, toToolCallLocations } from "./session.js";
import type { MagPiAcpSession } from "./session.js";
import {
  loadSlashCommands,
  parseCommandArgs,
  toAvailableCommands,
} from "./slash-commands.js";
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool,
} from "./translate/bash.js";
import {
  normalizePiAssistantText,
  normalizePiMessageText,
} from "./translate/pi-messages.js";
import {
  todoResultToPlanEntries,
  toolResultToText,
} from "./translate/pi-tools.js";
import { promptToPiMessage } from "./translate/prompt.js";

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
interface AdvertisedModel {
  modelId: string;
  name: string;
  description?: string | null;
}
const MODEL_CONFIG_ID = "model";
const ROLE_CONFIG_ID = "role";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
const property = (value: unknown, key: string): unknown =>
  asRecord(value)?.[key];
const nestedProperty = (
  value: unknown,
  first: string,
  second: string
): unknown => property(property(value, first), second);
const errorMessage = (error: unknown): string => {
  const message = property(error, "message");
  return typeof message === "string" ? message : String(error);
};
const findTreeMessage = (
  tree: PiSessionTreeNode[],
  entryId: string
): PiSessionEntry | null => {
  for (const node of tree) {
    const role = node.entry.message?.role;
    if (
      node.entry.id === entryId &&
      node.entry.type === "message" &&
      (role === "user" || role === "assistant")
    ) {
      return node.entry;
    }
    const child = findTreeMessage(node.children, entryId);
    if (child) {
      return child;
    }
  }
  return null;
};
const builtinAvailableCommands = (): AvailableCommand[] => [
  {
    description: "Manually compact the session context",
    input: { hint: "optional custom instructions" },
    name: "compact",
  },
  {
    description: "Toggle automatic context compaction",
    input: { hint: "on|off|toggle" },
    name: "autocompact",
  },
  {
    description: "Export session to an HTML file in the session cwd",
    name: "export",
  },
  {
    description: "Show session stats (messages, tokens, cost, session file)",
    name: "session",
  },
  {
    description: "Set session display name",
    input: { hint: "<name>" },
    name: "name",
  },
  {
    description:
      "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
    input: { hint: "(no args to show) all | one-at-a-time" },
    name: "steering",
  },
  {
    description:
      "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
    input: { hint: "(no args to show) all | one-at-a-time" },
    name: "follow-up",
  },
  {
    description: "Show pi changelog",
    name: "changelog",
  },
];
const collectHistoricToolArgs = (messages: unknown[]): Map<string, unknown> => {
  const toolArgs = new Map<string, unknown>();
  for (const message of messages) {
    const record = asRecord(message);
    if (record?.role !== "assistant" || !Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      if (property(block, "type") === "toolCall") {
        const id = property(block, "id");
        if (typeof id === "string") {
          toolArgs.set(id, property(block, "arguments"));
        }
      }
    }
  }
  return toolArgs;
};

const historicTextUpdates = (
  message: Record<string, unknown>
): SessionUpdate[] => {
  if (message.role === "user") {
    const text = normalizePiMessageText(message.content);
    return text
      ? [
          {
            content: { text, type: "text" },
            sessionUpdate: "user_message_chunk",
          },
        ]
      : [];
  }
  if (message.role === "assistant") {
    const text = normalizePiAssistantText(message.content);
    return text
      ? [
          {
            content: { text, type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        ]
      : [];
  }
  return [];
};

const historicToolUpdates = (params: {
  cwd: string;
  message: Record<string, unknown>;
  restoredToolArgs: Map<string, unknown>;
}): {
  plan?: ReturnType<typeof todoResultToPlanEntries>;
  updates: SessionUpdate[];
} => {
  const { cwd, message, restoredToolArgs } = params;
  const toolName = String(message.toolName ?? "tool");
  const plan =
    toolName === "todo" ? todoResultToPlanEntries(message) : undefined;
  const toolCallId = String(message.toolCallId ?? crypto.randomUUID());
  const rawInput = message.args ?? restoredToolArgs.get(toolCallId) ?? null;
  const isError = Boolean(message.isError);
  if (isBashTool(toolName)) {
    const text = bashResultText(message);
    return {
      plan,
      updates: [
        {
          _meta: bashTerminalInfoMeta(toolCallId, cwd),
          content: bashTerminalContent(toolCallId),
          kind: "execute",
          sessionUpdate: "tool_call",
          status: "completed",
          title: bashCommand(rawInput) ?? bashCommand(message) ?? toolName,
          toolCallId,
        },
        {
          _meta: {
            ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
            ...bashTerminalExitMeta(toolCallId, bashExitCode(message, isError)),
          },
          sessionUpdate: "tool_call_update",
          status: isError ? "failed" : "completed",
          toolCallId,
        },
      ],
    };
  }

  const locations = toToolCallLocations(rawInput, cwd);
  const text = toolResultToText(message);
  let kind: "read" | "edit" | "other" = "other";
  if (toolName === "read") {
    kind = "read";
  } else if (toolName === "write" || toolName === "edit") {
    kind = "edit";
  }
  return {
    plan,
    updates: [
      {
        kind,
        rawInput,
        rawOutput: message,
        sessionUpdate: "tool_call",
        status: "completed",
        title: toolName,
        toolCallId,
        ...(locations ? { locations } : {}),
      },
      {
        content: text
          ? [{ content: { text, type: "text" }, type: "content" }]
          : null,
        rawOutput: message,
        sessionUpdate: "tool_call_update",
        status: isError ? "failed" : "completed",
        toolCallId,
      },
    ],
  };
};

const buildHistoricUpdates = (
  messages: unknown[],
  cwd: string
): SessionUpdate[] => {
  const updates: SessionUpdate[] = [];
  const restoredToolArgs = collectHistoricToolArgs(messages);
  let todoPlan: ReturnType<typeof todoResultToPlanEntries>;
  for (const item of messages) {
    const message = asRecord(item);
    if (!message) {
      continue;
    }
    updates.push(...historicTextUpdates(message));
    if (message.role === "toolResult") {
      const tool = historicToolUpdates({ cwd, message, restoredToolArgs });
      updates.push(...tool.updates);
      todoPlan = tool.plan ?? todoPlan;
    }
  }
  if (todoPlan) {
    updates.push({ entries: todoPlan, sessionUpdate: "plan" });
  }
  return updates;
};

const emitHistoricUpdates = async (
  conn: AgentSideConnection,
  sessionId: string,
  updates: SessionUpdate[],
  index = 0
): Promise<void> => {
  const update = updates[index];
  if (!update) {
    return;
  }
  await conn.sessionUpdate({ sessionId, update });
  await emitHistoricUpdates(conn, sessionId, updates, index + 1);
};

const findChangelog = (): string | null => {
  try {
    const whichCommand = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(whichCommand, ["pi"], { encoding: "utf-8" });
    const piPath = String(result.stdout ?? "")
      .split(/\r?\n/u)[0]
      ?.trim();
    if (piPath) {
      const packageRoot = path.dirname(path.dirname(realpathSync(piPath)));
      const changelogPath = path.join(packageRoot, "CHANGELOG.md");
      if (existsSync(changelogPath)) {
        return changelogPath;
      }
    }
  } catch {
    // Try the npm global package directory instead.
  }
  try {
    const result = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
    const root = String(result.stdout ?? "").trim();
    if (root) {
      const changelogPath = path.join(
        root,
        "@earendil-works",
        "pi-coding-agent",
        "CHANGELOG.md"
      );
      if (existsSync(changelogPath)) {
        return changelogPath;
      }
    }
  } catch {
    // The changelog is optional.
  }
  return null;
};

const mergeCommands = (
  a: AvailableCommand[],
  b: AvailableCommand[]
): AvailableCommand[] => {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = [];
  const seen = new Set<string>();
  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) {
      continue;
    }
    seen.add(c.name);
    out.push(c);
  }
  return out;
};
const isThinkingLevel = (value: string): value is ThinkingLevel =>
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
interface ThinkingState {
  availableModes: {
    description?: string | null;
    id: string;
    name: string;
  }[];
  currentModeId: string;
}
interface ModelState {
  availableModels: AdvertisedModel[];
  currentModelId: string;
}
const getThinkingState = async (
  proc: PiRpcProcess,
  pre?: {
    state?: unknown;
  }
): Promise<ThinkingState> => {
  let current: ThinkingLevel = "medium";
  let state = pre?.state;
  if (state === undefined) {
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
  }
  const thinkingLevel = property(state, "thinkingLevel");
  if (typeof thinkingLevel === "string" && isThinkingLevel(thinkingLevel)) {
    current = thinkingLevel;
  }
  const available: ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  return {
    availableModes: available.map((id) => ({
      description: null,
      id,
      name: `Thinking: ${id}`,
    })),
    currentModeId: current,
  };
};
const buildConfigOptions = (state: {
  models: ModelState | null;
  modes: ThinkingState;
  roles: PiRole[];
}): SessionConfigOption[] => {
  const configOptions: SessionConfigOption[] = [
    {
      category: "thought_level",
      currentValue: state.modes.currentModeId,
      description: "Set the reasoning effort for this session",
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thinking",
      options: state.modes.availableModes.map((mode) => ({
        description: mode.description ?? null,
        name: mode.name,
        value: mode.id,
      })),
      type: "select",
    },
  ];
  if (state.models?.availableModels.length) {
    configOptions.unshift({
      category: "model",
      currentValue: state.models.currentModelId,
      description: "Select the model for this session",
      id: MODEL_CONFIG_ID,
      name: "Model",
      options: state.models.availableModels.map((model) => ({
        description: model.description ?? null,
        name: model.name,
        value: model.modelId,
      })),
      type: "select",
    });
  }
  if (state.roles.length) {
    const currentRole = state.roles.find(
      (candidate) =>
        candidate.model === state.models?.currentModelId &&
        candidate.thinkingLevel === state.modes.currentModeId
    );
    configOptions.unshift({
      category: "mode",
      currentValue: currentRole?.id ?? "",
      description: "Switch model and thinking level together",
      id: ROLE_CONFIG_ID,
      name: "Role",
      options: state.roles.map((role) => ({
        description: `${role.model} · Thinking: ${role.thinkingLevel}`,
        name: role.id,
        value: role.id,
      })),
      type: "select",
    });
  }
  return configOptions;
};
const advertisedModel = (value: unknown): AdvertisedModel | null => {
  const provider = String(property(value, "provider") ?? "").trim();
  const id = String(property(value, "id") ?? "").trim();
  if (!provider || !id) {
    return null;
  }
  const name = String(property(value, "name") ?? id);
  return {
    description: null,
    modelId: `${provider}/${id}`,
    name: `${provider}/${name}`,
  };
};
const getModelState = async (
  proc: PiRpcProcess,
  pre?: {
    availableModels?: unknown;
    state?: unknown;
  }
): Promise<ModelState | null> => {
  let data = pre?.availableModels;
  if (data === undefined) {
    try {
      data = await proc.getAvailableModels();
    } catch {
      data = null;
    }
  }
  const rawModels = property(data, "models");
  const availableModels = (Array.isArray(rawModels) ? rawModels : [])
    .map(advertisedModel)
    .filter((model): model is AdvertisedModel => model !== null);
  let state = pre?.state;
  if (state === undefined) {
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
  }
  const model = property(state, "model");
  const provider = String(property(model, "provider") ?? "").trim();
  const id = String(property(model, "id") ?? "").trim();
  let currentModelId = provider && id ? `${provider}/${id}` : null;
  if (!availableModels.length && !currentModelId) {
    return null;
  }
  currentModelId ??= availableModels[0]?.modelId ?? "default";
  return { availableModels, currentModelId };
};
const getSessionConfiguration = async (
  proc: PiRpcProcess,
  pre?: {
    availableModels?: unknown;
    state?: unknown;
  }
): Promise<{
  configOptions: SessionConfigOption[];
  models: ModelState | null;
  modes: ThinkingState;
}> => {
  const [models, modes] = await Promise.all([
    getModelState(proc, pre),
    getThinkingState(proc, { state: pre?.state }),
  ]);
  return {
    configOptions: buildConfigOptions({ models, modes, roles: getRoles() }),
    models,
    modes,
  };
};
const emitConfigOptionsUpdate = async (
  conn: AgentSideConnection,
  sessionId: string,
  proc: PiRpcProcess
): Promise<SessionConfigOption[]> => {
  const { configOptions } = await getSessionConfiguration(proc);
  await conn.sessionUpdate({
    sessionId,
    update: { configOptions, sessionUpdate: "config_option_update" },
  });
  return configOptions;
};
const setSessionModel = async (
  proc: PiRpcProcess,
  requestedModelId: string
): Promise<void> => {
  let provider: string | null = null;
  let modelId: string | null = null;
  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }
  if (!provider) {
    const rawModels = property(await proc.getAvailableModels(), "models");
    const models: unknown[] = Array.isArray(rawModels) ? rawModels : [];
    const found = models.find(
      (candidate) => String(property(candidate, "id")) === modelId
    );
    if (found) {
      provider = String(property(found, "provider"));
      modelId = String(property(found, "id"));
    }
  }
  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }
  await proc.setModel(provider, modelId);
};
const normalizeGeneratedTitle = (output: string): string | null => {
  const line = output
    .trim()
    .split(/\r?\n/u)
    .find(Boolean)
    ?.replace(/^#+\s*/u, "")
    .replace(/^title:\s*/iu, "")
    .replaceAll(/^["'`]+|["'`.,:;!?]+$/gu, "")
    .trim();
  if (!line) {
    return null;
  }
  const words = line.split(/\s+/u).slice(0, 6);
  if (words.length === 1) {
    words.push("Discussion");
  }
  return words.join(" ");
};
export const generateThreadTitle = async (params: {
  cwd: string;
  model: string;
  user: string;
}): Promise<string | null> => {
  const prompt = [
    "Create a concise 2-6 word title for this conversation.",
    "Return only the title, without quotes or punctuation.",
    "",
    `User: ${params.user.slice(0, 4000)}`,
  ].join("\n");
  const command = getPiCommand(process.env.MAGPI_ACP_PI_COMMAND);
  try {
    const child = execFile(
      command,
      [
        "--print",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--model",
        params.model,
        "--thinking",
        "off",
        prompt,
      ],
      {
        cwd: params.cwd,
        shell: shouldUseShellForPiCommand(command),
        timeout: 15_000,
      }
    );
    const closed = once(child, "close");
    child.stdin?.end();

    let stdout = "";
    for await (const chunk of child.stdout ?? []) {
      stdout += String(chunk);
      if (stdout.length > 16_384) {
        child.kill();
        return null;
      }
    }

    const [code] = await closed;
    return code === 0 ? normalizeGeneratedTitle(stdout) : null;
  } catch {
    return null;
  }
};
const isSemver = (value: string): boolean =>
  /^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(value);
const compareSemver = (a: string, b: string): number => {
  const pa = a.split(/[.-]/u).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
};
const installedPiVersion = (): string => {
  const command = getPiCommand(process.env.MAGPI_ACP_PI_COMMAND);
  const result = spawnSync(command, ["--version"], {
    encoding: "utf-8",
    shell: shouldUseShellForPiCommand(command),
  });
  return (
    String(result.stdout ?? "").trim() || String(result.stderr ?? "").trim()
  ).replace(/^v/iu, "");
};
const buildUpdateNotice = (): string | null => {
  try {
    const installed = installedPiVersion();
    if (!installed || !isSemver(installed)) {
      return null;
    }
    const latestResult = spawnSync(
      "npm",
      ["view", "@earendil-works/pi-coding-agent", "version"],
      { encoding: "utf-8", timeout: 800 }
    );
    const latest = String(latestResult.stdout ?? "")
      .trim()
      .replace(/^v/iu, "");
    if (!latest || !isSemver(latest) || compareSemver(latest, installed) <= 0) {
      return null;
    }
    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
};
const readNearestPackageJson = (
  metaUrl: string
): {
  name?: string;
  version?: string;
} => {
  try {
    let directory = path.dirname(fileURLToPath(metaUrl));
    for (let depth = 0; depth < 6; depth += 1) {
      const packagePath = path.join(directory, "package.json");
      if (existsSync(packagePath)) {
        const json = asRecord(JSON.parse(readFileSync(packagePath, "utf-8")));
        return {
          name: typeof json?.name === "string" ? json.name : undefined,
          version: typeof json?.version === "string" ? json.version : undefined,
        };
      }
      directory = path.dirname(directory);
    }
  } catch {
    // Use fallback package metadata.
  }
  return { name: "magpi-acp", version: "0.0.0" };
};
const pkg = readNearestPackageJson(import.meta.url);

const buildStartupInfo = (options: { updateNotice: string | null }): string => {
  let piVersionText = "pi";
  try {
    const installed = installedPiVersion();
    if (installed) {
      piVersionText = `pi v${installed}`;
    }
  } catch {
    // The message still works when pi does not report a version.
  }
  const lines = [
    `MagPi v${pkg.version ?? "0.0.0"}`,
    piVersionText,
    "collect shiny things",
  ];
  if (options.updateNotice) {
    lines.push("", "---", options.updateNotice);
  }
  return `${lines.join("\n").trim()}\n`;
};

export class MagPiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection;
  private readonly sessions = new SessionManager();
  private readonly restoringSessions = new Map<
    string,
    Promise<MagPiAcpSession>
  >();
  private readonly autoTitlingSessions = new Set<string>();
  private generateTitle = generateThreadTitle;
  private supportsFormElicitation = false;
  dispose(): void {
    this.sessions.disposeAll();
  }
  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null;
  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn;
    void _config;
  }
  private cleanupFailedNewSession(sessionId: string, state?: unknown): void {
    this.sessions.close(sessionId);
    const candidateSessionFile = property(state, "sessionFile");
    const sessionFile =
      typeof candidateSessionFile === "string" && candidateSessionFile.trim()
        ? candidateSessionFile
        : findPiSession(sessionId)?.sessionFile;
    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) {
          unlinkSync(sessionFile);
        }
      } catch {
        // ignore cleanup failures; the auth/internal error is the primary result
      }
    }
  }
  private async restoreSession(
    sessionId: string,
    opts?: {
      mcpServers?: LoadSessionRequest["mcpServers"];
    }
  ): Promise<MagPiAcpSession> {
    const existing = this.sessions.maybeGet(sessionId);
    if (existing) {
      return existing;
    }
    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight) {
      return inFlight;
    }
    const restorePromise = (async () => {
      const stored = findPiSession(sessionId);
      if (!stored) {
        throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
      }
      const { cwd } = stored;
      let proc: PiRpcProcess;
      try {
        proc = await PiRpcProcess.spawn({
          cwd,
          piCommand: process.env.MAGPI_ACP_PI_COMMAND,
          sessionPath: stored.sessionFile,
        });
      } catch (error) {
        const details = asRecord(error);
        if (details?.name === "PiRpcSpawnError") {
          throw RequestError.internalError(
            { code: details.code },
            errorMessage(error)
          );
        }
        throw error;
      }
      const fileCommands = loadSlashCommands(cwd);
      const session = this.sessions.getOrCreate(sessionId, {
        conn: this.conn,
        cwd,
        fileCommands,
        mcpServers: opts?.mcpServers ?? [],
        proc,
        supportsFormElicitation: this.supportsFormElicitation,
      });
      this.lastSessionCwd = cwd;
      return session;
    })();
    this.restoringSessions.set(sessionId, restorePromise);
    try {
      return await restorePromise;
    } finally {
      this.restoringSessions.delete(sessionId);
    }
  }
  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1;
    const requested = params.protocolVersion;
    this.supportsFormElicitation =
      params.clientCapabilities?.elicitation?.form !== null;
    return Promise.resolve({
      agentCapabilities: {
        _meta: {
          [MAGPI_ACP_FORK_PICKER_CAPABILITY]: true,
          [MAGPI_ACP_TREE_PICKER_CAPABILITY]: true,
        },
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          audio: false,
          embeddedContext:
            process.env.MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT === "true",
          image: true,
        },
        sessionCapabilities: {
          fork: {},
          // **UNSTABLE** ACP capability for native session pickers.
          list: {},
        },
      },
      agentInfo: {
        name: "magpi-acp",
        title: "MagPi ACP",
        version: pkg.version ?? "0.0.0",
      },
      // Include launch metadata only when the client advertises integrated terminal authentication.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta:
          nestedProperty(
            params.clientCapabilities,
            "_meta",
            "terminal-auth"
          ) === true,
      }),
      protocolVersion:
        requested === supportedVersion ? requested : supportedVersion,
    });
  }
  async newSession(params: NewSessionRequest) {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        `cwd must be an absolute path: ${params.cwd}`
      );
    }
    this.lastSessionCwd = params.cwd;
    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      conn: this.conn,
      cwd: params.cwd,
      fileCommands,
      mcpServers: params.mcpServers,
      piCommand: process.env.MAGPI_ACP_PI_COMMAND,
      supportsFormElicitation: this.supportsFormElicitation,
    });
    // Fetch state + models once (parallel) to reduce startup latency.
    let state: unknown = null;
    let availableModels: unknown = null;
    let stateErr: unknown = null;
    let availableModelsErr: unknown = null;
    await Promise.all([
      session.proc
        .getState()
        .then((s) => {
          state = s;
        })
        .catch((error) => {
          stateErr = error;
          state = null;
        }),
      session.proc
        .getAvailableModels()
        .then((m) => {
          availableModels = m;
        })
        .catch((error) => {
          availableModelsErr = error;
          availableModels = null;
        }),
    ]);
    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);
    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }
    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.internalError(
        {},
        String((availableModelsErr as Error)?.message ?? availableModelsErr)
      );
    }
    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModels = property(availableModels, "models");
    const rawModelsCount = Array.isArray(rawModels) ? rawModels.length : 0;
    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    const { configOptions, models, modes } = await getSessionConfiguration(
      session.proc,
      {
        availableModels,
        state,
      }
    );
    const quietStartup = getQuietStartup(params.cwd);
    const updateNotice = buildUpdateNotice();
    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    let preludeText = buildStartupInfo({ updateNotice });
    if (quietStartup) {
      preludeText = updateNotice ? `${updateNotice}\n` : "";
    }
    if (preludeText) {
      session.setStartupInfo(preludeText);
      // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
      // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
      // It does NOT affect other client windows because they run in separate agent processes.
      //
      // (Tests sometimes stub out `this.sessions`, so guard the call.)
    }
    this.sessions.closeAllExcept(session.sessionId);
    const response = {
      _meta: {
        magPiAcp: {
          startupInfo: preludeText || null,
        },
      },
      configOptions,
      models,
      modes,
      sessionId: session.sessionId,
    };
    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    setTimeout(() => {
      if (preludeText) {
        session.sendStartupInfoIfPending();
      }
      void session.sendUsageUpdate();
    }, 0);
    // Advertise slash commands after session/new so clients recognize the session ID.
    setTimeout(() => {
      void (async () => {
        try {
          const { commands } = toAvailableCommandsFromPiGetCommands(
            await session.proc.getCommands(),
            {
              enableSkillCommands,
              includeExtensionCommands: false,
            }
          );
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              availableCommands: mergeCommands(
                commands,
                builtinAvailableCommands()
              ),
              sessionUpdate: "available_commands_update",
            },
          });
          return;
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            availableCommands: mergeCommands(
              toAvailableCommands(fileCommands),
              builtinAvailableCommands()
            ),
            sessionUpdate: "available_commands_update",
          },
        });
      })();
    }, 0);
    return response;
  }
  authenticate(params: AuthenticateRequest): void {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    void this.conn;
    void params;
  }
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId);
    const { message, images } = promptToPiMessage(params.prompt);
    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);
      const commandHandlers: Partial<
        Record<string, () => Promise<PromptResponse>>
      > = {
        autocompact: async () => {
          const mode = (args[0] ?? "toggle").toLowerCase();
          let enabled: boolean | null = null;
          if (
            mode === "on" ||
            mode === "true" ||
            mode === "enable" ||
            mode === "enabled"
          ) {
            enabled = true;
          } else if (
            mode === "off" ||
            mode === "false" ||
            mode === "disable" ||
            mode === "disabled"
          ) {
            enabled = false;
          }
          if (enabled === null) {
            // toggle: read current state and invert.
            const state = asRecord(await session.proc.getState());
            const current = Boolean(state?.autoCompactionEnabled);
            enabled = !current;
          }
          await session.proc.setAutoCompaction(enabled);
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: {
                text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        changelog: async () => {
          // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
          const changelogPath = findChangelog();
          if (!changelogPath) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: "Changelog not found (couldn't locate pi installation).",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          let text = "";
          try {
            text = readFileSync(changelogPath, "utf-8");
          } catch (error) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: `Failed to read changelog: ${errorMessage(error)}`,
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          // Keep it reasonably sized in chat.
          const maxChars = 20_000;
          if (text.length > maxChars) {
            text = `${text.slice(0, maxChars)}\n\n...(truncated)...`;
          }
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: { text, type: "text" },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        compact: async () => {
          const customInstructions = args.join(" ").trim() || undefined;
          const res = await session.proc.compact(customInstructions);
          const result = asRecord(res);
          const tokensBefore =
            typeof result?.tokensBefore === "number"
              ? result.tokensBefore
              : null;
          const summary =
            typeof result?.summary === "string" ? result.summary : null;
          const headerLines = [
            `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
            tokensBefore === null ? null : `Tokens before: ${tokensBefore}`,
          ].filter(Boolean);
          const text =
            headerLines.join("\n") + (summary ? `\n\n${summary}` : "");
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: { text, type: "text" },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        export: async () => {
          // For now we always export into the session cwd and do not accept a user-provided path.
          // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
          // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
          // (no id), which would otherwise hang our request. So we guard here.
          const state = asRecord(await session.proc.getState());
          const sessionFile =
            typeof state?.sessionFile === "string" ? state.sessionFile : null;
          const messageCount =
            typeof state?.messageCount === "number" ? state.messageCount : 0;
          if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: "Nothing to export yet (no session messages). Send a prompt first.",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          try {
            const raw = readFileSync(sessionFile, "utf-8");
            if (raw.trim().length === 0) {
              await this.conn.sessionUpdate({
                sessionId: session.sessionId,
                update: {
                  content: {
                    text: "Nothing to export yet (empty session file). Send a prompt first.",
                    type: "text",
                  },
                  sessionUpdate: "agent_message_chunk",
                },
              });
              return { stopReason: "end_turn" };
            }
          } catch {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: "Couldn't read session file for export. Try sending a prompt first.",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          const safeSessionId = session.sessionId.replaceAll(
            /[^a-zA-Z0-9_-]/gu,
            "_"
          );
          const outputPath = path.join(
            session.cwd,
            `pi-session-${safeSessionId}.html`
          );
          let resultPath = "";
          try {
            const result = await session.proc.exportHtml(outputPath);
            resultPath = result.path;
          } catch (error) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: `Export failed: ${errorMessage(error)}`,
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          if (!resultPath) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: "Export failed: no output path returned by pi.",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          const uri = `file://${resultPath}`;
          // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
          // assistant message, so this avoids the "link + duplicate plain text" look.
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: {
                text: "Session exported: ",
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: {
                mimeType: "text/html",
                name: `pi-session-${safeSessionId}.html`,
                title: "Session exported",
                type: "resource_link",
                uri,
              },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        "follow-up": async () => {
          const modeRaw = String(args[0] ?? "").toLowerCase();
          const state = asRecord(await session.proc.getState());
          const current = String(state?.followUpMode ?? "");
          // If no arg, just report current.
          if (!modeRaw) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: `Follow-up mode: ${current || "unknown"}`,
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: "Usage: /follow-up all | /follow-up one-at-a-time",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          await session.proc.setFollowUpMode(
            modeRaw as "all" | "one-at-a-time"
          );
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: {
                text: `Follow-up mode set to: ${modeRaw}`,
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        name: async () => {
          const name = args.join(" ").trim();
          if (!name) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: { text: "Usage: /name <name>", type: "text" },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          try {
            await session.proc.setSessionName(name);
          } catch (error) {
            const msg = errorMessage(error);
            const hint = /set_session_name/iu.test(msg)
              ? " This requires a newer pi version that supports `set_session_name` in RPC mode."
              : "";
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: `Failed to set session name: ${msg}${hint}`,
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "session_info_update",
              title: name,
              updatedAt: new Date().toISOString(),
            },
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: { text: `Session name set: ${name}`, type: "text" },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        session: async () => {
          const stats = asRecord(await session.proc.getSessionStats());
          const lines: string[] = [];
          if (stats?.sessionId) {
            lines.push(`Session: ${stats.sessionId}`);
          }
          if (stats?.sessionFile) {
            lines.push(`Session file: ${stats.sessionFile}`);
          }
          if (typeof stats?.totalMessages === "number") {
            lines.push(`Messages: ${stats.totalMessages}`);
          }
          if (typeof stats?.cost === "number") {
            lines.push(`Cost: ${stats.cost}`);
          }
          const t = asRecord(stats?.tokens);
          if (t && typeof t === "object") {
            const parts: string[] = [];
            if (typeof t.input === "number") {
              parts.push(`in ${t.input}`);
            }
            if (typeof t.output === "number") {
              parts.push(`out ${t.output}`);
            }
            if (typeof t.cacheRead === "number") {
              parts.push(`cache read ${t.cacheRead}`);
            }
            if (typeof t.cacheWrite === "number") {
              parts.push(`cache write ${t.cacheWrite}`);
            }
            if (typeof t.total === "number") {
              parts.push(`total ${t.total}`);
            }
            if (parts.length) {
              lines.push(`Tokens: ${parts.join(", ")}`);
            }
          }
          // Fallback if stats shape changes.
          const text = lines.length
            ? lines.join("\n")
            : `Session stats:\n${JSON.stringify(stats, null, 2)}`;
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: { text, type: "text" },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
        steering: async () => {
          const modeRaw = String(args[0] ?? "").toLowerCase();
          const state = asRecord(await session.proc.getState());
          const current = String(state?.steeringMode ?? "");
          // If no arg, just report current.
          if (!modeRaw) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: `Steering mode: ${current || "unknown"}`,
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                content: {
                  text: "Usage: /steering all | /steering one-at-a-time",
                  type: "text",
                },
                sessionUpdate: "agent_message_chunk",
              },
            });
            return { stopReason: "end_turn" };
          }
          await session.proc.setSteeringMode(
            modeRaw as "all" | "one-at-a-time"
          );
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              content: {
                text: `Steering mode set to: ${modeRaw}`,
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          });
          return { stopReason: "end_turn" };
        },
      };
      const commandHandler = commandHandlers[cmd];
      if (commandHandler) {
        return commandHandler();
      }
    }
    void this.autoTitleFirstMessage(session, message);
    const result = await session.prompt(message, images);
    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    let stopReason: StopReason;
    if (result === "error") {
      stopReason = session.wasCancelRequested() ? "cancelled" : "end_turn";
    } else {
      stopReason = result;
    }
    return { stopReason };
  }
  private async autoTitleFirstMessage(
    session: MagPiAcpSession,
    message: string
  ): Promise<void> {
    if (this.autoTitlingSessions.has(session.sessionId)) {
      return;
    }
    this.autoTitlingSessions.add(session.sessionId);
    try {
      const [rawState, rawData] = await Promise.all([
        session.proc.getState(),
        session.proc.getMessages(),
      ]);
      const state = asRecord(rawState);
      const data = asRecord(rawData);
      if (typeof state?.sessionName === "string" && state.sessionName.trim()) {
        return;
      }
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      if (messages.some((item) => property(item, "role") === "user")) {
        return;
      }
      const provider = String(
        nestedProperty(state, "model", "provider") ?? ""
      ).trim();
      const modelId = String(nestedProperty(state, "model", "id") ?? "").trim();
      if (!provider || !modelId) {
        return;
      }
      const title = await this.generateTitle({
        cwd: session.cwd,
        model: `${provider}/${modelId}`,
        user: message,
      });
      if (!title) {
        return;
      }
      const latestState = asRecord(await session.proc.getState());
      if (
        typeof latestState?.sessionName === "string" &&
        latestState.sessionName.trim()
      ) {
        return;
      }
      await session.proc.setSessionName(title);
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          title,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch {
      // Automatic titles are optional and must never affect the conversation.
    }
  }
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId);
    if (!session) {
      return;
    }
    await session.cancel();
  }
  async unstable_forkSession(
    params: ForkSessionRequest
  ): Promise<ForkSessionResponse> {
    const rawEntryId = params._meta?.[MAGPI_ACP_FORK_ENTRY_ID_META];
    if (
      rawEntryId !== undefined &&
      (typeof rawEntryId !== "string" || !rawEntryId.trim())
    ) {
      throw RequestError.invalidParams(
        "Fork entry ID must be a non-empty string."
      );
    }
    const entryId = typeof rawEntryId === "string" ? rawEntryId : undefined;
    const source = await this.restoreSession(params.sessionId);
    const state = (await source.proc.getState()) as {
      sessionFile?: unknown;
    };
    if (typeof state.sessionFile !== "string") {
      throw RequestError.internalError(
        {},
        "Pi did not return the source session file."
      );
    }
    const sessionId = await this.sessions.fork({
      cwd: params.cwd,
      entryId,
      piCommand: process.env.MAGPI_ACP_PI_COMMAND,
      sourceSessionFile: state.sessionFile,
    });
    return { sessionId };
  }
  async extMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (
      ![
        MAGPI_ACP_FORK_MESSAGES_METHOD,
        MAGPI_ACP_TREE_METHOD,
        MAGPI_ACP_NAVIGATE_TREE_METHOD,
      ].includes(method)
    ) {
      throw RequestError.methodNotFound(method);
    }
    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : null;
    if (!sessionId) {
      throw RequestError.invalidParams("sessionId is required.");
    }
    const session = await this.restoreSession(sessionId);
    if (method === MAGPI_ACP_FORK_MESSAGES_METHOD) {
      return { messages: await session.proc.getForkMessages() };
    }
    if (method === MAGPI_ACP_TREE_METHOD) {
      return await session.proc.getTree();
    }
    if (method === MAGPI_ACP_NAVIGATE_TREE_METHOD) {
      const entryId =
        typeof params.entryId === "string" && params.entryId.trim()
          ? params.entryId
          : null;
      if (!entryId) {
        throw RequestError.invalidParams("entryId is required.");
      }
      const before = await session.proc.getTree();
      const entry = findTreeMessage(before.tree, entryId);
      if (!entry) {
        throw RequestError.invalidParams(
          `Pi tree message not found: ${entryId}`
        );
      }
      const identity = (await session.proc.getState()) as {
        sessionFile?: unknown;
        sessionId?: unknown;
      };
      await session.proc.navigateTree(entryId);
      const [after, nextState] = await Promise.all([
        session.proc.getTree(),
        session.proc.getState(),
      ]);
      const nextIdentity = nextState as {
        sessionFile?: unknown;
        sessionId?: unknown;
      };
      if (
        nextIdentity.sessionFile !== identity.sessionFile ||
        nextIdentity.sessionId !== identity.sessionId
      ) {
        throw RequestError.internalError(
          {},
          "Pi tree navigation changed the session identity."
        );
      }
      const role = entry.message?.role;
      return {
        draft:
          role === "user"
            ? normalizePiMessageText(entry.message?.content)
            : null,
        leafId: after.leafId,
      };
    }
    throw RequestError.methodNotFound(method);
  }
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // Filter by cwd when provided; otherwise use the latest session cwd for a project-scoped picker.
    const all = listPiSessions();
    const requestedCwd = property(params, "cwd");
    const effectiveCwd =
      typeof requestedCwd === "string" ? requestedCwd : this.lastSessionCwd;
    const filtered = effectiveCwd
      ? all.filter((s) => s.cwd === effectiveCwd)
      : all;
    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Math.trunc(Number(params.cursor)) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const sessions: SessionInfo[] = page.map((s) => ({
      cwd: s.cwd,
      sessionId: s.sessionId,
      title: s.title,
      updatedAt: s.updatedAt,
      ...(s.preview && s.previewRole
        ? {
            _meta: {
              magPiAcp: { preview: s.preview, previewRole: s.previewRole },
            },
          }
        : {}),
    }));
    const nextCursor =
      start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;
    return Promise.resolve({ _meta: {}, nextCursor, sessions });
  }
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        `cwd must be an absolute path: ${params.cwd}`
      );
    }
    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    this.sessions.close(params.sessionId);
    const stored = findPiSession(params.sessionId);
    if (!stored) {
      throw RequestError.invalidParams(
        `Unknown sessionId: ${params.sessionId}`
      );
    }
    this.lastSessionCwd = stored.cwd;
    const enableSkillCommands = getEnableSkillCommands(stored.cwd);
    const session = await this.restoreSession(params.sessionId, {
      mcpServers: params.mcpServers,
    });
    const { proc } = session;
    const fileCommands = loadSlashCommands(stored.cwd);
    // Keep only one live Pi subprocess within an ACP connection.
    this.sessions.closeAllExcept(session.sessionId);
    // Replay the full active branch; Pi's RPC context omits messages removed by compaction.
    const activeMessages = activeSessionMessages(stored.sessionFile);
    const data = activeMessages.length
      ? null
      : asRecord(await proc.getMessages());
    let messages: unknown[] = [];
    if (activeMessages.length) {
      messages = activeMessages.map(({ message }) => message);
    } else {
      const { messages: storedMessages } = data ?? {};
      if (Array.isArray(storedMessages)) {
        messages = storedMessages;
      }
    }
    await emitHistoricUpdates(
      this.conn,
      session.sessionId,
      buildHistoricUpdates(messages, session.cwd)
    );
    const { configOptions, models, modes } =
      await getSessionConfiguration(proc);
    const response = {
      _meta: {
        magPiAcp: {
          startupInfo: null,
        },
      },
      configOptions,
      models,
      modes,
    };
    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = await proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false,
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              availableCommands: mergeCommands(
                commands,
                builtinAvailableCommands()
              ),
              sessionUpdate: "available_commands_update",
            },
          });
          return;
        } catch {
          // fall back
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            availableCommands: mergeCommands(
              toAvailableCommands(fileCommands),
              builtinAvailableCommands()
            ),
            sessionUpdate: "available_commands_update",
          },
        });
      })();
    }, 0);
    return response;
  }
  async unstable_setSessionModel(params: {
    sessionId: string;
    modelId: string;
  }): Promise<void> {
    const session = await this.restoreSession(params.sessionId);
    await setSessionModel(session.proc, params.modelId);
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
  }
  async setSessionMode(
    params: SetSessionModeRequest
  ): Promise<SetSessionModeResponse> {
    const session = await this.restoreSession(params.sessionId);
    const mode = String(params.modeId);
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`);
    }
    await session.proc.setThinkingLevel(mode);
    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        currentModeId: mode,
        sessionUpdate: "current_mode_update",
      },
    });
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    return {};
  }
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    const session = await this.restoreSession(params.sessionId);
    const configId = String(params.configId);
    if (typeof params.value !== "string") {
      throw RequestError.invalidParams(
        `Expected string value for config option: ${configId}`
      );
    }
    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value);
    } else if (configId === ROLE_CONFIG_ID) {
      const role = getRoles().find(
        (candidate) => candidate.id === params.value
      );
      if (!role) {
        throw RequestError.invalidParams(`Unknown role: ${params.value}`);
      }
      await setSessionModel(session.proc, role.model);
      await session.proc.setThinkingLevel(role.thinkingLevel);
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          currentModeId: role.thinkingLevel,
          sessionUpdate: "current_mode_update",
        },
      });
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(
          `Unknown thinking level: ${params.value}`
        );
      }
      await session.proc.setThinkingLevel(params.value);
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          currentModeId: params.value,
          sessionUpdate: "current_mode_update",
        },
      });
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`);
    }
    const configOptions = await emitConfigOptionsUpdate(
      this.conn,
      session.sessionId,
      session.proc
    );
    return { configOptions };
  }
}
