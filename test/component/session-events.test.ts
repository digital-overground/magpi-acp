import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

const updateAt = (
  conn: FakeAgentSideConnection,
  index: number
): UnknownRecord => asRecord(conn.updates.at(index)?.update);

const requestAt = (requests: unknown[], index: number): UnknownRecord =>
  asRecord(requests.at(index));

const requestPropertyAt = (
  requests: unknown[],
  index: number,
  property: string
): unknown => {
  const schema = asRecord(requestAt(requests, index).requestedSchema);
  return asRecord(schema.properties)[property];
};

const updateContentAt = (
  conn: FakeAgentSideConnection,
  index: number
): UnknownRecord => asRecord(updateAt(conn, index).content);

const updateTextAt = (conn: FakeAgentSideConnection, index: number): string => {
  const { text } = updateContentAt(conn, index);
  if (typeof text !== "string") {
    throw new TypeError("Expected text update content");
  }
  return text;
};

test("MagPiAcpSession: emits agent_message_chunk for text_delta", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    assistantMessageEvent: {
      delta: "hi",
      partial: { timestamp: 1_700_000_000_000 },
      type: "text_delta",
    },
    type: "message_update",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.sessionId, "s1");
  assert.deepEqual(conn.updates[0]?.update, {
    content: { text: "hi", type: "text" },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: emits agent_thought_chunk for thinking_delta", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    assistantMessageEvent: { delta: "thinking...", type: "thinking_delta" },
    type: "message_update",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.sessionId, "s1");
  assert.deepEqual(conn.updates[0]?.update, {
    content: { text: "thinking...", type: "text" },
    sessionUpdate: "agent_thought_chunk",
  });
});

test("MagPiAcpSession: emits tool_call + tool_call_update + completes", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    args: { command: "ls" },
    toolCallId: "t1",
    toolName: "bash",
    type: "tool_execution_start",
  });
  proc.emit({
    partialResult: { content: [{ text: "running", type: "text" }] },
    toolCallId: "t1",
    type: "tool_execution_update",
  });
  proc.emit({
    isError: false,
    result: { content: [{ text: "done", type: "text" }] },
    toolCallId: "t1",
    type: "tool_execution_end",
  });

  await delay(0);

  assert.equal(conn.updates.length, 3);

  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.equal(updateAt(conn, 0).toolCallId, "t1");
  assert.equal(updateAt(conn, 0).title, "ls");
  assert.equal(updateAt(conn, 0).kind, "execute");
  assert.equal(updateAt(conn, 0).status, "in_progress");
  assert.equal(updateAt(conn, 0).locations, undefined);
  assert.deepEqual(updateAt(conn, 0).content, [
    { terminalId: "t1", type: "terminal" },
  ]);
  assert.deepEqual(updateAt(conn, 0)._meta, {
    terminal_info: { cwd: process.cwd(), terminal_id: "t1" },
  });
  assert.equal(updateAt(conn, 0).rawInput, undefined);

  assert.equal(conn.updates[1]?.update.sessionUpdate, "tool_call_update");
  assert.equal(updateAt(conn, 1).toolCallId, "t1");
  assert.equal(updateAt(conn, 1).status, "in_progress");
  assert.equal(updateAt(conn, 1).content, undefined);
  assert.deepEqual(updateAt(conn, 1)._meta, {
    terminal_output: { data: "running", terminal_id: "t1" },
  });
  assert.equal(updateAt(conn, 1).rawOutput, undefined);

  assert.equal(conn.updates[2]?.update.sessionUpdate, "tool_call_update");
  assert.equal(updateAt(conn, 2).toolCallId, "t1");
  assert.equal(updateAt(conn, 2).status, "completed");
  assert.equal(updateAt(conn, 2).content, undefined);
  assert.deepEqual(updateAt(conn, 2)._meta, {
    terminal_exit: { exit_code: 0, signal: null, terminal_id: "t1" },
    terminal_output: { data: "done", terminal_id: "t1" },
  });
  assert.equal(updateAt(conn, 2).rawOutput, undefined);
});

test("MagPiAcpSession: emits tool locations from pi path args", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    args: { path: "src/acp/session.ts" },
    toolCallId: "t1",
    toolName: "read",
    type: "tool_execution_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.deepEqual(updateAt(conn, 0).locations, [
    { path: `${process.cwd()}/src/acp/session.ts` },
  ]);
});

test("MagPiAcpSession: handles extension select via ACP permission request", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextPermissionResponse = {
    outcome: { optionId: "choice-1", outcome: "selected" },
  };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    id: "ui-1",
    method: "select",
    options: ["Alpha", "Beta"],
    title: "Pick one",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.equal(conn.permissionRequests.length, 1);
  assert.deepEqual(conn.permissionRequests[0], {
    options: [
      { kind: "allow_once", name: "Alpha", optionId: "choice-0" },
      { kind: "allow_once", name: "Beta", optionId: "choice-1" },
    ],
    sessionId: "s1",
    toolCall: {
      kind: "other",
      rawInput: {
        method: "select",
        options: ["Alpha", "Beta"],
        title: "Pick one",
      },
      status: "pending",
      title: "Pick one",
      toolCallId: "pi-ui-ui-1",
    },
  });
  assert.deepEqual(proc.extensionUiResponses, [{ id: "ui-1", value: "Beta" }]);
});

test("MagPiAcpSession: handles extension confirm via ACP permission request", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextPermissionResponse = {
    outcome: { optionId: "no", outcome: "selected" },
  };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    id: "ui-2",
    message: "All messages will be lost.",
    method: "confirm",
    title: "Clear session?",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.equal(conn.permissionRequests.length, 1);
  assert.deepEqual(requestAt(conn.permissionRequests, 0).options, [
    { kind: "allow_once", name: "Yes", optionId: "yes" },
    { kind: "reject_once", name: "No", optionId: "no" },
  ]);
  assert.deepEqual(proc.extensionUiResponses, [
    { confirmed: false, id: "ui-2" },
  ]);
});

test("MagPiAcpSession: sends cancelled response when ACP confirm is cancelled", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextPermissionResponse = { outcome: { outcome: "cancelled" } };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    id: "ui-5",
    method: "confirm",
    title: "Continue?",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.deepEqual(proc.extensionUiResponses, [
    { cancelled: true, id: "ui-5" },
  ]);
});

test("MagPiAcpSession: combines an extension selection with custom context", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextElicitationResponse = {
    action: "accept",
    content: { choice: "Alpha", other: "A different answer" },
  };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
    supportsFormElicitation: true,
  });

  proc.emit({
    args: {
      context: "This context is visually secondary.",
      options: [
        { description: "The first option", title: "Alpha" },
        { description: "The second option", title: "Beta" },
      ],
      question: "Which option should we use?",
    },
    toolCallId: "ask-1",
    toolName: "ask_user",
    type: "tool_execution_start",
  });
  proc.emit({
    id: "ui-select",
    method: "select",
    options: ["Alpha", "Beta"],
    title: "Pick one",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.deepEqual(conn.elicitationRequests, [
    {
      message: "Which option should we use?",
      mode: "form",
      requestedSchema: {
        description: "This context is visually secondary.",
        properties: {
          choice: {
            oneOf: [
              {
                const: "Alpha",
                description: "The first option",
                title: "Alpha",
              },
              {
                const: "Beta",
                description: "The second option",
                title: "Beta",
              },
            ],
            title: "Suggested answers",
            type: "string",
          },
          other: {
            description:
              "Optional. Add a custom answer or context for the selected suggestion.",
            title: "Custom response",
            type: "string",
          },
        },
        type: "object",
      },
      sessionId: "s1",
    },
  ]);
  assert.equal(conn.permissionRequests.length, 0);
  assert.deepEqual(proc.extensionUiResponses, [
    { id: "ui-select", value: "Alpha\n\nA different answer" },
  ]);
});

test("MagPiAcpSession: turns an extension-provided free-form choice into a text field", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextElicitationResponse = {
    action: "accept",
    content: { other: "A custom answer" },
  };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
    supportsFormElicitation: true,
  });

  proc.emit({
    id: "ui-freeform",
    method: "select",
    options: ["Alpha", "✏️ Type custom response..."],
    title: "Pick one",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.deepEqual(requestAt(conn.elicitationRequests, 0).requestedSchema, {
    properties: {
      choice: {
        oneOf: [{ const: "Alpha", title: "Alpha" }],
        title: "Suggested answers",
        type: "string",
      },
      other: {
        description:
          "Optional. Add a custom answer or context for the selected suggestion.",
        title: "Custom response",
        type: "string",
      },
    },
    type: "object",
  });
  assert.deepEqual(proc.extensionUiResponses, [
    { id: "ui-freeform", value: "A custom answer" },
  ]);
});

test("MagPiAcpSession: handles extension confirm with ACP elicitation", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextElicitationResponse = {
    action: "accept",
    content: { choice: "no" },
  };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
    supportsFormElicitation: true,
  });

  proc.emit({
    id: "ui-confirm",
    message: "All messages will be lost.",
    method: "confirm",
    title: "Clear session?",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.equal(conn.elicitationRequests.length, 1);
  assert.deepEqual(requestPropertyAt(conn.elicitationRequests, 0, "choice"), {
    oneOf: [
      { const: "yes", title: "Yes" },
      { const: "no", title: "No" },
    ],
    title: "All messages will be lost.",
    type: "string",
  });
  assert.deepEqual(proc.extensionUiResponses, [
    { confirmed: false, id: "ui-confirm" },
  ]);
});

test("MagPiAcpSession: handles input and editor with ACP elicitation", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
    supportsFormElicitation: true,
  });

  conn.nextElicitationResponse = {
    action: "accept",
    content: { answer: "Kyle" },
  };
  proc.emit({
    id: "ui-input",
    method: "input",
    placeholder: "Your name",
    title: "Enter name",
    type: "extension_ui_request",
  });
  await delay(0);

  conn.nextElicitationResponse = {
    action: "accept",
    content: { answer: "Edited text" },
  };
  proc.emit({
    id: "ui-editor",
    method: "editor",
    prefill: "Original text",
    title: "Edit text",
    type: "extension_ui_request",
  });
  await delay(0);

  assert.deepEqual(requestPropertyAt(conn.elicitationRequests, 0, "answer"), {
    description: "Your name",
    title: "Answer",
    type: "string",
  });
  assert.deepEqual(requestPropertyAt(conn.elicitationRequests, 1, "answer"), {
    default: "Original text",
    title: "Answer",
    type: "string",
  });
  assert.deepEqual(proc.extensionUiResponses, [
    { id: "ui-input", value: "Kyle" },
    { id: "ui-editor", value: "Edited text" },
  ]);
});

test("MagPiAcpSession: cancels extension UI request when ACP elicitation is not accepted", async () => {
  const conn = new FakeAgentSideConnection();
  conn.nextElicitationResponse = {
    action: "_custom",
    content: { answer: "not accepted" },
  };
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
    supportsFormElicitation: true,
  });

  proc.emit({
    id: "ui-not-accepted",
    method: "input",
    title: "Enter name",
    type: "extension_ui_request",
  });
  await delay(0);

  assert.deepEqual(proc.extensionUiResponses, [
    { cancelled: true, id: "ui-not-accepted" },
  ]);
});

test("MagPiAcpSession: cancels unsupported input and editor extension UI requests with visible fallback", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    id: "ui-3",
    method: "input",
    title: "Enter name",
    type: "extension_ui_request",
  });
  proc.emit({
    id: "ui-4",
    method: "editor",
    title: "Edit text",
    type: "extension_ui_request",
  });

  await delay(0);

  assert.deepEqual(proc.extensionUiResponses, [
    { cancelled: true, id: "ui-3" },
    { cancelled: true, id: "ui-4" },
  ]);
  assert.equal(conn.updates.length, 2);
  assert.match(updateTextAt(conn, 0), /input UI request is not supported/u);
  assert.match(updateTextAt(conn, 1), /editor UI request is not supported/u);
});

test("MagPiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    attempt: 2,
    delayMs: 2400,
    maxAttempts: 5,
    type: "auto_retry_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]?.update, {
    content: { text: "Retrying (attempt 2/5, waiting 2s)...", type: "text" },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    attempt: 1,
    delayMs: 1,
    maxAttempts: 3,
    type: "auto_retry_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]?.update, {
    content: { text: "Retrying (attempt 1/3, waiting 1s)...", type: "text" },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    attempt: "oops",
    delayMs: "bad",
    maxAttempts: null,
    type: "auto_retry_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]?.update, {
    content: { text: "Retrying...", type: "text" },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    attempt: 1,
    delayMs: 1500,
    errorMessage: "provider overloaded: 529",
    maxAttempts: 4,
    type: "auto_retry_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "agent_message_chunk");
  assert.equal(updateTextAt(conn, 0), "Retrying (attempt 1/4, waiting 2s)...");
  assert.equal(updateTextAt(conn, 0).includes("provider overloaded"), false);
});

test("MagPiAcpSession: emits agent_message_chunk for auto_retry_end", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({ type: "auto_retry_end" });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]?.update, {
    content: { text: "Retry finished, resuming.", type: "text" },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: emits agent_message_chunk for auto_compaction_start", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({ type: "auto_compaction_start" });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]?.update, {
    content: {
      text: "Context nearing limit, running automatic compaction...",
      type: "text",
    },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: emits agent_message_chunk for auto_compaction_end", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({ type: "auto_compaction_end" });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.deepEqual(conn.updates[0]?.update, {
    content: {
      text: "Automatic compaction finished; context was summarized to continue the session.",
      type: "text",
    },
    sessionUpdate: "agent_message_chunk",
  });
});

test("MagPiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    assistantMessageEvent: { delta: "before ", type: "text_delta" },
    type: "message_update",
  });
  proc.emit({
    attempt: 1,
    delayMs: 2000,
    maxAttempts: 2,
    type: "auto_retry_start",
  });
  proc.emit({
    assistantMessageEvent: { delta: "after", type: "text_delta" },
    type: "message_update",
  });

  await delay(0);

  assert.deepEqual(
    conn.updates.map((u) => u.update),
    [
      {
        content: { text: "before ", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
      {
        content: {
          text: "Retrying (attempt 1/2, waiting 2s)...",
          type: "text",
        },
        sessionUpdate: "agent_message_chunk",
      },
      {
        content: { text: "after", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    ]
  );
});

test("MagPiAcpSession: defers tool locations until execution starts with complete path args", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    assistantMessageEvent: {
      toolCall: {
        arguments: { content: "hello", path: "/tmp/tes" },
        id: "t1",
        name: "write",
      },
      type: "toolcall_start",
    },
    type: "message_update",
  });

  proc.emit({
    assistantMessageEvent: {
      toolCall: {
        arguments: { content: "hello", path: "/tmp/test" },
        id: "t1",
        name: "write",
      },
      type: "toolcall_delta",
    },
    type: "message_update",
  });

  proc.emit({
    args: { content: "hello", path: "/tmp/test.txt" },
    toolCallId: "t1",
    toolName: "write",
    type: "tool_execution_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 3);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.equal(updateAt(conn, 0).locations, undefined);
  assert.equal(conn.updates[1]?.update.sessionUpdate, "tool_call_update");
  assert.equal(updateAt(conn, 1).locations, undefined);
  assert.equal(conn.updates[2]?.update.sessionUpdate, "tool_call_update");
  assert.deepEqual(updateAt(conn, 2).locations, [{ path: "/tmp/test.txt" }]);
});

test("MagPiAcpSession: emits edit tool line when oldText matches uniquely", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(path.join(tmpdir(), "magpi-acp-lines-"));
  const filePath = path.join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\ntwo\nneedle\nthree\n", "utf-8");

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    args: { oldText: "needle", path: "a.txt" },
    toolCallId: "t1",
    toolName: "edit",
    type: "tool_execution_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.deepEqual(updateAt(conn, 0).locations, [{ line: 3, path: filePath }]);
});

test("MagPiAcpSession: emits edit tool line from edits array when oldText matches uniquely", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(path.join(tmpdir(), "magpi-acp-lines-edits-"));
  const filePath = path.join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\ntwo\nneedle\nthree\n", "utf-8");

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    args: {
      edits: [{ newText: "replacement", oldText: "needle" }],
      path: "a.txt",
    },
    toolCallId: "t1",
    toolName: "edit",
    type: "tool_execution_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.deepEqual(updateAt(conn, 0).locations, [{ line: 3, path: filePath }]);
});

test("MagPiAcpSession: emits edit tool line from stringified edits array", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(path.join(tmpdir(), "magpi-acp-lines-edits-string-"));
  const filePath = path.join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\ntwo\nneedle\nthree\n", "utf-8");

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    args: {
      edits: JSON.stringify([{ newText: "replacement", oldText: "needle" }]),
      path: "a.txt",
    },
    toolCallId: "t1",
    toolName: "edit",
    type: "tool_execution_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.deepEqual(updateAt(conn, 0).locations, [{ line: 3, path: filePath }]);
});

test("MagPiAcpSession: omits edit tool line when oldText matches multiple times", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  const cwd = mkdtempSync(path.join(tmpdir(), "magpi-acp-lines-dup-"));
  const filePath = path.join(cwd, "a.txt");

  mkdirSync(cwd, { recursive: true });
  writeFileSync(filePath, "one\nneedle\ntwo\nneedle\n", "utf-8");

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd,
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    args: { oldText: "needle", path: "a.txt" },
    toolCallId: "t2",
    toolName: "edit",
    type: "tool_execution_start",
  });

  await delay(0);

  assert.equal(conn.updates.length, 1);
  assert.equal(conn.updates[0]?.update.sessionUpdate, "tool_call");
  assert.deepEqual(updateAt(conn, 0).locations, [{ path: filePath }]);
});

test("MagPiAcpSession: emits an ACP plan from todo extension results", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  void new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  proc.emit({
    result: {
      details: {
        tasks: [
          { id: 1, status: "completed", subject: "Explore the repository" },
          { id: 2, status: "in_progress", subject: "Implement the change" },
          { id: 3, status: "pending", subject: "Run tests" },
          { id: 4, status: "deleted", subject: "Discarded task" },
        ],
      },
    },
    toolCallId: "todo-1",
    toolName: "todo",
    type: "tool_execution_end",
  });

  await delay(0);

  assert.deepEqual(
    conn.updates.find((entry) => entry.update.sessionUpdate === "plan")?.update,
    {
      entries: [
        {
          content: "Explore the repository",
          priority: "medium",
          status: "completed",
        },
        {
          content: "Implement the change",
          priority: "medium",
          status: "in_progress",
        },
        { content: "Run tests", priority: "medium", status: "pending" },
      ],
      sessionUpdate: "plan",
    }
  );
});

test("MagPiAcpSession: prompt remains pending through multiple agent_end events until agent_settled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  let resolved = false;
  const prompt = session.prompt("hello").then((reason) => {
    resolved = true;
    return reason;
  });
  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_end" });
  await delay(0);
  assert.equal(resolved, false);

  proc.emit({ type: "agent_settled" });
  assert.equal(await prompt, "end_turn");
});

test("MagPiAcpSession: emits ACP context usage and cost after a turn", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.sessionStats = {
    contextUsage: {
      contextWindow: 128_000,
      percent: 25.0784375,
      tokens: 32_100.4,
    },
    cost: 0.1234,
  };

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  const prompt = session.prompt("hello");
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  assert.equal(await prompt, "end_turn");
  assert.deepEqual(
    conn.updates.find((entry) => entry.update.sessionUpdate === "usage_update")
      ?.update,
    {
      cost: { amount: 0.1234, currency: "USD" },
      sessionUpdate: "usage_update",
      size: 128_000,
      used: 32_100,
    }
  );
});

test("MagPiAcpSession: does not re-emit startup info on first prompt after it was already sent", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  const notice = "New version available: v0.74.0 (installed v0.73.1).";

  session.setStartupInfo(notice);
  session.sendStartupInfoIfPending();
  await delay(0);

  const p = session.prompt("hello");
  await delay(0);

  assert.equal(proc.prompts.length, 1);
  assert.equal(proc.prompts[0]?.message, "hello");
  const startupUpdates = conn.updates.filter(
    (entry) =>
      entry.update.sessionUpdate === "agent_message_chunk" &&
      asRecord(asRecord(entry.update).content).type === "text" &&
      asRecord(asRecord(entry.update).content).text === notice
  );
  assert.equal(startupUpdates.length, 1);

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const reason = await p;
  assert.equal(reason, "end_turn");
});

test("MagPiAcpSession: cancel flips stopReason to cancelled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  const p = session.prompt("hello");
  await session.cancel();
  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });
  const reason = await p;

  assert.equal(proc.abortCount, 1);
  assert.equal(reason, "cancelled");
});

test("MagPiAcpSession: queues concurrent prompt and starts it after agent_settled", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  const first = session.prompt("one");
  const second = session.prompt("two");

  assert.equal(proc.prompts.length, 1);
  assert.equal(proc.prompts[0]?.message, "one");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  await delay(0);
  assert.equal(proc.prompts.length, 1);

  proc.emit({ type: "agent_settled" });
  const r1 = await first;
  assert.equal(r1, "end_turn");

  assert.equal(proc.prompts.length, 2);
  assert.equal(proc.prompts[1]?.message, "two");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const r2 = await second;
  assert.equal(r2, "end_turn");
});

test("MagPiAcpSession: cancel clears queued prompts", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    sessionId: "s1",
  });

  const first = session.prompt("one");
  const second = session.prompt("two");

  assert.equal(proc.prompts.length, 1);

  await session.cancel();
  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });

  const r1 = await first;
  const r2 = await second;

  assert.equal(r1, "cancelled");
  assert.equal(r2, "cancelled");
});
