import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

test("MagPiAcpAgent: does not emit startup info on loadSession", async () => {
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

  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout;
  const timeouts: unknown[] = [];
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = (
    fn: unknown,
    _ms?: number
  ) => {
    timeouts.push(fn);
    return 0 as never;
  };

  const originalSpawn = PiRpcProcess.spawn;
  (PiRpcProcess as unknown as { spawn: unknown }).spawn = () =>
    ({
      getAvailableModels: () => ({ models: [] }),
      getMessages: () => ({ messages: [] }),
      getState: () => ({ thinkingLevel: "medium" }),
      onEvent: () => () => {},
    }) as never;

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));

    const res = await agent.loadSession({
      cwd: "/tmp/project",
      mcpServers: [],
      sessionId: "s1",
    } as never);

    const metadata = res as {
      _meta?: { magPiAcp?: { startupInfo?: unknown } };
    };
    assert.equal(metadata._meta?.magPiAcp?.startupInfo, null);

    // Only available_commands_update should be scheduled.
    assert.equal(timeouts.length, 1);
  } finally {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout =
      realSetTimeout;
    PiRpcProcess.spawn = originalSpawn;
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});
