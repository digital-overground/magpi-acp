import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
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
  asRecord,
  replaceProperty,
} from "../helpers/fakes.js";

class FakeSessions {
  forkParams: unknown;
  private readonly session: unknown;

  constructor(session: unknown) {
    this.session = session;
  }

  maybeGet(_id: string): unknown {
    return this.session;
  }

  get(_id: string): unknown {
    return this.session;
  }

  async fork(params: unknown): Promise<string> {
    await Promise.resolve();
    this.forkParams = params;
    return "forked-session";
  }
}

const setSessions = (agent: MagPiAcpAgent, sessions: FakeSessions): void => {
  replaceProperty(agent, "sessions", sessions);
};

void test("MagPiAcpAgent: /steering is handled adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ steeringMode: "one-at-a-time" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  const res = await agent.prompt({
    prompt: [{ text: "/steering", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  const content = asRecord(asRecord(conn.updates.at(-1)?.update).content);
  assert.match(String(content.text), /Steering mode: one-at-a-time/u);
});

void test("MagPiAcpAgent: /name sets session display name adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  let setTo: string | null = null;
  proc.setSessionName = (name: string) => {
    setTo = name;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  const res = await agent.prompt({
    prompt: [{ text: "/name My Session", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  assert.equal(setTo, "My Session");
  const info = conn.updates.find(
    (message) => message.update.sessionUpdate === "session_info_update"
  );
  assert.equal(asRecord(info?.update).title, "My Session");

  const content = asRecord(asRecord(conn.updates.at(-1)?.update).content);
  assert.match(String(content.text), /Session name set: My Session/u);
});

void test("MagPiAcpAgent: leaves automatic thread naming to the client", async () => {
  const proc = new FakePiRpcProcess();
  let generated = false;
  let named = false;
  proc.getState = () => ({ model: { id: "model", provider: "test" } });
  proc.getMessages = () => ({ messages: [] });
  proc.setSessionName = () => {
    named = true;
  };

  const session = {
    cwd: process.cwd(),
    proc,
    prompt: async (): Promise<"end_turn"> => {
      await Promise.resolve();
      return "end_turn";
    },
    sessionId: "s1",
    wasCancelRequested: () => false,
  };
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions(session));
  replaceProperty(agent, "generateTitle", async () => {
    await Promise.resolve();
    generated = true;
    return "Fix Login Cache Bug";
  });

  await agent.prompt({
    prompt: [{ text: "fix the login caching bug", type: "text" }],
    sessionId: "s1",
  });
  await waitForImmediate();

  assert.equal(generated, false);
  assert.equal(named, false);
});

void test("MagPiAcpAgent: standard fork clones the current Pi leaf without metadata", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({ proc, sessionId: "s1" });
  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, sessions);

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

void test("MagPiAcpAgent: targeted fork passes a native Pi entry ID", async () => {
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({ proc, sessionId: "s1" });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, sessions);

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

void test("MagPiAcpAgent: fork picker returns Pi native fork messages unchanged", async () => {
  const proc = new FakePiRpcProcess();
  const messages = [{ entryId: "pi-user-1", text: "Fix login" }];
  proc.getForkMessages = () => messages;
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_FORK_MESSAGES_METHOD, { sessionId: "s1" }),
    { messages }
  );
});

void test("MagPiAcpAgent: tree picker returns Pi native tree and leaf unchanged", async () => {
  const proc = new FakePiRpcProcess();
  const tree = [{ children: [], entry: { id: "pi-user-1", type: "message" } }];
  proc.getTree = () => ({ leafId: "pi-user-1", tree });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_TREE_METHOD, { sessionId: "s1" }),
    {
      leafId: "pi-user-1",
      tree,
    }
  );
});

void test("MagPiAcpAgent: tree navigation uses a native message ID and keeps the session identity", async () => {
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
    leafId: navigations.length > 0 ? "pi-user-1" : "pi-assistant-2",
    tree,
  });
  proc.getState = () => ({
    sessionFile: "/sessions/source.jsonl",
    sessionId: "s1",
  });
  proc.navigateTree = (entryId: string) => {
    navigations.push(entryId);
  };
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "pi-user-1",
      sessionId: "s1",
    }),
    { draft: "Fix login", leafId: "pi-user-1" }
  );
  assert.deepEqual(navigations, ["pi-user-1"]);
});

void test("MagPiAcpAgent: tree navigation rejects non-message and stale entry IDs", async () => {
  const proc = new FakePiRpcProcess();
  proc.getTree = () => ({
    leafId: "compaction-1",
    tree: [{ children: [], entry: { id: "compaction-1", type: "compaction" } }],
  });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

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
