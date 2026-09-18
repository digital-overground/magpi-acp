import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listPiSessions } from "../../src/acp/pi-sessions.js";

void test("listPiSessions: updatedAt prefers last message timestamp over later non-message entries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-test-"));
  const sessionsDir = path.join(root, "sessions", "--p--");
  mkdirSync(sessionsDir, { recursive: true });

  const sessionFile = path.join(sessionsDir, "s.jsonl");

  // Last message at 00:00:02, but a later session_info at 00:00:10.
  // We want updatedAt == 00:00:02.
  writeFileSync(
    sessionFile,
    `${[
      JSON.stringify({
        cwd: "/tmp/project",
        id: "sess-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session",
        version: 3,
      }),
      JSON.stringify({
        id: "a1b2c3d4",
        message: { content: "hi", role: "user" },
        parentId: null,
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "message",
      }),
      JSON.stringify({
        id: "b1b2c3d4",
        name: "named",
        parentId: "a1b2c3d4",
        timestamp: "2026-01-01T00:00:10.000Z",
        type: "session_info",
      }),
    ].join("\n")}\n`,
    { encoding: "utf-8" }
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const sessions = listPiSessions().filter((s) => s.sessionId === "sess-1");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.updatedAt, "2026-01-01T00:00:02.000Z");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});
