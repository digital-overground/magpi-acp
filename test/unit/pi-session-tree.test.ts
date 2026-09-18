import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activeSessionMessages } from "../../src/acp/pi-session-tree.js";

test("activeSessionMessages returns only messages on the latest branch", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "magpi-acp-tree-"));
  const sessionFile = path.join(directory, "session.jsonl");
  const entries = [
    { id: "session-1", type: "session" },
    {
      id: "user-1",
      message: { content: "first", role: "user" },
      parentId: null,
      type: "message",
    },
    {
      id: "assistant-abandoned",
      message: { content: "old answer", role: "assistant" },
      parentId: "user-1",
      type: "message",
    },
    {
      id: "user-abandoned",
      message: { content: "old follow-up", role: "user" },
      parentId: "assistant-abandoned",
      type: "message",
    },
    {
      id: "assistant-2",
      message: { content: "new answer", role: "assistant" },
      parentId: "user-1",
      type: "message",
    },
    {
      id: "compaction-1",
      parentId: "assistant-2",
      summary: "Compacted context",
      type: "compaction",
    },
    {
      id: "user-2",
      message: { content: "new follow-up", role: "user" },
      parentId: "compaction-1",
      type: "message",
    },
  ];
  writeFileSync(
    sessionFile,
    entries.map((entry) => JSON.stringify(entry)).join("\n")
  );

  assert.deepEqual(
    activeSessionMessages(sessionFile).map((entry) => entry.id),
    ["user-1", "assistant-2", "user-2"]
  );
});
