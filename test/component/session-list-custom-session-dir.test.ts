import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listPiSessions } from "../../src/acp/pi-sessions.js";

void test("listPiSessions: respects sessionDir from pi settings.json", () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-test-"));
  const customSessionsDir = path.join(root, "somewhere-else", "--p--");
  mkdirSync(customSessionsDir, { recursive: true });

  writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({ sessionDir: path.join(root, "somewhere-else") }, null, 2),
    "utf-8"
  );

  writeFileSync(
    path.join(customSessionsDir, "s.jsonl"),
    `${[
      JSON.stringify({
        cwd: "/tmp/project",
        id: "sess-custom",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session",
        version: 3,
      }),
      JSON.stringify({
        id: "m1",
        message: { content: "hi", role: "user" },
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "message",
      }),
    ].join("\n")}\n`,
    { encoding: "utf-8" }
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const s = listPiSessions().find((x) => x.sessionId === "sess-custom");
    assert.ok(s);
    assert.equal(s?.sessionFile, path.join(customSessionsDir, "s.jsonl"));
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});
