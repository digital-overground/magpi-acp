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
  asRecord,
  mockPiSpawn,
} from "../helpers/fakes.js";

void test("MagPiAcpAgent: loadSession restores tool arguments from their assistant calls", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-tool-restore-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--project--");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "0000_s1.jsonl"),
    `${JSON.stringify({ cwd: "/tmp/project", id: "s1", type: "session" })}\n`,
    "utf-8"
  );
  process.env.PI_CODING_AGENT_DIR = root;

  const proc = new FakePiRpcProcess();
  proc.availableModels = { models: [] };
  proc.messages = {
    messages: [
      {
        content: [
          {
            arguments: { command: "echo hello" },
            id: "call_1",
            name: "bash",
            type: "toolCall",
          },
          {
            arguments: { path: "src/a.ts" },
            id: "call_2",
            name: "read",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
      {
        content: [{ text: "hello from bash", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
      },
      {
        content: [{ text: "contents", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "read",
      },
    ],
  };
  proc.state = { thinkingLevel: "medium" };
  const restoreSpawn = mockPiSpawn(async () => {
    await Promise.resolve();
    return proc.process;
  });

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));

    await agent.loadSession({
      cwd: "/tmp/project",
      mcpServers: [],
      sessionId: "s1",
    });

    const updates = conn.updates.map((entry) => asRecord(entry.update));
    const toolCall = (id: string) =>
      updates.find(
        (update) =>
          update.sessionUpdate === "tool_call" && update.toolCallId === id
      );
    const bash = toolCall("call_1");
    assert.ok(bash);
    assert.equal(bash.title, "echo hello");
    assert.equal(bash.kind, "execute");
    assert.deepEqual(bash.content, [
      { terminalId: "call_1", type: "terminal" },
    ]);
    assert.deepEqual(bash._meta, {
      terminal_info: { cwd: "/tmp/project", terminal_id: "call_1" },
    });

    const read = toolCall("call_2");
    assert.ok(read);
    assert.equal(read.title, "read");
    assert.equal(read.kind, "read");
    assert.deepEqual(read.rawInput, { path: "src/a.ts" });
    assert.deepEqual(read.locations, [{ path: "/tmp/project/src/a.ts" }]);
  } finally {
    restoreSpawn();
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});
