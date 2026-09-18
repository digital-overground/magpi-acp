import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { activeSessionMessages } from "../../src/acp/pi-session-tree.js";
// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

test("MagPiAcpAgent: listSessions lists pi sessions and loadSession replays history", async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-test-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--project--");
  const sessionFile = path.join(
    sessionsDir,
    "0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl"
  );

  // Ensure parent dirs.
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
        parentId: "b2c3d4e5",
        timestamp: "2026-02-11T00:00:03.000Z",
        type: "message",
      }),
      JSON.stringify({
        id: "d4e5f6a7",
        name: "My Named Session",
        parentId: "c3d4e5f6",
        timestamp: "2026-02-11T00:00:04.000Z",
        type: "session_info",
      }),
    ].join("\n")}\n`,
    { encoding: "utf-8" }
  );

  assert.deepEqual(
    activeSessionMessages(sessionFile).map((entry) => entry.id),
    ["a1b2c3d4", "b2c3d4e5", "c3d4e5f6"]
  );

  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn));

    // 1) list sessions
    const listed = await agent.listSessions({
      _meta: null,
      cursor: null,
      cwd: null,
    } as never);
    assert.ok(listed.sessions.length >= 1);

    const s = listed.sessions.find((x) => x.sessionId === "sess-1");
    assert.ok(s);
    assert.equal(s?.cwd, "/tmp/project");
    assert.equal(s?.title, "My Named Session");

    // 2) load session: mock spawn to return fake proc with compacted history
    const originalSpawn = PiRpcProcess.spawn;

    (PiRpcProcess as unknown as { spawn: unknown }).spawn = (params: {
      sessionPath?: string;
    }) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === "string");
      assert.ok(
        params.sessionPath.endsWith(
          "/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl"
        )
      );

      return {
        getAvailableModels: () => ({ models: [] }),
        getMessages: () => ({
          messages: [{ content: "Only the compacted context", role: "user" }],
        }),
        getState: () => ({ thinkingLevel: "medium" }),
        onEvent: () => () => {
          // noop unsubscribe
        },
      } as never;
    };

    try {
      await agent.loadSession({
        _meta: null,
        cwd: "/tmp/project",
        mcpServers: [],
        sessionId: "sess-1",
      } as never);

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(
          (entry) =>
            entry.update as {
              content?: { text?: string };
              messageId?: string;
              sessionUpdate?: string;
            }
        )
        .map((update) => ({
          kind: update.sessionUpdate,
          messageId: update.messageId,
          text: update.content?.text,
        }));

      assert.ok(
        texts.some(
          (t) =>
            t.kind === "user_message_chunk" &&
            t.messageId === undefined &&
            t.text === "Hello"
        )
      );
      assert.ok(
        texts.some(
          (t) =>
            t.kind === "agent_message_chunk" &&
            t.messageId === undefined &&
            t.text === "Hi there!"
        )
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
      PiRpcProcess.spawn = originalSpawn;
    }
  } finally {
    if (oldEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = oldEnv;
    }
  }
});
