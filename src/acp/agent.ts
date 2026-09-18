import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RequestError } from "@agentclientprotocol/sdk";
import type {
  Agent as ACPAgent,
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
import { asRecord, errorMessage, stringValue } from "../unknown.js";
import { maybeAuthRequiredError } from "./auth-required.js";
import { getAuthMethods } from "./auth.js";
import type { AgentClientConnection } from "./connection.js";
import { toAvailableCommandsFromPiGetCommands } from "./pi-commands.js";
import { activeSessionMessages } from "./pi-session-tree.js";
import { listPiSessions, findPiSession } from "./pi-sessions.js";
import { getQuietStartup, getRoles } from "./pi-settings.js";
import type { PiRole } from "./pi-settings.js";
import { SessionManager, toToolCallLocations } from "./session.js";
import type { MagPiAcpSession } from "./session.js";
import { parseCommandArgs } from "./slash-commands.js";
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
  description?: string | null;
  modelId: string;
  name: string;
}

interface SessionConfiguration {
  configOptions: SessionConfigOption[];
  models: {
    availableModels: AdvertisedModel[];
    currentModelId: string;
  } | null;
  modes: {
    availableModes: {
      description?: string | null;
      id: string;
      name: string;
    }[];
    currentModeId: string;
  };
}

type UnknownRecord = Record<string, unknown>;
interface PrefetchedConfiguration {
  availableModels?: unknown;
  state?: unknown;
}

const MODEL_CONFIG_ID = "model";
const ROLE_CONFIG_ID = "role";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const isThinkingLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

const findTreeMessage = (
  tree: PiSessionTreeNode[],
  entryId: string
): PiSessionEntry | null => {
  for (const node of tree) {
    const messageRole = node.entry.message?.role;
    if (
      node.entry.id === entryId &&
      node.entry.type === "message" &&
      (messageRole === "user" || messageRole === "assistant")
    ) {
      return node.entry;
    }
    const child = findTreeMessage(node.children, entryId);
    if (child !== null) {
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
  { description: "Show pi changelog", name: "changelog" },
];

const mergeCommands = (
  first: AvailableCommand[],
  second: AvailableCommand[]
): AvailableCommand[] => {
  const commands: AvailableCommand[] = [];
  const seen = new Set<string>();
  for (const command of [...first, ...second]) {
    if (!seen.has(command.name)) {
      seen.add(command.name);
      commands.push(command);
    }
  }
  return commands;
};

const readNearestPackageJson = (
  metaUrl: string
): { name?: string; version?: string } => {
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
    // Use fallback package information.
  }
  return { name: "magpi-acp", version: "0.0.0" };
};

const pkg = readNearestPackageJson(import.meta.url);

const buildConfigOptions = (state: {
  models: SessionConfiguration["models"];
  modes: SessionConfiguration["modes"];
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

  const { models } = state;
  if (models !== null && models.availableModels.length > 0) {
    configOptions.unshift({
      category: "model",
      currentValue: models.currentModelId,
      description: "Select the model for this session",
      id: MODEL_CONFIG_ID,
      name: "Model",
      options: models.availableModels.map((model) => ({
        description: model.description ?? null,
        name: model.name,
        value: model.modelId,
      })),
      type: "select",
    });
  }

  if (state.roles.length > 0) {
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

const getThinkingState = async (
  proc: PiRpcProcess,
  pre?: Pick<PrefetchedConfiguration, "state">
): Promise<SessionConfiguration["modes"]> => {
  let current: ThinkingLevel = "medium";
  let stateValue = pre?.state;
  if (stateValue === undefined) {
    try {
      stateValue = await proc.getState();
    } catch {
      stateValue = null;
    }
  }
  const thinkingLevel = asRecord(stateValue)?.thinkingLevel;
  if (typeof thinkingLevel === "string" && isThinkingLevel(thinkingLevel)) {
    current = thinkingLevel;
  }
  return {
    availableModes: THINKING_LEVELS.map((id) => ({
      description: null,
      id,
      name: `Thinking: ${id}`,
    })),
    currentModeId: current,
  };
};

const parseAdvertisedModel = (value: unknown): AdvertisedModel | null => {
  const model = asRecord(value);
  const provider = stringValue(model?.provider).trim();
  const id = stringValue(model?.id).trim();
  if (provider.length === 0 || id.length === 0) {
    return null;
  }
  const name = stringValue(model?.name, id);
  return {
    description: null,
    modelId: `${provider}/${id}`,
    name: `${provider}/${name}`,
  };
};

const resolveRpcValue = async (
  prefetched: unknown,
  request: () => Promise<unknown>
): Promise<unknown> => {
  if (prefetched !== undefined) {
    return prefetched;
  }
  try {
    return await request();
  } catch {
    return null;
  }
};

const getModelState = async (
  proc: PiRpcProcess,
  pre?: PrefetchedConfiguration
): Promise<SessionConfiguration["models"]> => {
  const availableValue = await resolveRpcValue(
    pre?.availableModels,
    async () => await proc.getAvailableModels()
  );
  const rawModels = asRecord(availableValue)?.models;
  const availableModels = (Array.isArray(rawModels) ? rawModels : [])
    .map(parseAdvertisedModel)
    .filter((model): model is AdvertisedModel => model !== null);

  const stateValue = await resolveRpcValue(
    pre?.state,
    async () => await proc.getState()
  );
  const model = asRecord(asRecord(stateValue)?.model);
  const provider = stringValue(model?.provider).trim();
  const id = stringValue(model?.id).trim();
  let currentModelId =
    provider.length > 0 && id.length > 0 ? `${provider}/${id}` : null;

  if (availableModels.length === 0 && currentModelId === null) {
    return null;
  }
  currentModelId ??= availableModels[0]?.modelId ?? "default";
  return { availableModels, currentModelId };
};

const getSessionConfiguration = async (
  proc: PiRpcProcess,
  pre?: PrefetchedConfiguration
): Promise<SessionConfiguration> => {
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
  conn: AgentClientConnection,
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
  let modelId: string | null = requestedModelId;
  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider ?? null;
    modelId = rest.join("/");
  }

  if (provider === null || provider.length === 0) {
    const rawModels = asRecord(await proc.getAvailableModels())?.models;
    const models = Array.isArray(rawModels) ? rawModels : [];
    const found = models
      .map(asRecord)
      .find((model) => stringValue(model?.id) === modelId);
    if (found !== undefined) {
      provider = stringValue(found.provider);
      modelId = stringValue(found.id);
    }
  }
  if (
    provider === null ||
    provider.length === 0 ||
    modelId === null ||
    modelId.length === 0
  ) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }
  await proc.setModel(provider, modelId);
};

const isSemver = (version: string): boolean =>
  /^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(version);

const compareSemver = (first: string, second: string): number => {
  const firstParts = first.split(/[.-]/u).slice(0, 3).map(Number);
  const secondParts = second.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (firstParts[index] ?? 0) - (secondParts[index] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
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
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  return (stdout.length > 0 ? stdout : stderr).replace(/^v/iu, "");
};

const buildUpdateNotice = (): string | null => {
  try {
    const installed = installedPiVersion();
    if (installed.length === 0 || !isSemver(installed)) {
      return null;
    }
    const latestResult = spawnSync(
      "npm",
      ["view", "@earendil-works/pi-coding-agent", "version"],
      { encoding: "utf-8", timeout: 800 }
    );
    const latest = (latestResult.stdout ?? "").trim().replace(/^v/iu, "");
    if (
      latest.length === 0 ||
      !isSemver(latest) ||
      compareSemver(latest, installed) <= 0
    ) {
      return null;
    }
    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
};

const buildStartupInfo = (options: { updateNotice: string | null }): string => {
  let piVersionText = "pi";
  try {
    const installed = installedPiVersion();
    if (installed.length > 0) {
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
  if (options.updateNotice !== null && options.updateNotice.length > 0) {
    lines.push("", "---", options.updateNotice);
  }
  return `${lines.join("\n").trim()}\n`;
};

const findChangelog = (): string | null => {
  try {
    const whichCommand = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(whichCommand, ["pi"], { encoding: "utf-8" });
    const piPath = (result.stdout ?? "").split(/\r?\n/u)[0]?.trim();
    if (piPath !== undefined && piPath.length > 0) {
      const packageRoot = path.dirname(path.dirname(realpathSync(piPath)));
      const changelogPath = path.join(packageRoot, "CHANGELOG.md");
      if (existsSync(changelogPath)) {
        return changelogPath;
      }
    }
  } catch {
    // Try the npm global module location.
  }
  try {
    const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
    const root = (npmRoot.stdout ?? "").trim();
    if (root.length > 0) {
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
    // The changelog cannot be located.
  }
  return null;
};

const sendAgentText = async (
  conn: AgentClientConnection,
  sessionId: string,
  text: string
): Promise<void> => {
  await conn.sessionUpdate({
    sessionId,
    update: {
      content: { text, type: "text" },
      sessionUpdate: "agent_message_chunk",
    },
  });
};

const handleCompactCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  args: string[]
): Promise<void> => {
  const customText = args.join(" ").trim();
  const customInstructions = customText.length > 0 ? customText : undefined;
  const result = asRecord(await session.proc.compact(customInstructions));
  const tokensBefore =
    typeof result?.tokensBefore === "number" ? result.tokensBefore : null;
  const summary = typeof result?.summary === "string" ? result.summary : null;
  const headerLines = [
    `Compaction completed.${customInstructions === undefined ? "" : " (custom instructions applied)"}`,
    tokensBefore === null ? null : `Tokens before: ${tokensBefore}`,
  ].filter((line): line is string => line !== null);
  const text = `${headerLines.join("\n")}${summary === null || summary.length === 0 ? "" : `\n\n${summary}`}`;
  await sendAgentText(conn, session.sessionId, text);
};

const tokenStatsParts = (value: unknown): string[] => {
  const tokens = asRecord(value);
  if (tokens === undefined) {
    return [];
  }
  const fields = [
    ["input", "in"],
    ["output", "out"],
    ["cacheRead", "cache read"],
    ["cacheWrite", "cache write"],
    ["total", "total"],
  ] as const;
  return fields.flatMap(([field, label]) =>
    typeof tokens[field] === "number" ? [`${label} ${tokens[field]}`] : []
  );
};

const handleSessionCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession
): Promise<void> => {
  const rawStats = await session.proc.getSessionStats();
  const stats = asRecord(rawStats);
  const lines: string[] = [];
  if (typeof stats?.sessionId === "string" && stats.sessionId.length > 0) {
    lines.push(`Session: ${stats.sessionId}`);
  }
  if (typeof stats?.sessionFile === "string" && stats.sessionFile.length > 0) {
    lines.push(`Session file: ${stats.sessionFile}`);
  }
  if (typeof stats?.totalMessages === "number") {
    lines.push(`Messages: ${stats.totalMessages}`);
  }
  if (typeof stats?.cost === "number") {
    lines.push(`Cost: ${stats.cost}`);
  }
  const tokenParts = tokenStatsParts(stats?.tokens);
  if (tokenParts.length > 0) {
    lines.push(`Tokens: ${tokenParts.join(", ")}`);
  }
  const text =
    lines.length > 0
      ? lines.join("\n")
      : `Session stats:\n${JSON.stringify(rawStats, null, 2)}`;
  await sendAgentText(conn, session.sessionId, text);
};

const handleNameCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  args: string[]
): Promise<void> => {
  const name = args.join(" ").trim();
  if (name.length === 0) {
    await sendAgentText(conn, session.sessionId, "Usage: /name <name>");
    return;
  }
  try {
    await session.proc.setSessionName(name);
  } catch (error: unknown) {
    const message = errorMessage(error);
    const hint = /set_session_name/iu.test(message)
      ? " This requires a newer pi version that supports `set_session_name` in RPC mode."
      : "";
    await sendAgentText(
      conn,
      session.sessionId,
      `Failed to set session name: ${message}${hint}`
    );
    return;
  }
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      sessionUpdate: "session_info_update",
      title: name,
      updatedAt: new Date().toISOString(),
    },
  });
  await sendAgentText(conn, session.sessionId, `Session name set: ${name}`);
};

const modeCommandDetails = (
  command: "follow-up" | "steering"
): {
  label: string;
  stateField: "followUpMode" | "steeringMode";
  usage: string;
} =>
  command === "steering"
    ? {
        label: "Steering",
        stateField: "steeringMode",
        usage: "Usage: /steering all | /steering one-at-a-time",
      }
    : {
        label: "Follow-up",
        stateField: "followUpMode",
        usage: "Usage: /follow-up all | /follow-up one-at-a-time",
      };

const handleModeCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  args: string[],
  command: "follow-up" | "steering"
): Promise<void> => {
  const mode = (args[0] ?? "").toLowerCase();
  const details = modeCommandDetails(command);
  const state = asRecord(await session.proc.getState());
  const current = stringValue(state?.[details.stateField]);
  if (mode.length === 0) {
    await sendAgentText(
      conn,
      session.sessionId,
      `${details.label} mode: ${current.length > 0 ? current : "unknown"}`
    );
    return;
  }
  if (mode !== "all" && mode !== "one-at-a-time") {
    await sendAgentText(conn, session.sessionId, details.usage);
    return;
  }
  await (command === "steering"
    ? session.proc.setSteeringMode(mode)
    : session.proc.setFollowUpMode(mode));
  await sendAgentText(
    conn,
    session.sessionId,
    `${details.label} mode set to: ${mode}`
  );
};

const handleChangelogCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession
): Promise<void> => {
  const changelogPath = findChangelog();
  if (changelogPath === null || changelogPath.length === 0) {
    await sendAgentText(
      conn,
      session.sessionId,
      "Changelog not found (couldn't locate pi installation)."
    );
    return;
  }
  let text: string;
  try {
    text = readFileSync(changelogPath, "utf-8");
  } catch (error: unknown) {
    await sendAgentText(
      conn,
      session.sessionId,
      `Failed to read changelog: ${errorMessage(error)}`
    );
    return;
  }
  const maxCharacters = 20_000;
  if (text.length > maxCharacters) {
    text = `${text.slice(0, maxCharacters)}\n\n...(truncated)...`;
  }
  await sendAgentText(conn, session.sessionId, text);
};

const sessionFileForExport = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession
): Promise<string | null> => {
  const state = asRecord(await session.proc.getState());
  const sessionFile =
    typeof state?.sessionFile === "string" ? state.sessionFile : null;
  const messageCount =
    typeof state?.messageCount === "number" ? state.messageCount : 0;
  if (
    sessionFile === null ||
    sessionFile.length === 0 ||
    messageCount === 0 ||
    !existsSync(sessionFile)
  ) {
    await sendAgentText(
      conn,
      session.sessionId,
      "Nothing to export yet (no session messages). Send a prompt first."
    );
    return null;
  }
  try {
    if (readFileSync(sessionFile, "utf-8").trim().length === 0) {
      await sendAgentText(
        conn,
        session.sessionId,
        "Nothing to export yet (empty session file). Send a prompt first."
      );
      return null;
    }
  } catch {
    await sendAgentText(
      conn,
      session.sessionId,
      "Couldn't read session file for export. Try sending a prompt first."
    );
    return null;
  }
  return sessionFile;
};

const handleExportCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession
): Promise<void> => {
  if ((await sessionFileForExport(conn, session)) === null) {
    return;
  }
  const safeSessionId = session.sessionId.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
  const outputPath = path.join(session.cwd, `pi-session-${safeSessionId}.html`);
  let resultPath: string;
  try {
    const result = await session.proc.exportHtml(outputPath);
    resultPath = result.path;
  } catch (error: unknown) {
    await sendAgentText(
      conn,
      session.sessionId,
      `Export failed: ${errorMessage(error)}`
    );
    return;
  }
  if (resultPath.length === 0) {
    await sendAgentText(
      conn,
      session.sessionId,
      "Export failed: no output path returned by pi."
    );
    return;
  }
  await sendAgentText(conn, session.sessionId, "Session exported: ");
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      content: {
        mimeType: "text/html",
        name: `pi-session-${safeSessionId}.html`,
        title: "Session exported",
        type: "resource_link",
        uri: `file://${resultPath}`,
      },
      sessionUpdate: "agent_message_chunk",
    },
  });
};

const autoCompactEnabled = (mode: string, current: boolean): boolean => {
  if (["on", "true", "enable", "enabled"].includes(mode)) {
    return true;
  }
  if (["off", "false", "disable", "disabled"].includes(mode)) {
    return false;
  }
  return !current;
};

const handleAutoCompactCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  args: string[]
): Promise<void> => {
  const mode = (args[0] ?? "toggle").toLowerCase();
  let current = false;
  if (
    ![
      "on",
      "true",
      "enable",
      "enabled",
      "off",
      "false",
      "disable",
      "disabled",
    ].includes(mode)
  ) {
    current = Boolean(
      asRecord(await session.proc.getState())?.autoCompactionEnabled
    );
  }
  const enabled = autoCompactEnabled(mode, current);
  await session.proc.setAutoCompaction(enabled);
  await sendAgentText(
    conn,
    session.sessionId,
    `Auto-compaction ${enabled ? "enabled" : "disabled"}.`
  );
};

type SlashCommandHandler = (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  args: string[]
) => Promise<void>;

const slashCommandHandlers: Partial<Record<string, SlashCommandHandler>> = {
  autocompact: handleAutoCompactCommand,
  changelog: async (conn, session) => {
    await handleChangelogCommand(conn, session);
  },
  compact: handleCompactCommand,
  export: async (conn, session) => {
    await handleExportCommand(conn, session);
  },
  "follow-up": async (conn, session, args) => {
    await handleModeCommand(conn, session, args, "follow-up");
  },
  name: handleNameCommand,
  session: async (conn, session) => {
    await handleSessionCommand(conn, session);
  },
  steering: async (conn, session, args) => {
    await handleModeCommand(conn, session, args, "steering");
  },
};

const handleSlashCommand = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  message: string
): Promise<boolean> => {
  const trimmed = message.trim();
  const space = trimmed.indexOf(" ");
  const command = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
  const argsString = space === -1 ? "" : trimmed.slice(space + 1);
  const handler = slashCommandHandlers[command];
  if (!handler) {
    return false;
  }
  await handler(conn, session, parseCommandArgs(argsString));
  return true;
};

type TodoPlan = ReturnType<typeof todoResultToPlanEntries>;

const restoredToolArguments = (messages: unknown[]): Map<string, unknown> => {
  const argumentsById = new Map<string, unknown>();
  for (const messageValue of messages) {
    const message = asRecord(messageValue);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const blockValue of message.content) {
      const block = asRecord(blockValue);
      if (block?.type === "toolCall" && typeof block.id === "string") {
        argumentsById.set(block.id, block.arguments);
      }
    }
  }
  return argumentsById;
};

const replayUserMessage = async (
  conn: AgentClientConnection,
  sessionId: string,
  message: UnknownRecord
): Promise<void> => {
  const text = normalizePiMessageText(message.content);
  if (text.length === 0) {
    return;
  }
  await conn.sessionUpdate({
    sessionId,
    update: {
      content: { text, type: "text" },
      sessionUpdate: "user_message_chunk",
    },
  });
};

const replayAssistantMessage = async (
  conn: AgentClientConnection,
  sessionId: string,
  message: UnknownRecord
): Promise<void> => {
  const text = normalizePiAssistantText(message.content);
  if (text) {
    await sendAgentText(conn, sessionId, text);
  }
};

const replayBashResult = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  message: UnknownRecord,
  details: {
    isError: boolean;
    rawInput: unknown;
    toolCallId: string;
    toolName: string;
  }
): Promise<void> => {
  const text = bashResultText(message);
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      _meta: bashTerminalInfoMeta(details.toolCallId, session.cwd),
      content: bashTerminalContent(details.toolCallId),
      kind: "execute",
      sessionUpdate: "tool_call",
      status: "completed",
      title:
        bashCommand(details.rawInput) ??
        bashCommand(message) ??
        details.toolName,
      toolCallId: details.toolCallId,
    },
  });
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      _meta: {
        ...(text ? bashTerminalOutputMeta(details.toolCallId, text) : {}),
        ...bashTerminalExitMeta(
          details.toolCallId,
          bashExitCode(message, details.isError)
        ),
      },
      sessionUpdate: "tool_call_update",
      status: details.isError ? "failed" : "completed",
      toolCallId: details.toolCallId,
    },
  });
};

const toolKind = (toolName: string): "edit" | "other" | "read" => {
  if (toolName === "read") {
    return "read";
  }
  return toolName === "write" || toolName === "edit" ? "edit" : "other";
};

const replayStandardToolResult = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  message: UnknownRecord,
  details: {
    isError: boolean;
    rawInput: unknown;
    toolCallId: string;
    toolName: string;
  }
): Promise<void> => {
  const locations = toToolCallLocations(details.rawInput, session.cwd);
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      kind: toolKind(details.toolName),
      rawInput: details.rawInput,
      rawOutput: message,
      sessionUpdate: "tool_call",
      status: "completed",
      title: details.toolName,
      toolCallId: details.toolCallId,
      ...(locations ? { locations } : {}),
    },
  });
  const text = toolResultToText(message);
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      content: text
        ? [{ content: { text, type: "text" }, type: "content" }]
        : null,
      rawOutput: message,
      sessionUpdate: "tool_call_update",
      status: details.isError ? "failed" : "completed",
      toolCallId: details.toolCallId,
    },
  });
};

const replayToolResult = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  message: UnknownRecord,
  restoredArgs: Map<string, unknown>,
  todoPlan: TodoPlan
): Promise<TodoPlan> => {
  const toolName = stringValue(message.toolName, "tool");
  const nextTodoPlan =
    toolName === "todo"
      ? (todoResultToPlanEntries(message) ?? todoPlan)
      : todoPlan;
  const toolCallId = stringValue(message.toolCallId, crypto.randomUUID());
  const details = {
    isError: Boolean(message.isError),
    rawInput: message.args ?? restoredArgs.get(toolCallId) ?? null,
    toolCallId,
    toolName,
  };
  await (isBashTool(toolName)
    ? replayBashResult(conn, session, message, details)
    : replayStandardToolResult(conn, session, message, details));
  return nextTodoPlan;
};

const replayMessage = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  messageValue: unknown,
  restoredArgs: Map<string, unknown>,
  todoPlan: TodoPlan
): Promise<TodoPlan> => {
  const message = asRecord(messageValue);
  if (message === undefined) {
    return todoPlan;
  }
  const role = stringValue(message.role);
  if (role === "user") {
    await replayUserMessage(conn, session.sessionId, message);
  } else if (role === "assistant") {
    await replayAssistantMessage(conn, session.sessionId, message);
  } else if (role === "toolResult") {
    return await replayToolResult(
      conn,
      session,
      message,
      restoredArgs,
      todoPlan
    );
  }
  return todoPlan;
};

const replayMessages = async (
  conn: AgentClientConnection,
  session: MagPiAcpSession,
  messages: unknown[],
  restoredArgs: Map<string, unknown>,
  index = 0,
  todoPlan?: TodoPlan
): Promise<TodoPlan> => {
  const message = messages[index];
  if (message === undefined) {
    return todoPlan;
  }
  const nextTodoPlan = await replayMessage(
    conn,
    session,
    message,
    restoredArgs,
    todoPlan
  );
  return await replayMessages(
    conn,
    session,
    messages,
    restoredArgs,
    index + 1,
    nextTodoPlan
  );
};

const loadMessages = async (
  proc: PiRpcProcess,
  sessionFile: string
): Promise<unknown[]> => {
  const activeMessages = activeSessionMessages(sessionFile);
  if (activeMessages.length > 0) {
    return activeMessages.map((entry) => entry.message);
  }
  const messages = asRecord(await proc.getMessages())?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  const result: unknown[] = [];
  for (const message of messages) {
    result.push(message);
  }
  return result;
};

const advertiseCommands = (
  conn: AgentClientConnection,
  sessionId: string,
  proc: PiRpcProcess
): void => {
  setTimeout(() => {
    void (async () => {
      let commands: AvailableCommand[] = [];
      try {
        commands = toAvailableCommandsFromPiGetCommands(
          await proc.getCommands()
        );
      } catch {
        // Adapter commands remain available if Pi command discovery fails.
      }
      await conn.sessionUpdate({
        sessionId,
        update: {
          availableCommands: mergeCommands(
            commands,
            builtinAvailableCommands()
          ),
          sessionUpdate: "available_commands_update",
        },
      });
    })();
  }, 0);
};

const assertKnownExtensionMethod = (method: string): void => {
  if (
    ![
      MAGPI_ACP_FORK_MESSAGES_METHOD,
      MAGPI_ACP_TREE_METHOD,
      MAGPI_ACP_NAVIGATE_TREE_METHOD,
    ].includes(method)
  ) {
    throw RequestError.methodNotFound(method);
  }
};

export class MagPiAcpAgent implements ACPAgent {
  private readonly conn: AgentClientConnection;
  private readonly sessions = new SessionManager();
  private readonly restoringSessions = new Map<
    string,
    Promise<MagPiAcpSession>
  >();
  private supportsFormElicitation = false;

  dispose(): void {
    this.sessions.disposeAll();
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null;

  constructor(conn: AgentClientConnection, _config?: unknown) {
    this.conn = conn;
    void _config;
  }

  private cleanupFailedNewSession(sessionId: string, state?: unknown): void {
    this.sessions.close(sessionId);

    const stateRecord = asRecord(state);
    const sessionFile =
      typeof stateRecord?.sessionFile === "string" &&
      stateRecord.sessionFile.trim()
        ? stateRecord.sessionFile
        : findPiSession(sessionId)?.sessionFile;

    if (sessionFile !== undefined && sessionFile.length > 0) {
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
    opts?: { mcpServers?: LoadSessionRequest["mcpServers"] }
  ): Promise<MagPiAcpSession> {
    const existing = this.sessions.maybeGet(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight !== undefined) {
      return await inFlight;
    }

    const restorePromise = (async () => {
      const stored = findPiSession(sessionId);
      if (stored === null) {
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
      } catch (error: unknown) {
        const errorRecord = asRecord(error);
        if (errorRecord?.name === "PiRpcSpawnError") {
          throw RequestError.internalError(
            { code: errorRecord.code },
            errorMessage(error)
          );
        }
        throw error instanceof Error ? error : new Error(errorMessage(error));
      }

      const session = this.sessions.getOrCreate(sessionId, {
        conn: this.conn,
        cwd,
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

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    await Promise.resolve();
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1;
    const requested = params.protocolVersion;
    this.supportsFormElicitation =
      params.clientCapabilities?.elicitation?.form !== undefined &&
      params.clientCapabilities.elicitation.form !== null;
    const clientCapabilities = asRecord(params.clientCapabilities);
    const clientMeta = asRecord(clientCapabilities?._meta);

    return {
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
        supportsTerminalAuthMeta: clientMeta?.["terminal-auth"] === true,
      }),
      protocolVersion:
        requested === supportedVersion ? requested : supportedVersion,
    };
  }

  async newSession(params: NewSessionRequest) {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        `cwd must be an absolute path: ${params.cwd}`
      );
    }

    this.lastSessionCwd = params.cwd;

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      conn: this.conn,
      cwd: params.cwd,
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
        .then((value) => {
          state = value;
        })
        .catch((error: unknown) => {
          stateErr = error;
          state = null;
        }),
      session.proc
        .getAvailableModels()
        .then((value) => {
          availableModels = value;
        })
        .catch((error: unknown) => {
          availableModelsErr = error;
          availableModels = null;
        }),
    ]);

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);

    if (availableModelsAuthErr !== null) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }

    if (availableModelsErr !== null) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.internalError({}, errorMessage(availableModelsErr));
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModels = asRecord(availableModels)?.models;
    const rawModelsCount = Array.isArray(rawModels) ? rawModels.length : 0;

    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }

    if (stateErr !== null && maybeAuthRequiredError(stateErr) !== null) {
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
      preludeText =
        updateNotice === null || updateNotice.length === 0
          ? ""
          : `${updateNotice}\n`;
    }

    if (preludeText.length > 0) {
      session.setStartupInfo(preludeText);

      // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
      // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
      // It does NOT affect other client windows because they run in separate agent processes.
      //
      // (Tests sometimes stub out `this.sessions`, so guard the call.)
    }
    this.sessions.closeAllExcept(session.sessionId);

    const response = {
      configOptions,
      models,
      modes,
      sessionId: session.sessionId,
    };

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    setTimeout(() => {
      if (preludeText.length > 0) {
        session.sendStartupInfoIfPending();
      }
      void session.sendUsageUpdate();
    }, 0);

    // Advertise slash commands after session/new so clients recognize the session ID.
    setTimeout(() => {
      void (async () => {
        let commands: AvailableCommand[] = [];
        try {
          commands = toAvailableCommandsFromPiGetCommands(
            await session.proc.getCommands()
          );
        } catch {
          // Adapter commands remain available if Pi command discovery fails.
        }

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
      })();
    }, 0);

    return response;
  }

  async authenticate(params: AuthenticateRequest): Promise<void> {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    void params;
    void this.conn;
    await Promise.resolve();
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId);
    const { images, message } = promptToPiMessage(params.prompt);

    if (
      images.length === 0 &&
      message.trimStart().startsWith("/") &&
      (await handleSlashCommand(this.conn, session, message))
    ) {
      return { stopReason: "end_turn" };
    }

    const result = await session.prompt(message, images);
    let stopReason: StopReason;
    if (result === "error") {
      stopReason = session.wasCancelRequested() ? "cancelled" : "end_turn";
    } else {
      stopReason = result;
    }
    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId);
    if (session === undefined) {
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
      (typeof rawEntryId !== "string" || rawEntryId.trim().length === 0)
    ) {
      throw RequestError.invalidParams(
        "Fork entry ID must be a non-empty string."
      );
    }
    const entryId = typeof rawEntryId === "string" ? rawEntryId : undefined;
    const source = await this.restoreSession(params.sessionId);
    const state = asRecord(await source.proc.getState());
    if (typeof state?.sessionFile !== "string") {
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
    assertKnownExtensionMethod(method);

    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : null;
    if (sessionId === null || sessionId.length === 0) {
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
        typeof params.entryId === "string" && params.entryId.trim().length > 0
          ? params.entryId
          : null;
      if (entryId === null) {
        throw RequestError.invalidParams("entryId is required.");
      }

      const before = await session.proc.getTree();
      const entry = findTreeMessage(before.tree, entryId);
      if (entry === null) {
        throw RequestError.invalidParams(
          `Pi tree message not found: ${entryId}`
        );
      }

      const identity = asRecord(await session.proc.getState());
      await session.proc.navigateTree(entryId);
      const [after, nextState] = await Promise.all([
        session.proc.getTree(),
        session.proc.getState(),
      ]);
      const nextIdentity = asRecord(nextState);
      if (
        nextIdentity?.sessionFile !== identity?.sessionFile ||
        nextIdentity?.sessionId !== identity?.sessionId
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

  async listSessions(
    params: ListSessionsRequest
  ): Promise<ListSessionsResponse> {
    await Promise.resolve();
    // Filter by cwd when provided; otherwise use the latest session cwd for a project-scoped picker.
    const all = listPiSessions();

    const requestedCwd = asRecord(params)?.cwd;
    const effectiveCwd =
      typeof requestedCwd === "string" ? requestedCwd : this.lastSessionCwd;
    const filtered =
      effectiveCwd === null || effectiveCwd.length === 0
        ? all
        : all.filter((session) => session.cwd === effectiveCwd);

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset =
      params.cursor === null || params.cursor === undefined
        ? 0
        : Math.trunc(Number(params.cursor));
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);

    const sessions: SessionInfo[] = page.map((s) => ({
      cwd: s.cwd,
      sessionId: s.sessionId,
      title: s.title,
      updatedAt: s.updatedAt,
      ...(s.preview !== null && s.previewRole !== null
        ? {
            _meta: {
              magPiAcp: { preview: s.preview, previewRole: s.previewRole },
            },
          }
        : {}),
    }));

    const nextCursor =
      start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;

    return { nextCursor, sessions };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!path.isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        `cwd must be an absolute path: ${params.cwd}`
      );
    }

    this.sessions.close(params.sessionId);
    const stored = findPiSession(params.sessionId);
    if (stored === null) {
      throw RequestError.invalidParams(
        `Unknown sessionId: ${params.sessionId}`
      );
    }
    this.lastSessionCwd = stored.cwd;

    const session = await this.restoreSession(params.sessionId, {
      mcpServers: params.mcpServers,
    });
    const { proc } = session;
    this.sessions.closeAllExcept?.(session.sessionId);

    const messages = await loadMessages(proc, stored.sessionFile);
    const todoPlan = await replayMessages(
      this.conn,
      session,
      messages,
      restoredToolArguments(messages)
    );
    if (todoPlan !== undefined) {
      await this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: { entries: todoPlan, sessionUpdate: "plan" },
      });
    }

    const { configOptions, models, modes } =
      await getSessionConfiguration(proc);
    const response = { configOptions, models, modes };
    advertiseCommands(this.conn, session.sessionId, proc);
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

    const mode = params.modeId;
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
    const { configId } = params;

    if (typeof params.value !== "string") {
      throw RequestError.invalidParams(
        `Expected string value for config option: ${configId}`
      );
    }

    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value);
    } else if (configId === ROLE_CONFIG_ID) {
      const selectedRole = getRoles().find(
        (candidate) => candidate.id === params.value
      );
      if (selectedRole === undefined) {
        throw RequestError.invalidParams(`Unknown role: ${params.value}`);
      }

      await setSessionModel(session.proc, selectedRole.model);
      await session.proc.setThinkingLevel(selectedRole.thinkingLevel);

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          currentModeId: selectedRole.thinkingLevel,
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
