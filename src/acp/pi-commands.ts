import type { AvailableCommand } from "@agentclientprotocol/sdk";

import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from "../pi-rpc/tree-command.js";
import { asRecord } from "../unknown.js";

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
  const root = asRecord(data);
  const nested = asRecord(root?.data);
  let commands: unknown[] = [];
  if (Array.isArray(root?.commands)) {
    ({ commands } = root);
  } else if (Array.isArray(nested?.commands)) {
    ({ commands } = nested);
  }
  return commands.map((command) => asRecord(command) ?? {});
};

export const toAvailableCommandsFromPiGetCommands = (
  data: unknown
): AvailableCommand[] => {
  const commandsRaw = commandList(data);

  const out: AvailableCommand[] = [];

  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name || name === MAGPI_ACP_NAVIGATE_TREE_COMMAND) {
      continue;
    }

    const desc = typeof c?.description === "string" ? c.description.trim() : "";

    out.push({
      description: desc || describeFallback(c),
      name,
    });
  }

  return out;
};
