import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { MagPiAcpSession } from "../../src/acp/session.js";
import type { PiRpcProcess } from "../../src/pi-rpc/process.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
} from "../helpers/fakes.js";

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => {
  assert.ok(value !== null && typeof value === "object");
  return value as UnknownRecord;
};

const createSession = (cwd: string) => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  return { conn, proc };
};

const completedToolUpdate = (
  conn: FakeAgentSideConnection,
  toolCallId = "t1"
) =>
  conn.updates.find((message) => {
    const update = asRecord(message.update);
    return (
      update.toolCallId === toolCallId &&
      update.sessionUpdate === "tool_call_update" &&
      update.status === "completed"
    );
  });

const completedDiff = (conn: FakeAgentSideConnection): UnknownRecord => {
  const message = completedToolUpdate(conn);
  assert.ok(message, "expected completed tool_call_update");
  const update = asRecord(message.update);
  assert.ok(Array.isArray(update.content), "expected content array");
  const diff = update.content.find((item) => asRecord(item).type === "diff");
  assert.ok(diff, "expected diff content item");
  return asRecord(diff);
};

test("MagPiAcpSession: emits ACP diff content for edit tool from actual before/after file contents", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-diff-"));
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "a.txt");
  writeFileSync(filePath, "before\n", "utf-8");

  const { conn, proc } = createSession(dir);

  proc.emit({
    args: { path: "a.txt" },
    toolCallId: "t1",
    toolName: "edit",
    type: "tool_execution_start",
  });
  writeFileSync(filePath, "after\n", "utf-8");
  proc.emit({
    isError: false,
    result: { content: [{ text: "ok", type: "text" }] },
    toolCallId: "t1",
    type: "tool_execution_end",
  });

  await delay(0);

  const diff = completedDiff(conn);
  assert.equal(diff.path, "a.txt");
  assert.equal(diff.oldText, "before\n");
  assert.equal(diff.newText, "after\n");

  const end = completedToolUpdate(conn);
  assert.ok(end);
  assert.equal(
    asRecord(end.update).rawOutput,
    undefined,
    "expected raw output to be suppressed when diff is emitted"
  );
});

test("MagPiAcpSession: does not turn requested edit args into finalized ACP diffs at tool start", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-diff-"));
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "a.txt");
  writeFileSync(filePath, "before\n", "utf-8");

  const { conn, proc } = createSession(dir);

  proc.emit({
    args: { edits: [{ newText: "after", oldText: "before" }], path: "a.txt" },
    toolCallId: "t1",
    toolName: "edit",
    type: "tool_execution_start",
  });

  await delay(0);

  const start = conn.updates.find((message) => {
    const update = asRecord(message.update);
    return update.toolCallId === "t1" && update.sessionUpdate === "tool_call";
  });
  assert.ok(start, "expected tool_call for edit start");
  assert.equal(
    asRecord(start.update).content,
    undefined,
    "expected no start-time diff from requested edit args"
  );

  writeFileSync(filePath, "after\n", "utf-8");
  proc.emit({
    isError: false,
    result: { content: [{ text: "ok", type: "text" }] },
    toolCallId: "t1",
    type: "tool_execution_end",
  });

  await delay(0);

  const diff = completedDiff(conn);
  assert.equal(diff.oldText, "before\n");
  assert.equal(diff.newText, "after\n");
});

test("MagPiAcpSession: edit diff uses realized fuzzy-match file contents instead of requested args", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-diff-"));
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "fuzzy.txt");
  writeFileSync(filePath, "FULLWIDTH: ＡＢＣ１２３\n", "utf-8");

  const { conn, proc } = createSession(dir);

  proc.emit({
    args: {
      edits: [
        {
          newText: "FULLWIDTH: ascii replacement",
          oldText: "FULLWIDTH: ABC123",
        },
      ],
      path: "fuzzy.txt",
    },
    toolCallId: "t1",
    toolName: "edit",
    type: "tool_execution_start",
  });

  writeFileSync(filePath, "FULLWIDTH: ascii replacement\n", "utf-8");
  proc.emit({
    isError: false,
    result: {
      content: [
        {
          text: "Successfully replaced 1 block(s) in fuzzy.txt.",
          type: "text",
        },
      ],
    },
    toolCallId: "t1",
    type: "tool_execution_end",
  });

  await delay(0);

  const diff = completedDiff(conn);
  assert.equal(diff.oldText, "FULLWIDTH: ＡＢＣ１２３\n");
  assert.equal(diff.newText, "FULLWIDTH: ascii replacement\n");
});

test("MagPiAcpSession: emits write diff content from actual before/after file contents on completion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-diff-"));
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "a.txt");
  writeFileSync(filePath, "before\n", "utf-8");

  const { conn, proc } = createSession(dir);

  proc.emit({
    args: { content: "after\n", path: "a.txt" },
    toolCallId: "t1",
    toolName: "write",
    type: "tool_execution_start",
  });

  await delay(0);

  const start = conn.updates.find((message) => {
    const update = asRecord(message.update);
    return update.toolCallId === "t1" && update.sessionUpdate === "tool_call";
  });
  assert.ok(start, "expected tool_call for write start");
  assert.equal(
    asRecord(start.update).content,
    undefined,
    "expected no start-time diff for write"
  );

  writeFileSync(filePath, "after\n", "utf-8");
  proc.emit({
    isError: false,
    result: {
      content: [{ text: "Successfully wrote 6 bytes to a.txt", type: "text" }],
    },
    toolCallId: "t1",
    type: "tool_execution_end",
  });

  await delay(0);

  const diff = completedDiff(conn);
  assert.equal(diff.path, "a.txt");
  assert.equal(diff.oldText, "before\n");
  assert.equal(diff.newText, "after\n");

  const end = completedToolUpdate(conn);
  assert.ok(end);
  assert.equal(
    asRecord(end.update).rawOutput,
    undefined,
    "expected raw output to be suppressed when diff is emitted"
  );
});

test("MagPiAcpSession: emits write diff content for new files on completion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-diff-"));
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "new.txt");

  const { conn, proc } = createSession(dir);

  proc.emit({
    args: { content: "created\n", path: "new.txt" },
    toolCallId: "t1",
    toolName: "write",
    type: "tool_execution_start",
  });

  writeFileSync(filePath, "created\n", "utf-8");
  proc.emit({
    isError: false,
    result: {
      content: [
        { text: "Successfully wrote 8 bytes to new.txt", type: "text" },
      ],
    },
    toolCallId: "t1",
    type: "tool_execution_end",
  });

  await delay(0);

  const diff = completedDiff(conn);
  assert.equal(diff.path, "new.txt");
  assert.equal(diff.oldText, null);
  assert.equal(diff.newText, "created\n");
});
