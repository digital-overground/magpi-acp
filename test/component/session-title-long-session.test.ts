import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listPiSessions } from "../../src/acp/pi-sessions.js";

// Ensures we still pick up session_info.name even if it is older than the tail window.

test("listPiSessions: finds session_info.name even when it is outside the tail window", () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-test-"));
  const sessionsDir = path.join(root, "sessions", "--p--");
  mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, "s.jsonl");

  const header = JSON.stringify({
    cwd: "/tmp/project",
    id: "sess-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session",
    version: 3,
  });
  const info = JSON.stringify({
    id: "i1",
    name: "Named Early",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "session_info",
  });

  // Create a large filler so the name is far outside the last 256KB tail.
  const fillerLine = JSON.stringify({
    id: "m",
    message: { content: "x".repeat(2000), role: "user" },
    parentId: null,
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "message",
  });
  const filler = Array.from({ length: 400 }, () => fillerLine).join("\n");

  writeFileSync(sessionFile, `${[header, info, filler].join("\n")}\n`, {
    encoding: "utf-8",
  });

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const s = listPiSessions().find((x) => x.sessionId === "sess-1");
    assert.ok(s);
    assert.equal(s?.title, "Named Early");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});
