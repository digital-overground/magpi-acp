import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

const processClass = PiRpcProcess as unknown as {
  spawn: typeof PiRpcProcess.spawn;
};
const timeoutOwner = globalThis as unknown as {
  setTimeout: typeof globalThis.setTimeout;
};

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

  const realSetTimeout = globalThis.setTimeout;
  const timeouts: unknown[] = [];
  timeoutOwner.setTimeout = ((scheduledTask: unknown) => {
    timeouts.push(scheduledTask);
    return 0;
  }) as unknown as typeof globalThis.setTimeout;

  const originalSpawn = PiRpcProcess.spawn;
  processClass.spawn = () =>
    Promise.resolve({
      getAvailableModels: () => Promise.resolve({ models: [] }),
      getMessages: () => Promise.resolve({ messages: [] }),
      getState: () => Promise.resolve({ thinkingLevel: "medium" }),
      onEvent: () => () => {},
    } as unknown as PiRpcProcess);

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
    timeoutOwner.setTimeout = realSetTimeout;
    processClass.spawn = originalSpawn;
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});
