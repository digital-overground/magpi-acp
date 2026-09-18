import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
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

test("MagPiAcpAgent: /steering reports current steeringMode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ steeringMode: "all" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/steering", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.equal(last?.update?.sessionUpdate, "agent_message_chunk");
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Steering mode: all/u
  );
});

test("MagPiAcpAgent: /steering sets steering mode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let setTo: string | null = null;
  proc.getState = () => ({ steeringMode: "all" });
  proc.setSteeringMode = (m: string) => {
    setTo = m;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/steering one-at-a-time", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  assert.equal(setTo, "one-at-a-time");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Steering mode set to: one-at-a-time/u
  );
});

test("MagPiAcpAgent: /steering rejects invalid value", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let called = false;
  proc.getState = () => ({ steeringMode: "all" });
  proc.setSteeringMode = () => {
    called = true;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/steering nope", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  assert.equal(called, false);
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Usage: \/steering/u
  );
});

test("MagPiAcpAgent: /follow-up reports current followUpMode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ followUpMode: "one-at-a-time" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/follow-up", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Follow-up mode: one-at-a-time/u
  );
});

test("MagPiAcpAgent: /follow-up sets follow-up mode", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let setTo: string | null = null;
  proc.getState = () => ({ followUpMode: "one-at-a-time" });
  proc.setFollowUpMode = (m: string) => {
    setTo = m;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/follow-up all", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  assert.equal(setTo, "all");
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Follow-up mode set to: all/u
  );
});

test("MagPiAcpAgent: /follow-up rejects invalid value", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let called = false;
  proc.getState = () => ({ followUpMode: "one-at-a-time" });
  proc.setFollowUpMode = () => {
    called = true;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions({
    proc,
    sessionId: "s1",
  }) as never;

  const res = await agent.prompt({
    prompt: [{ text: "/follow-up ???", type: "text" }],
    sessionId: "s1",
  } as never);

  assert.equal(res.stopReason, "end_turn");
  assert.equal(called, false);
  const last = conn.updates.at(-1);
  assert.ok(last);
  assert.match(
    (last.update as { content: { text: string } }).content.text,
    /Usage: \/follow-up/u
  );
});
