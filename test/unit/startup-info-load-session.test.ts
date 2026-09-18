import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
  mockPiSpawn,
  replaceProperty,
} from "../helpers/fakes.js";

void test("MagPiAcpAgent: does not emit startup info on loadSession", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-startup-load-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--project--");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "0000_s1.jsonl"),
    `${JSON.stringify({ cwd: "/tmp/project", id: "s1", type: "session" })}\n`,
    "utf-8"
  );
  process.env.PI_CODING_AGENT_DIR = root;

  const realSetTimeout = globalThis.setTimeout;
  const timeouts: unknown[] = [];
  replaceProperty(globalThis, "setTimeout", (scheduledTask: unknown) => {
    timeouts.push(scheduledTask);
    return 0;
  });

  const proc = new FakePiRpcProcess();
  proc.availableModels = { models: [] };
  proc.messages = { messages: [] };
  proc.state = { thinkingLevel: "medium" };
  const restoreSpawn = mockPiSpawn(async () => {
    await Promise.resolve();
    return proc.process;
  });

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));

    const result = await agent.loadSession({
      cwd: "/tmp/project",
      mcpServers: [],
      sessionId: "s1",
    });

    assert.equal("_meta" in result, false);
    assert.equal(timeouts.length, 1);
  } finally {
    replaceProperty(globalThis, "setTimeout", realSetTimeout);
    restoreSpawn();
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});
