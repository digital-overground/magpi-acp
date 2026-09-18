import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { listPiSessions } from "../../src/acp/pi-sessions.js";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes.js";

void test("listSessions includes a compact latest-user preview", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-preview-"));
  const sessionsDir = path.join(root, "sessions", "--project--");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, "session.jsonl"),
    `${[
      {
        cwd: "/project",
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session",
        version: 3,
      },
      {
        id: "user-1",
        message: { content: "First request", role: "user" },
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "message",
      },
      {
        id: "user-2",
        message: {
          content: [
            {
              text: "  Fix   the login cache\n[Embedded Context] file:///project/a.ts\nsecret  ",
              type: "text",
            },
          ],
          role: "user",
        },
        parentId: "user-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "message",
      },
      {
        id: "assistant-1",
        message: { content: "I will inspect it.", role: "assistant" },
        parentId: "user-2",
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "message",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`
  );

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const session = listPiSessions().find(
      (item) => item.sessionId === "session-1"
    );
    assert.equal(session?.preview, "Fix the login cache");
    assert.equal(session?.previewRole, "user");

    const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
    const listed = await agent.listSessions({ cwd: "/project" });
    assert.deepEqual(listed.sessions[0]?._meta, {
      magPiAcp: { preview: "Fix the login cache", previewRole: "user" },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});
