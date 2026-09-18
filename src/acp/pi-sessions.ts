import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { asRecord } from "../unknown.js";

export interface PiSessionListItem {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  preview: string | null;
  previewRole: "user" | "assistant" | null;
  sessionFile: string;
}

const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_HEAD_BYTES = 64 * 1024;

const parseRecord = (value: string): Record<string, unknown> | undefined =>
  asRecord(JSON.parse(value) as unknown);

const getPiAgentDir = (): string => {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured === undefined
    ? path.join(homedir(), ".pi", "agent")
    : path.resolve(configured);
};

const readSessionDirFromSettings = (agentDir: string): string | null => {
  const settingsPath = path.join(agentDir, "settings.json");
  try {
    if (!existsSync(settingsPath)) {
      return null;
    }
    const raw = readFileSync(settingsPath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    const record = asRecord(data);
    if (record === undefined) {
      return null;
    }

    const { sessionDir } = record;
    if (typeof sessionDir !== "string" || !sessionDir.trim()) {
      return null;
    }

    return path.isAbsolute(sessionDir)
      ? sessionDir
      : path.resolve(agentDir, sessionDir);
  } catch {
    return null;
  }
};

export const getPiSessionsDir = (): string => {
  const agentDir = getPiAgentDir();
  return (
    readSessionDirFromSettings(agentDir) ?? path.join(agentDir, "sessions")
  );
};

const walkJsonlFiles = (dir: string, out: string[]): void => {
  let entries: Dirent[];
  try {
    // Force string names.
    entries = readdirSync(dir, {
      encoding: "utf-8",
      withFileTypes: true,
    });
  } catch {
    return;
  }

  for (const e of entries) {
    const { name } = e;
    const p = path.join(dir, name);
    if (e.isDirectory()) {
      walkJsonlFiles(p, out);
    } else if (e.isFile() && name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
};

const readFirstLine = (filePath: string): string | null => {
  // Avoid reading the whole file.
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) {
      return null;
    }
    const s = buf.subarray(0, n).toString("utf-8");
    const idx = s.indexOf("\n");
    return idx === -1 ? s.trim() : s.slice(0, idx).trim();
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
};

const readTail = (filePath: string, tailBytes = DEFAULT_TAIL_BYTES): string => {
  const st = statSync(filePath);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;

  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
};

const parseSessionHeader = (
  firstLine: string
): { sessionId: string; cwd: string } | null => {
  try {
    const obj = parseRecord(firstLine);
    if (obj?.type !== "session") {
      return null;
    }
    const sessionId = typeof obj?.id === "string" ? obj.id : null;
    const cwd = typeof obj?.cwd === "string" ? obj.cwd : null;
    if (sessionId === null || cwd === null) {
      return null;
    }
    return { cwd, sessionId };
  } catch {
    return null;
  }
};

const pickTitleFromTail = (tail: string): string | null => {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      const obj = parseRecord(line);
      if (
        obj?.type === "session_info" &&
        typeof obj.name === "string" &&
        obj.name.trim()
      ) {
        return obj.name.trim();
      }
    } catch {
      // ignore
    }
  }
  return null;
};

const scanSessionInfoNameFromFile = (filePath: string): string | null => {
  // Fallback when the session_info entry is older than our tail window.
  // Scan the whole file line-by-line and remember the last session_info.name.
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    let leftover = "";
    let offset = 0;
    let lastName: string | null = null;

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) {
        break;
      }
      offset += n;

      const chunk = leftover + buf.subarray(0, n).toString("utf-8");
      const lines = chunk.split(/\r?\n/u);
      leftover = lines.pop() ?? "";

      for (const line0 of lines) {
        const line = line0.trim();
        if (!line) {
          continue;
        }
        try {
          const obj = parseRecord(line);
          if (
            obj?.type === "session_info" &&
            typeof obj.name === "string" &&
            obj.name.trim()
          ) {
            lastName = obj.name.trim();
          }
        } catch {
          // ignore
        }
      }
    }

    // Best-effort: parse leftover if it was a full line without trailing newline.
    const tailLine = leftover.trim();
    if (tailLine) {
      try {
        const obj = parseRecord(tailLine);
        if (
          obj?.type === "session_info" &&
          typeof obj.name === "string" &&
          obj.name.trim()
        ) {
          lastName = obj.name.trim();
        }
      } catch {
        // ignore
      }
    }

    return lastName;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
};

const textBlockContent = (block: unknown): string[] => {
  const record = asRecord(block);
  return record?.type === "text" && typeof record.text === "string"
    ? [record.text]
    : [];
};

const messageText = (content: unknown): string | null => {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.flatMap(textBlockContent).join(" ");
  }

  const preview = text
    .split("\n[Embedded Context] ", 1)[0]
    ?.replaceAll(/\s+/gu, " ")
    .trim();
  return preview !== undefined && preview.length > 0
    ? preview.slice(0, 160)
    : null;
};

const pickPreviewFromTail = (
  tail: string
): { preview: string; previewRole: "user" | "assistant" } | null => {
  const messages: { preview: string; previewRole: "user" | "assistant" }[] = [];
  for (const line of tail.split(/\r?\n/u)) {
    try {
      const entry = asRecord(JSON.parse(line) as unknown);
      const message = asRecord(entry?.message);
      if (entry?.type !== "message" || message === undefined) {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const preview = messageText(message.content);
      if (preview !== null) {
        messages.push({ preview, previewRole: message.role });
      }
    } catch {
      // Ignore malformed and incomplete lines.
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.previewRole === "user") {
      return messages[index] ?? null;
    }
  }
  return messages.at(-1) ?? null;
};

const latestTimestamp = (
  lines: string[],
  messagesOnly: boolean
): string | null => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = parseRecord(lines[index].trim());
      if (!entry || (messagesOnly && entry.type !== "message")) {
        continue;
      }
      if (typeof entry.timestamp !== "string") {
        continue;
      }
      const date = new Date(entry.timestamp);
      if (Number.isFinite(date.getTime())) {
        return date.toISOString();
      }
    } catch {
      // Ignore malformed and incomplete lines.
    }
  }
  return null;
};

const pickUpdatedAtFromTail = (tail: string): string | null => {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  const lines = tail.split(/\r?\n/u);
  return latestTimestamp(lines, true) ?? latestTimestamp(lines, false);
};

const pickFallbackTitleFromHead = (filePath: string): string | null => {
  // Fallback to first user message.
  // NOTE: we keep this simple: read a small head chunk and parse line-by-line.
  try {
    const raw = readFileSync(filePath, { encoding: "utf-8" });
    const lines = raw.split(/\r?\n/u);
    for (const line0 of lines) {
      const line = line0.trim();
      if (!line) {
        continue;
      }
      try {
        const entry = parseRecord(line);
        const message = asRecord(entry?.message);
        if (entry?.type === "message" && message?.role === "user") {
          const { content } = message;
          if (typeof content === "string") {
            return content.slice(0, 80);
          }
          if (Array.isArray(content)) {
            for (const block of content) {
              const textBlock = asRecord(block);
              if (
                textBlock?.type === "text" &&
                typeof textBlock.text === "string"
              ) {
                if (textBlock.text.length > 0) {
                  return textBlock.text.slice(0, 80);
                }
                break;
              }
            }
          }
        }
      } catch {
        // ignore
      }

      // Avoid scanning extremely large files fully.
      // If we didn't find a user message in the first ~2000 lines, give up.
      // (Most sessions have it early.)
      if (lines.length > 2000) {
        break;
      }
    }
  } catch {
    // ignore
  }

  return null;
};

export const listPiSessions = (): PiSessionListItem[] => {
  const sessionsDir = getPiSessionsDir();
  const files: string[] = [];
  walkJsonlFiles(sessionsDir, files);

  const items: PiSessionListItem[] = [];

  for (const file of files) {
    const first = readFirstLine(file);
    if (first === null || first.length === 0) {
      continue;
    }
    const header = parseSessionHeader(first);
    if (header === null) {
      continue;
    }

    let updatedAt: string | null = null;
    let preview: string | null = null;
    let previewRole: "user" | "assistant" | null = null;

    let title: string | null = null;
    try {
      const tail = readTail(file);
      title = pickTitleFromTail(tail);
      updatedAt = pickUpdatedAtFromTail(tail);
      const pickedPreview = pickPreviewFromTail(tail);
      preview = pickedPreview?.preview ?? null;
      previewRole = pickedPreview?.previewRole ?? null;
    } catch {
      // ignore
    }

    // If the session was named early and grew large, it may fall outside of the tail window.
    title ??= scanSessionInfoNameFromFile(file);

    // Fallback for updatedAt when we couldn't parse timestamps from tail.
    if (updatedAt === null) {
      try {
        updatedAt = statSync(file).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }

    title ??= pickFallbackTitleFromHead(file);

    items.push({
      cwd: header.cwd,
      preview,
      previewRole,
      sessionFile: file,
      sessionId: header.sessionId,
      title,
      updatedAt,
    });
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? "";
    const bb = b.updatedAt ?? "";
    return bb.localeCompare(aa);
  });

  return items;
};

export const findPiSession = (sessionId: string): PiSessionListItem | null => {
  const all = listPiSessions();
  return all.find((s) => s.sessionId === sessionId) ?? null;
};

export const findPiSessionFile = (sessionId: string): string | null =>
  findPiSession(sessionId)?.sessionFile ?? null;
