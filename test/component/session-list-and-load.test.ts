import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { activeSessionMessages } from "../../src/acp/pi-session-tree.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
  asRecord,
  mockPiSpawn,
} from "../helpers/fakes.js";

void test("MagPiAcpAgent: listSessions lists pi sessions and loadSession replays history", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-test-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--project--");
  const sessionFile = path.join(
    sessionsDir,
    "0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl"
  );

  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    sessionFile,
    `${[
      JSON.stringify({
        cwd: "/tmp/project",
        id: "sess-1",
        timestamp: "2026-02-11T00:00:00.000Z",
        type: "session",
        version: 3,
      }),
      JSON.stringify({
        id: "a1b2c3d4",
        message: { content: "Hello", role: "user" },
        parentId: null,
        timestamp: "2026-02-11T00:00:01.000Z",
        type: "message",
      }),
      JSON.stringify({
        id: "b2c3d4e5",
        message: {
          content: [{ text: "Hi there!", type: "text" }],
          role: "assistant",
        },
        parentId: "a1b2c3d4",
        timestamp: "2026-02-11T00:00:02.000Z",
        type: "message",
      }),
      JSON.stringify({
        id: "branch-summary-1",
        parentId: "b2c3d4e5",
        summary: "Preserve the adapter decision.",
        timestamp: "2026-02-11T00:00:03.000Z",
        type: "branch_summary",
      }),
      JSON.stringify({
        id: "c3d4e5f6",
        message: {
          details: {
            tasks: [
              {
                id: 1,
                status: "in_progress",
                subject: "Verify the restored session",
              },
            ],
          },
          role: "toolResult",
          toolName: "todo",
        },
        parentId: "branch-summary-1",
        timestamp: "2026-02-11T00:00:04.000Z",
        type: "message",
      }),
      JSON.stringify({
        id: "d4e5f6a7",
        name: "My Named Session",
        parentId: "c3d4e5f6",
        timestamp: "2026-02-11T00:00:05.000Z",
        type: "session_info",
      }),
    ].join("\n")}\n`,
    { encoding: "utf-8" }
  );

  assert.deepEqual(
    activeSessionMessages(sessionFile).map((entry) => entry.id),
    ["a1b2c3d4", "b2c3d4e5", "branch-summary-1", "c3d4e5f6"]
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));

    const listed = await agent.listSessions({ cursor: null, cwd: null });
    assert.ok(listed.sessions.length >= 1);

    const session = listed.sessions.find((item) => item.sessionId === "sess-1");
    assert.ok(session);
    assert.equal(session.cwd, "/tmp/project");
    assert.equal(session.title, "My Named Session");

    const proc = new FakePiRpcProcess();
    proc.availableModels = { models: [] };
    proc.messages = {
      messages: [{ content: "Only the compacted context", role: "user" }],
    };
    proc.state = { thinkingLevel: "medium" };
    const restoreSpawn = mockPiSpawn(async (params) => {
      await Promise.resolve();
      if (typeof params.sessionPath !== "string") {
        throw new TypeError("Expected a session path");
      }
      assert.ok(
        params.sessionPath.endsWith(
          "/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl"
        )
      );
      return proc.process;
    });

    try {
      await agent.loadSession({
        cwd: "/tmp/project",
        mcpServers: [],
        sessionId: "sess-1",
      });

      const texts = conn.updates.map((message) => {
        const update = asRecord(message.update);
        const content =
          typeof update.content === "object" &&
          update.content !== null &&
          !Array.isArray(update.content)
            ? asRecord(update.content)
            : undefined;
        return {
          kind: update.sessionUpdate,
          messageId: update.messageId,
          text: content?.text,
        };
      });

      assert.ok(
        texts.some(
          (item) =>
            item.kind === "user_message_chunk" &&
            item.messageId === undefined &&
            item.text === "Hello"
        )
      );
      assert.ok(
        texts.some(
          (item) =>
            item.kind === "agent_message_chunk" &&
            item.messageId === undefined &&
            item.text === "Hi there!"
        )
      );
      assert.deepEqual(
        conn.updates.find(
          (update) => update._meta?.["magpi-acp/branch-summary"] === true
        ),
        {
          _meta: { "magpi-acp/branch-summary": true },
          sessionId: "sess-1",
          update: {
            content: { text: "Preserve the adapter decision.", type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        }
      );
      assert.deepEqual(
        conn.updates.find((update) => update.update.sessionUpdate === "plan")
          ?.update,
        {
          entries: [
            {
              content: "Verify the restored session",
              priority: "medium",
              status: "in_progress",
            },
          ],
          sessionUpdate: "plan",
        }
      );
    } finally {
      restoreSpawn();
    }
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});

void test("MagPiAcpAgent: reloading after tree navigation preserves the live branch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-tree-reload-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--project--");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "0000_sess-tree.jsonl"),
    `${[
      {
        cwd: "/tmp/project",
        id: "sess-tree",
        timestamp: "2026-02-11T00:00:00.000Z",
        type: "session",
        version: 3,
      },
      {
        id: "user-1",
        message: { content: "First prompt", role: "user" },
        parentId: null,
        timestamp: "2026-02-11T00:00:01.000Z",
        type: "message",
      },
      {
        id: "assistant-1",
        message: {
          content: [{ text: "First answer", type: "text" }],
          role: "assistant",
        },
        parentId: "user-1",
        timestamp: "2026-02-11T00:00:02.000Z",
        type: "message",
      },
      {
        id: "user-2",
        message: { content: "Second prompt", role: "user" },
        parentId: "assistant-1",
        timestamp: "2026-02-11T00:00:03.000Z",
        type: "message",
      },
      {
        id: "assistant-2",
        message: {
          content: [{ text: "Second answer", type: "text" }],
          role: "assistant",
        },
        parentId: "user-2",
        timestamp: "2026-02-11T00:00:04.000Z",
        type: "message",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf-8"
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const proc = new FakePiRpcProcess();
  proc.availableModels = { models: [] };
  proc.state = { thinkingLevel: "medium" };
  let leafId = "assistant-2";
  let spawnCount = 0;
  let disposed = false;
  proc.getTree = () => ({ leafId, tree: [] });
  proc.process.dispose = () => {
    disposed = true;
  };
  const restoreSpawn = mockPiSpawn(async () => {
    spawnCount += 1;
    await Promise.resolve();
    return proc.process;
  });

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));
    const params = {
      cwd: "/tmp/project",
      mcpServers: [],
      sessionId: "sess-tree",
    };
    await agent.loadSession(params);

    leafId = "assistant-1";
    conn.updates.length = 0;
    await agent.loadSession(params);

    const replayed = conn.updates
      .map((message) => asRecord(message.update))
      .filter(
        (update) =>
          update.sessionUpdate === "user_message_chunk" ||
          update.sessionUpdate === "agent_message_chunk"
      )
      .map((update) => asRecord(update.content)?.text);
    assert.deepEqual(replayed, ["First prompt", "First answer"]);
    assert.equal(spawnCount, 1);
    assert.equal(disposed, false);
  } finally {
    restoreSpawn();
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});
