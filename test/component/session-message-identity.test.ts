import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { MagPiAcpSession } from "../../src/acp/session.js";
import type {
  PiSessionEntry,
  PiSessionTreeNode,
} from "../../src/pi-rpc/process.js";
import {
  MAGPI_ACP_FORK_MESSAGE_ID_META,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
} from "../../src/pi-rpc/tree-command.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
  replaceProperty,
} from "../helpers/fakes.js";

void test("live chunks map to their own persisted entries, not identical text", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const entries: PiSessionEntry[] = [];
  proc.getEntries = (since) => ({
    entries:
      since === undefined
        ? [...entries]
        : entries.slice(entries.findIndex((entry) => entry.id === since) + 1),
    leafId: entries.at(-1)?.id ?? null,
  });
  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc.process,
    sessionId: "s1",
  });
  const run = async (suffix: string) => {
    const pending = session.prompt("same");
    await delay(0);
    proc.emit({
      message: { content: "same", role: "user" },
      type: "message_start",
    });
    proc.emit({
      message: { content: "same", role: "user" },
      type: "message_end",
    });
    entries.push({
      id: `u${suffix}`,
      message: { role: "user" },
      type: "message",
    });
    for (const index of [1, 2]) {
      proc.emit({ message: { role: "assistant" }, type: "message_start" });
      for (const delta of ["sa", "me"]) {
        proc.emit({
          assistantMessageEvent: { delta, type: "text_delta" },
          type: "message_update",
        });
      }
      proc.emit({ message: { role: "assistant" }, type: "message_end" });
      entries.push({
        id: `a${suffix}-${index}`,
        message: { role: "assistant" },
        type: "message",
      });
    }
    proc.emit({ type: "agent_settled" });
    assert.equal(await pending, "end_turn");
  };
  await run("1");
  await run("2");
  const chunks = conn.updates
    .map((item) => item.update)
    .filter(
      (update) =>
        update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk"
    );
  const ids = chunks.map((update) => update.messageId);
  assert.equal(new Set(ids).size, 6);
  assert.deepEqual(ids, [
    ids[0],
    ids[1],
    ids[1],
    ids[3],
    ids[3],
    ids[5],
    ids[6],
    ids[6],
    ids[8],
    ids[8],
  ]);
  assert.deepEqual(
    [ids[0], ids[1], ids[3], ids[5], ids[6], ids[8]].map((id) =>
      session.entryIdForMessage(id ?? "")
    ),
    entries.map((entry) => entry.id)
  );
  assert.deepEqual(
    entries.map((entry) => session.replayMessageId(entry.id)),
    [ids[0], ids[1], ids[3], ids[5], ids[6], ids[8]]
  );
});

void test("transcript actions resolve live message IDs to exact native entries", async () => {
  const proc = new FakePiRpcProcess();
  const entries: PiSessionEntry[] = [];
  proc.getEntries = (since) => ({
    entries:
      since === undefined
        ? [...entries]
        : entries.slice(entries.findIndex((entry) => entry.id === since) + 1),
    leafId: entries.at(-1)?.id ?? null,
  });
  let tree: PiSessionTreeNode[] = [];
  proc.getTree = () => ({ leafId: entries.at(-1)?.id ?? null, tree });
  proc.getState = () => ({
    sessionFile: "/sessions/source.jsonl",
    sessionId: "s1",
  });
  const navigated: string[] = [];
  proc.navigateTree = (entryId) => {
    navigated.push(entryId);
  };
  const conn = new FakeAgentSideConnection();
  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc.process,
    sessionId: "s1",
  });
  let forkEntry: string | undefined;
  const agent = new MagPiAcpAgent(asAgentConn(conn));
  replaceProperty(agent, "sessions", {
    fork: async (params: { entryId?: string }) => {
      await Promise.resolve();
      forkEntry = params.entryId;
      return "child";
    },
    maybeGet: () => session,
  });
  for (const suffix of ["1", "2"]) {
    const pending = session.prompt("same");
    // oxlint-disable-next-line no-await-in-loop -- turns must settle in order
    await delay(0);
    const user = { content: "same", role: "user" };
    proc.emit({ message: user, type: "message_start" });
    proc.emit({ message: user, type: "message_end" });
    const userEntry: PiSessionEntry = {
      id: `pi-u${suffix}`,
      message: user,
      type: "message",
    };
    entries.push(userEntry);
    const assistant = {
      content: [{ text: "answer", type: "text" }],
      role: "assistant",
    };
    proc.emit({ message: assistant, type: "message_start" });
    proc.emit({
      assistantMessageEvent: { delta: "answer", type: "text_delta" },
      type: "message_update",
    });
    proc.emit({ message: assistant, type: "message_end" });
    const assistantEntry: PiSessionEntry = {
      id: `pi-a${suffix}`,
      message: assistant,
      type: "message",
    };
    entries.push(assistantEntry);
    tree = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined) {
        tree = [{ children: tree, entry }];
      }
    }
    proc.emit({ type: "agent_settled" });
    // oxlint-disable-next-line no-await-in-loop -- turns must settle in order
    assert.equal(await pending, "end_turn");
  }
  const userIds = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === "user_message_chunk" ? [update.messageId] : []
  );
  const assistantIds = conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === "agent_message_chunk" ? [update.messageId] : []
  );
  assert.notEqual(userIds[0], userIds[1]);
  assert.notEqual(assistantIds[0], assistantIds[1]);
  await agent.unstable_forkSession({
    _meta: { [MAGPI_ACP_FORK_MESSAGE_ID_META]: userIds[1] },
    cwd: process.cwd(),
    mcpServers: [],
    sessionId: "s1",
  });
  assert.equal(forkEntry, "pi-u2");
  await agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
    messageId: assistantIds[1],
    sessionId: "s1",
  });
  assert.deepEqual(navigated, ["pi-a2"]);
  assert.equal(session.replayMessageId("pi-u2"), userIds[1]);
});

void test("image-only prompts retain their image and user message ID", async () => {
  const proc = new FakePiRpcProcess();
  const conn = new FakeAgentSideConnection();
  let entries: PiSessionEntry[] = [];
  proc.getEntries = () => ({ entries, leafId: entries.at(-1)?.id ?? null });
  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc.process,
    sessionId: "s1",
  });
  const pending = session.prompt("", [
    { data: "abc", mimeType: "image/png", type: "image" },
  ]);
  await delay(0);
  const message = {
    content: [{ data: "abc", mimeType: "image/png", type: "image" }],
    role: "user",
  };
  proc.emit({ message, type: "message_start" });
  proc.emit({ message, type: "message_end" });
  entries = [{ id: "image-user", message: { role: "user" }, type: "message" }];
  proc.emit({ type: "agent_settled" });
  assert.equal(await pending, "end_turn");
  const update = conn.updates.find(
    (item) => item.update.sessionUpdate === "user_message_chunk"
  )?.update;
  assert.ok(update?.sessionUpdate === "user_message_chunk");
  assert.deepEqual(update.content, {
    data: "abc",
    mimeType: "image/png",
    type: "image",
  });
  assert.equal(session.entryIdForMessage(update.messageId ?? ""), "image-user");
});

void test("mismatched native roles leave the turn unmapped without failing it", async () => {
  const proc = new FakePiRpcProcess();
  proc.getEntries = () => ({
    entries: [{ id: "wrong", message: { role: "assistant" }, type: "message" }],
    leafId: "wrong",
  });
  const session = new MagPiAcpSession({
    conn: asAgentConn(new FakeAgentSideConnection()),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc.process,
    sessionId: "s1",
  });
  const pending = session.prompt("hello");
  await delay(0);
  proc.emit({
    message: { content: "hello", role: "user" },
    type: "message_start",
  });
  proc.emit({ message: { role: "user" }, type: "message_end" });
  proc.emit({ type: "agent_settled" });
  assert.equal(await pending, "end_turn");
  assert.equal(session.entryIdForMessage("wrong"), undefined);
  assert.equal(session.replayMessageId("wrong"), "wrong");
  assert.equal(session.entryIdForMessage("wrong"), undefined);
});
