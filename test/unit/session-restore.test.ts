import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

type SpawnParams = Parameters<typeof PiRpcProcess.spawn>[0];
interface SessionBuildParams {
  cwd: string;
  proc: PiRpcProcess;
}
type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => {
  assert.ok(value !== null && typeof value === "object");
  return value as UnknownRecord;
};

class FakeSessions {
  restoredSession: unknown;
  private readonly buildSession: (
    sessionId: string,
    params: SessionBuildParams
  ) => unknown;

  constructor(
    buildSession: (sessionId: string, params: SessionBuildParams) => unknown
  ) {
    this.buildSession = buildSession;
  }

  maybeGet(sessionId: string): unknown {
    if (this.restoredSession === undefined) {
      return undefined;
    }
    return asRecord(this.restoredSession).sessionId === sessionId
      ? this.restoredSession
      : undefined;
  }

  getOrCreate(sessionId: string, params: SessionBuildParams): unknown {
    this.restoredSession ??= this.buildSession(sessionId, params);
    return this.restoredSession;
  }
}

const processClass = PiRpcProcess as unknown as {
  spawn: typeof PiRpcProcess.spawn;
};

const setSessions = (agent: MagPiAcpAgent, sessions: FakeSessions): void => {
  (agent as unknown as { sessions: unknown }).sessions = sessions;
};

test("MagPiAcpAgent: prompt restores a missing live session through Pi discovery", async () => {
  const conn = new FakeAgentSideConnection();
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-prompt-restore-"));
  const sessionsDir = path.join(root, "sessions", "--tmp--store-project--");
  const sessionFile = path.join(sessionsDir, "0000_discovered.jsonl");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const promptCalls: unknown[][] = [];
  const spawnCalls: SpawnParams[] = [];

  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      cwd: "/tmp/store-project",
      id: "discovered-session",
      type: "session",
    })}\n`,
    "utf-8"
  );
  process.env.PI_CODING_AGENT_DIR = root;

  const sessions = new FakeSessions((sessionId, params) => ({
    cancel: () => Promise.resolve(),
    cwd: params.cwd,
    proc: params.proc,
    prompt: (...args: unknown[]) => {
      promptCalls.push(args);
      return Promise.resolve("end_turn");
    },
    sessionId,
    wasCancelRequested: () => false,
  }));

  const originalSpawn = PiRpcProcess.spawn;
  processClass.spawn = (params) => {
    spawnCalls.push(params);
    return Promise.resolve({
      onEvent: () => () => {},
    } as unknown as PiRpcProcess);
  };

  try {
    const agent = new MagPiAcpAgent(asAgentConn(conn), {});
    setSessions(agent, sessions);

    const result = await agent.prompt({
      prompt: [{ text: "hello again", type: "text" }],
      sessionId: "discovered-session",
    });

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
    processClass.spawn = originalSpawn;
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
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

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

  const setModelCalls: { modelId: string; provider: string }[] = [];
  const spawnCalls: SpawnParams[] = [];
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
  processClass.spawn = (params) => {
    spawnCalls.push(params);
    return Promise.resolve({
      getAvailableModels: () =>
        Promise.resolve({
          models: [
            { id: "alpha", name: "Alpha", provider: "test" },
            { id: "beta", name: "Beta", provider: "test" },
          ],
        }),
      getState: () => Promise.resolve(state),
      onEvent: () => () => {},
      setModel: (provider: string, modelId: string) => {
        setModelCalls.push({ modelId, provider });
        state.model = { id: modelId, provider };
        return Promise.resolve(state);
      },
    } as unknown as PiRpcProcess);
  };

  try {
    const agent = new MagPiAcpAgent(asAgentConn(conn), {});
    setSessions(agent, sessions);

    const result = await agent.setSessionConfigOption({
      configId: "model",
      sessionId: "fallback-session",
      value: "test/beta",
    });

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
    processClass.spawn = originalSpawn;
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});

test("MagPiAcpAgent: cancel ignores stale session IDs without spawning a restore process", async () => {
  const conn = new FakeAgentSideConnection();
  const spawnCalls: SpawnParams[] = [];

  const originalSpawn = PiRpcProcess.spawn;
  processClass.spawn = (params) => {
    spawnCalls.push(params);
    return Promise.resolve({
      onEvent: () => () => {},
    } as unknown as PiRpcProcess);
  };

  try {
    const agent = new MagPiAcpAgent(asAgentConn(conn), {});
    setSessions(
      agent,
      new FakeSessions(() => {
        throw new Error("cancel should not restore a missing session");
      })
    );

    await agent.cancel({ sessionId: "stale-session" });

    assert.deepEqual(spawnCalls, []);
    assert.deepEqual(conn.updates, []);
  } finally {
    processClass.spawn = originalSpawn;
  }
});
