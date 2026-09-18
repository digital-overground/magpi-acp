import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  FakeAgentSideConnection,
  asAgentConn,
  replaceProperty,
} from "../helpers/fakes.js";

void test("MagPiAcpAgent: listSessions defaults to lastSessionCwd when cwd param is omitted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-test-"));

  const dirA = path.join(root, "sessions", "--a--");
  const dirB = path.join(root, "sessions", "--b--");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  writeFileSync(
    path.join(dirA, "1.jsonl"),
    `${JSON.stringify({
      cwd: "/cwd/a",
      id: "sess-a",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session",
      version: 3,
    })}\n${JSON.stringify({
      id: "a1b2c3d4",
      name: "A",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "session_info",
    })}\n`,
    { encoding: "utf-8" }
  );

  writeFileSync(
    path.join(dirB, "2.jsonl"),
    `${JSON.stringify({
      cwd: "/cwd/b",
      id: "sess-b",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session",
      version: 3,
    })}\n${JSON.stringify({
      id: "b1b2c3d4",
      name: "B",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "session_info",
    })}\n`,
    { encoding: "utf-8" }
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));

    replaceProperty(agent, "lastSessionCwd", "/cwd/a");

    const listed = await agent.listSessions({});
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0]?.sessionId, "sess-a");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});
