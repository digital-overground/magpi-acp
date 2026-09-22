import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
  asRecord,
  replaceProperty,
} from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: Record<string, unknown>;

  constructor(session: Record<string, unknown>) {
    this.session = session;
  }

  maybeGet(_id: string) {
    return this.session;
  }

  get(_id: string) {
    return this.session;
  }
}

const setSessions = (agent: MagPiAcpAgent, sessions: FakeSessions): void => {
  replaceProperty(agent, "sessions", sessions);
};

const lastUpdateText = (conn: FakeAgentSideConnection): string => {
  const content = asRecord(asRecord(conn.updates.at(-1)?.update).content);
  if (typeof content.text !== "string") {
    throw new TypeError("Expected a text update");
  }
  return content.text;
};

void test("MagPiAcpAgent: /steering reports current steeringMode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ steeringMode: "all" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(
    agent,
    new FakeSessions({
      proc,
      sessionId: "s1",
    })
  );

  const res = await agent.prompt({
    prompt: [{ text: "/steering", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.equal(last?.update?.sessionUpdate, "agent_message_chunk");
  assert.match(lastUpdateText(conn), /Steering mode: all/u);
});

void test("MagPiAcpAgent: /steering sets steering mode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let setTo: string | null = null;
  proc.getState = () => ({ steeringMode: "all" });
  proc.setSteeringMode = (m: string) => {
    setTo = m;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(
    agent,
    new FakeSessions({
      proc,
      sessionId: "s1",
    })
  );

  const res = await agent.prompt({
    prompt: [{ text: "/steering one-at-a-time", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(setTo, "one-at-a-time");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(lastUpdateText(conn), /Steering mode set to: one-at-a-time/u);
});

void test("MagPiAcpAgent: /steering rejects invalid value", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let called = false;
  proc.getState = () => ({ steeringMode: "all" });
  proc.setSteeringMode = () => {
    called = true;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(
    agent,
    new FakeSessions({
      proc,
      sessionId: "s1",
    })
  );

  const res = await agent.prompt({
    prompt: [{ text: "/steering nope", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(called, false);
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(lastUpdateText(conn), /Usage: \/steering/u);
});

void test("MagPiAcpAgent: /follow-up reports current followUpMode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ followUpMode: "one-at-a-time" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(
    agent,
    new FakeSessions({
      proc,
      sessionId: "s1",
    })
  );

  const res = await agent.prompt({
    prompt: [{ text: "/follow-up", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(lastUpdateText(conn), /Follow-up mode: one-at-a-time/u);
});

void test("MagPiAcpAgent: /follow-up sets follow-up mode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let setTo: string | null = null;
  proc.getState = () => ({ followUpMode: "one-at-a-time" });
  proc.setFollowUpMode = (m: string) => {
    setTo = m;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(
    agent,
    new FakeSessions({
      proc,
      sessionId: "s1",
    })
  );

  const res = await agent.prompt({
    prompt: [{ text: "/follow-up all", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(setTo, "all");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(lastUpdateText(conn), /Follow-up mode set to: all/u);
});

void test("MagPiAcpAgent: /follow-up rejects invalid value", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let called = false;
  proc.getState = () => ({ followUpMode: "one-at-a-time" });
  proc.setFollowUpMode = () => {
    called = true;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(
    agent,
    new FakeSessions({
      proc,
      sessionId: "s1",
    })
  );

  const res = await agent.prompt({
    prompt: [{ text: "/follow-up ???", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(called, false);
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(lastUpdateText(conn), /Usage: \/follow-up/u);
});
