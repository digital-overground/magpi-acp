import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

interface RestoredSession {
  sessionId: string;
  [key: string]: unknown;
}

interface SpawnArguments {
  cwd: string;
  piCommand?: string;
  sessionPath?: string;
}

class FakeSessions {
  private readonly buildSession: (
    sessionId: string,
    params: Record<string, unknown>
  ) => RestoredSession;
  restoredSession: RestoredSession | undefined;

  constructor(
    buildSession: (
      sessionId: string,
      params: Record<string, unknown>
    ) => RestoredSession
  ) {
    this.buildSession = buildSession;
  }

  maybeGet(sessionId: string) {
    return this.restoredSession?.sessionId === sessionId
      ? this.restoredSession
      : undefined;
  }

  getOrCreate(sessionId: string, params: Record<string, unknown>) {
    this.restoredSession ??= this.buildSession(sessionId, params);
    return this.restoredSession;
  }
}

test("MagPiAcpAgent: prompt restores a missing live session through Pi discovery", async () => {
  const conn = new FakeAgentSideConnection();
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-prompt-restore-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--store-project--");
  const sessionFile = path.join(sessionsDir, "0000_discovered.jsonl");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const promptCalls: unknown[][] = [];
  const spawnCalls: SpawnArguments[] = [];

  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ cwd: "/tmp/store-project", id: "discovered-session", type: "session" })}\n`,
    "utf-8"
  );
  process.env.PI_CODING_AGENT_DIR = root;

  const sessions = new FakeSessions((sessionId, params) => ({
    async cancel() {},
    cwd: params.cwd,
    proc: params.proc,
    prompt(...args: unknown[]) {
      promptCalls.push(args);
      return "end_turn";
    },
    sessionId,
    wasCancelRequested() {
      return false;
    },
  }));

  const originalSpawn = PiRpcProcess.spawn;
  (PiRpcProcess as unknown as { spawn: unknown }).spawn = (
    params: SpawnArguments
  ) => {
    spawnCalls.push(params);
    return {
      onEvent: () => () => {},
    } as never;
  };

  try {
    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
    (agent as unknown as { sessions: unknown }).sessions = sessions as never;

    const result = await agent.prompt({
      _meta: { "magpi-acp/client-message-id": "client-message-1" },
      prompt: [{ text: "hello again", type: "text" }],
      sessionId: "discovered-session",
    } as never);

    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(spawnCalls, [
      {
        cwd: "/tmp/store-project",
        piCommand: process.env.MAGPI_ACP_PI_COMMAND,
        sessionPath: sessionFile,
      },
    ]);
    assert.deepEqual(promptCalls, [["hello again", []]]);
  } finally {
    PiRpcProcess.spawn = originalSpawn;
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("MagPiAcpAgent: setSessionConfigOption auto-restores via Pi session discovery", async () => {
  const conn = new FakeAgentSideConnection();
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-restore-fallback-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--fallback-project--");
  const sessionFile = path.join(sessionsDir, "0000_restore_fallback.jsonl");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      cwd: "/tmp/fallback-project",
      id: "fallback-session",
      timestamp: "2026-06-16T00:00:00.000Z",
      type: "session",
      version: 3,
    })}\n`,
    "utf-8"
  );

  process.env.PI_CODING_AGENT_DIR = root;

  const setModelCalls: { provider: string; modelId: string }[] = [];
  const spawnCalls: SpawnArguments[] = [];
  const state = {
    model: { id: "alpha", provider: "test" },
    thinkingLevel: "medium",
  };

  const sessions = new FakeSessions((sessionId, params) => ({
    cwd: params.cwd,
    proc: params.proc,
    sessionId,
  }));

  const originalSpawn = PiRpcProcess.spawn;
  (PiRpcProcess as unknown as { spawn: unknown }).spawn = (
    params: SpawnArguments
  ) => {
    spawnCalls.push(params);
    return {
      getAvailableModels: () => ({
        models: [
          { id: "alpha", name: "Alpha", provider: "test" },
          { id: "beta", name: "Beta", provider: "test" },
        ],
      }),
      getState: () => state,
      onEvent: () => () => {},
      setModel(provider: string, modelId: string) {
        setModelCalls.push({ modelId, provider });
        state.model = { id: modelId, provider };
      },
    } as never;
  };

  try {
    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
    (agent as unknown as { sessions: unknown }).sessions = sessions as never;

    const result = await agent.setSessionConfigOption({
      configId: "model",
      sessionId: "fallback-session",
      value: "test/beta",
    } as never);

    assert.deepEqual(spawnCalls, [
      {
        cwd: "/tmp/fallback-project",
        piCommand: process.env.MAGPI_ACP_PI_COMMAND,
        sessionPath: sessionFile,
      },
    ]);
    assert.deepEqual(setModelCalls, [{ modelId: "beta", provider: "test" }]);
    assert.equal(
      result.configOptions.find((option) => option.id === "model")
        ?.currentValue,
      "test/beta"
    );
    assert.deepEqual(conn.updates, [
      {
        sessionId: "fallback-session",
        update: {
          configOptions: result.configOptions,
          sessionUpdate: "config_option_update",
        },
      },
    ]);
  } finally {
    PiRpcProcess.spawn = originalSpawn;
    if (prevAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  }
});

test("MagPiAcpAgent: cancel ignores stale session IDs without spawning a restore process", async () => {
  const conn = new FakeAgentSideConnection();
  const spawnCalls: SpawnArguments[] = [];

  const originalSpawn = PiRpcProcess.spawn;
  (PiRpcProcess as unknown as { spawn: unknown }).spawn = (
    params: SpawnArguments
  ) => {
    spawnCalls.push(params);
    return {
      onEvent: () => () => {},
    } as never;
  };

  try {
    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
    (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
      () => {
        throw new Error("cancel should not restore a missing session");
      }
    ) as never;

    await agent.cancel({ sessionId: "stale-session" } as never);

    assert.deepEqual(spawnCalls, []);
    assert.deepEqual(conn.updates, []);
  } finally {
    PiRpcProcess.spawn = originalSpawn;
  }
});
