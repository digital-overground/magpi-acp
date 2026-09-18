import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "../../src/acp/session.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  mockPiSpawn,
} from "../helpers/fakes.js";

void test("SessionManager clones the current leaf using Pi-reported identity", async () => {
  const calls: string[] = [];
  const proc = new FakePiRpcProcess();
  proc.clone = () => {
    calls.push("clone");
  };
  proc.getState = () => ({
    sessionFile: "/sessions/clone.jsonl",
    sessionId: "clone-session",
  });
  const restoreSpawn = mockPiSpawn(async () => {
    await Promise.resolve();
    return proc.process;
  });

  try {
    assert.equal(
      await new SessionManager().fork({
        cwd: "/workspace",
        sourceSessionFile: "/sessions/source.jsonl",
      }),
      "clone-session"
    );
  } finally {
    restoreSpawn();
  }

  assert.deepEqual(calls, ["clone"]);
});

void test("SessionManager validates and forks a native Pi user entry", async () => {
  const calls: string[] = [];
  const proc = new FakePiRpcProcess();
  proc.fork = (entryId) => {
    calls.push(`fork:${entryId}`);
  };
  proc.getForkMessages = () => {
    calls.push("get_fork_messages");
    return [{ entryId: "user-1", text: "Fork here" }];
  };
  proc.getState = () => ({
    sessionFile: "/sessions/fork.jsonl",
    sessionId: "fork-session",
  });
  const restoreSpawn = mockPiSpawn(async () => {
    await Promise.resolve();
    return proc.process;
  });

  try {
    assert.equal(
      await new SessionManager().fork({
        cwd: "/workspace",
        entryId: "user-1",
        sourceSessionFile: "/sessions/source.jsonl",
      }),
      "fork-session"
    );
  } finally {
    restoreSpawn();
  }

  assert.deepEqual(calls, ["get_fork_messages", "fork:user-1"]);
});

void test("SessionManager rejects a new session without a Pi-reported identity", async () => {
  const proc = new FakePiRpcProcess();
  let disposed = false;
  proc.getState = () => ({});
  proc.process.dispose = () => {
    disposed = true;
  };
  const restoreSpawn = mockPiSpawn(async () => {
    await Promise.resolve();
    return proc.process;
  });

  try {
    await assert.rejects(
      new SessionManager().create({
        conn: new FakeAgentSideConnection(),
        cwd: "/workspace",
        mcpServers: [],
      }),
      { code: -32_603 }
    );
  } finally {
    restoreSpawn();
  }

  assert.equal(disposed, true);
});

void test("SessionManager rejects entries absent from Pi native fork messages", async () => {
  const proc = new FakePiRpcProcess();
  let forked = false;
  proc.fork = () => {
    forked = true;
  };
  proc.getForkMessages = () => [{ entryId: "user-1", text: "Fork here" }];
  const restoreSpawn = mockPiSpawn(async () => {
    await Promise.resolve();
    return proc.process;
  });

  try {
    await assert.rejects(
      new SessionManager().fork({
        cwd: "/workspace",
        entryId: "assistant-or-stale-entry",
        sourceSessionFile: "/sessions/source.jsonl",
      }),
      { code: -32_602 }
    );
  } finally {
    restoreSpawn();
  }

  assert.equal(forked, false);
});
