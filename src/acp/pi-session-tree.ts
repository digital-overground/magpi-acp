import { readFileSync } from "node:fs";

import { asRecord } from "../unknown.js";

interface SessionEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  message?: {
    role?: unknown;
    [key: string]: unknown;
  };
}

export interface ActiveSessionMessage {
  id: string;
  message: NonNullable<SessionEntry["message"]>;
}

export const activeSessionMessages = (
  sessionFile: string
): ActiveSessionMessage[] => {
  let contents: string;
  try {
    contents = readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }

  const entries: (SessionEntry & { id: string; parentId: string | null })[] =
    [];
  const entriesById = new Map<
    string,
    SessionEntry & { id: string; parentId: string | null }
  >();

  for (const line of contents.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = asRecord(JSON.parse(line) as unknown);
      if (typeof entry?.id !== "string") {
        continue;
      }
      if (entry.parentId !== null && typeof entry.parentId !== "string") {
        continue;
      }

      const message = asRecord(entry.message);
      const normalized: SessionEntry & {
        id: string;
        parentId: string | null;
      } = {
        ...entry,
        id: entry.id,
        parentId: entry.parentId,
        ...(message === undefined ? {} : { message }),
      };
      entries.push(normalized);
      entriesById.set(normalized.id, normalized);
    } catch {
      // Ignore an incomplete trailing line while Pi is still flushing the session.
    }
  }

  const path: typeof entries = [];
  const visited = new Set<string>();
  let current = entries.at(-1);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current =
      current.parentId === null ? undefined : entriesById.get(current.parentId);
  }

  path.reverse();
  return path.flatMap((entry) =>
    entry.type === "message" && entry.message
      ? [{ id: entry.id, message: entry.message }]
      : []
  );
};
