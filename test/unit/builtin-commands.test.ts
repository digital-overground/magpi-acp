import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { MagPiAcpAgent, generateThreadTitle } from "../../src/acp/agent.js";
import {
  MAGPI_ACP_FORK_ENTRY_ID_META,
  MAGPI_ACP_FORK_MESSAGES_METHOD,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
  MAGPI_ACP_TREE_METHOD,
} from "../../src/pi-rpc/tree-command.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
} from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: Record<string, unknown>;
  forkParams: unknown;

  constructor(session: Record<string, unknown>) {
    this.session = session;
  }

  maybeGet(_id: string) {
    return this.session;
  }
  get(_id: string) {
    return this.session;
  }
  fork(params: unknown) {
    this.forkParams = params;
    return "forked-session";
  }
}

test("MagPiAcpAgent: /steering is handled adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ steeringMode: "one-at-a-time" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/steering", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Steering mode: one-at-a-time/u
  );
});

test("MagPiAcpAgent: /name sets session display name adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  let setTo: string | null = null;
  proc.setSessionName = (name: string) => {
    setTo = name;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/name My Session", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  assert.equal(setTo, "My Session");
  const info = conn.updates.find(
    (u) => u.update.sessionUpdate === "session_info_update"
  );
  assert.equal(
    (info?.update as { title?: unknown } | undefined)?.title,
    "My Session"
  );

  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Session name set: My Session/u
  );
});

test("MagPiAcpAgent: automatically names a thread from its first user message", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let sessionName: string | undefined;
  let titleRequest: { model?: unknown; user?: unknown } | undefined;
  const sequence: string[] = [];
  const titleEvents = new EventTarget();
  const titleApplied = once(titleEvents, "applied");

  proc.getState = () => ({
    model: { id: "gpt-5.6-sol", provider: "openai-codex" },
    sessionName,
  });
  proc.getMessages = () => ({ messages: [] });
  proc.setSessionName = (name: string) => {
    sequence.push("name");
    sessionName = name;
    titleEvents.dispatchEvent(new Event("applied"));
  };

  const session = {
    cwd: process.cwd(),
    fileCommands: [],
    proc,
    prompt: () => {
      sequence.push("prompt");
      return "end_turn";
    },
    sessionId: "s1",
    wasCancelRequested: () => false,
  };
  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
    session
  ) as never;
  (agent as unknown as { generateTitle: unknown }).generateTitle = (request: {
    model?: unknown;
    user?: unknown;
  }) => {
    sequence.push("generate");
    titleRequest = request;
    return "Fix Login Cache Bug";
  };

  await agent.prompt({
    prompt: [{ text: "fix the login caching bug", type: "text" }],
    sessionId: "s1",
  } as never);
  await titleApplied;
  await setImmediate();

  assert.deepEqual(sequence, ["prompt", "generate", "name"]);
  assert.ok(titleRequest);
  assert.equal(titleRequest.model, "openai-codex/gpt-5.6-sol");
  assert.equal(titleRequest.user, "fix the login caching bug");
  assert.equal(sessionName, "Fix Login Cache Bug");
  const info = conn.updates.find(
    (update) => update.update.sessionUpdate === "session_info_update"
  );
  assert.equal(
    (info?.update as { title?: unknown } | undefined)?.title,
    "Fix Login Cache Bug"
  );
});

test("generateThreadTitle closes stdin so Pi can process the prompt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-title-"));
  const command = path.join(dir, "fake-pi");
  const previousCommand = process.env.MAGPI_ACP_PI_COMMAND;
  writeFileSync(
    command,
    '#!/usr/bin/env node\nprocess.stdin.resume()\nprocess.stdin.on("end", () => console.log("One Two Three Four Five Six Seven"))\n'
  );
  chmodSync(command, 0o755);
  process.env.MAGPI_ACP_PI_COMMAND = command;

  try {
    assert.equal(
      await generateThreadTitle({
        cwd: dir,
        model: "test/model",
        user: "test prompt",
      }),
      "One Two Three Four Five Six"
    );
  } finally {
    if (previousCommand === undefined) {
      delete process.env.MAGPI_ACP_PI_COMMAND;
    } else {
      process.env.MAGPI_ACP_PI_COMMAND = previousCommand;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("MagPiAcpAgent: standard fork clones the current Pi leaf without metadata", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  });
  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = sessions as never;

  const response = await agent.unstable_forkSession({
    cwd: "/workspace",
    mcpServers: [],
    sessionId: "s1",
  });

  assert.deepEqual(response, { sessionId: "forked-session" });
  assert.deepEqual(sessions.forkParams, {
    cwd: "/workspace",
    entryId: undefined,
    piCommand: undefined,
    sourceSessionFile: "/sessions/source.jsonl",
  });
});

test("MagPiAcpAgent: targeted fork passes a native Pi entry ID", async () => {
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  (agent as unknown as { sessions: unknown }).sessions = sessions as never;

  await agent.unstable_forkSession({
    _meta: { [MAGPI_ACP_FORK_ENTRY_ID_META]: "pi-user-1" },
    cwd: "/workspace",
    mcpServers: [],
    sessionId: "s1",
  });

  assert.deepEqual(sessions.forkParams, {
    cwd: "/workspace",
    entryId: "pi-user-1",
    piCommand: undefined,
    sourceSessionFile: "/sessions/source.jsonl",
  });
});

test("MagPiAcpAgent: fork picker returns Pi native fork messages unchanged", async () => {
  const proc = new FakePiRpcProcess();
  const messages = [{ entryId: "pi-user-1", text: "Fix login" }];
  proc.getForkMessages = () => messages;
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  }) as never;

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_FORK_MESSAGES_METHOD, { sessionId: "s1" }),
    { messages }
  );
});

test("MagPiAcpAgent: tree picker returns Pi native tree and leaf unchanged", async () => {
  const proc = new FakePiRpcProcess();
  const tree = [{ children: [], entry: { id: "pi-user-1", type: "message" } }];
  proc.getTree = () => ({ leafId: "pi-user-1", tree });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  }) as never;

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_TREE_METHOD, { sessionId: "s1" }),
    {
      leafId: "pi-user-1",
      tree,
    }
  );
});

test("MagPiAcpAgent: tree navigation uses a native message ID and keeps the session identity", async () => {
  const proc = new FakePiRpcProcess();
  const navigations: string[] = [];
  const tree = [
    {
      children: [],
      entry: {
        id: "pi-user-1",
        message: { content: "Fix login", role: "user" },
        type: "message",
      },
    },
  ];
  proc.getTree = () => ({
    leafId: navigations.length ? "pi-user-1" : "pi-assistant-2",
    tree,
  });
  proc.getState = () => ({
    sessionFile: "/sessions/source.jsonl",
    sessionId: "s1",
  });
  proc.navigateTree = (entryId: string) => navigations.push(entryId);
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  }) as never;

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "pi-user-1",
      sessionId: "s1",
    }),
    { draft: "Fix login", leafId: "pi-user-1" }
  );
  assert.deepEqual(navigations, ["pi-user-1"]);
});

test("MagPiAcpAgent: tree navigation rejects non-message and stale entry IDs", async () => {
  const proc = new FakePiRpcProcess();
  proc.getTree = () => ({
    leafId: "compaction-1",
    tree: [{ children: [], entry: { id: "compaction-1", type: "compaction" } }],
  });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    fileCommands: [],
    proc,
    sessionId: "s1",
  }) as never;

  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "compaction-1",
      sessionId: "s1",
    }),
    { code: -32_602 }
  );
  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "foreign-entry",
      sessionId: "s1",
    }),
    { code: -32_602 }
  );
});
