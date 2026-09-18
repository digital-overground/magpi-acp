import type { AvailableCommand } from "@agentclientprotocol/sdk";

export interface PiRpcCommandInfo {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  location?: unknown;
  path?: unknown;
}

const describeFallback = (c: PiRpcCommandInfo): string => {
  const source = typeof c.source === "string" ? c.source : "";
  const location = typeof c.location === "string" ? c.location : "";

  const parts: string[] = [];
  if (source) {
    parts.push(source);
  }
  if (location) {
    parts.push(location);
  }

  return parts.length ? `(${parts.join(":")})` : "(command)";
};

const commandList = (data: unknown): PiRpcCommandInfo[] => {
  const root = data as {
    commands?: unknown;
    data?: { commands?: unknown };
  } | null;
  if (Array.isArray(root?.commands)) {
    return root.commands as PiRpcCommandInfo[];
  }
  return Array.isArray(root?.data?.commands)
    ? (root.data.commands as PiRpcCommandInfo[])
    : [];
};

export const toAvailableCommandsFromPiGetCommands = (
  data: unknown,
  opts?: { enableSkillCommands?: boolean; includeExtensionCommands?: boolean }
): {
  commands: AvailableCommand[];
  raw: PiRpcCommandInfo[];
} => {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false;

  const commandsRaw = commandList(data);

  const out: AvailableCommand[] = [];

  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) {
      continue;
    }

    const source = typeof c?.source === "string" ? c.source : "";
    if (!includeExtensionCommands && source === "extension") {
      continue;
    }

    if (!enableSkillCommands && name.startsWith("skill:")) {
      continue;
    }

    const desc = typeof c?.description === "string" ? c.description.trim() : "";

    out.push({
      description: desc || describeFallback(c),
      name,
    });
  }

  return { commands: out, raw: commandsRaw };
};
