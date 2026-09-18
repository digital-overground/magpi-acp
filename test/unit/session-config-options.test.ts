import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: Record<string, unknown>;

  constructor(session: Record<string, unknown>) {
    this.session = session;
  }

  create() {
    return this.session;
  }

  closeAllExcept(_sessionId: string): void {
    void this.session;
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      return;
    }
    return this.session;
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`);
    }
    return this.session;
  }
}

test("MagPiAcpAgent: newSession returns configOptions for model and thinking selectors", async () => {
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = () =>
    0 as never;

  try {
    const conn = new FakeAgentSideConnection();
    const session = {
      cwd: process.cwd(),
      proc: {
        getAvailableModels() {
          return Promise.resolve({
            models: [
              { id: "alpha", name: "Alpha", provider: "test" },
              { id: "beta", name: "Beta", provider: "test" },
            ],
          });
        },
        getState() {
          return Promise.resolve({
            model: { id: "beta", provider: "test" },
            thinkingLevel: "high",
          });
        },
      },
      sendStartupInfoIfPending() {},
      sessionId: "s1",
      setStartupInfo() {},
    };

    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
    (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
      session
    ) as never;

    const result = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    } as never);

    assert.equal(result.models?.currentModelId, "test/beta");
    assert.equal(result.modes?.currentModeId, "high");
    assert.deepEqual(
      result.configOptions.filter((option) => option.id !== "role"),
      [
        {
          category: "model",
          currentValue: "test/beta",
          description: "Select the model for this session",
          id: "model",
          name: "Model",
          options: [
            { description: null, name: "test/Alpha", value: "test/alpha" },
            { description: null, name: "test/Beta", value: "test/beta" },
          ],
          type: "select",
        },
        {
          category: "thought_level",
          currentValue: "high",
          description: "Set the reasoning effort for this session",
          id: "thought_level",
          name: "Thinking",
          options: [
            { description: null, name: "Thinking: off", value: "off" },
            { description: null, name: "Thinking: minimal", value: "minimal" },
            { description: null, name: "Thinking: low", value: "low" },
            { description: null, name: "Thinking: medium", value: "medium" },
            { description: null, name: "Thinking: high", value: "high" },
            { description: null, name: "Thinking: xhigh", value: "xhigh" },
            { description: null, name: "Thinking: max", value: "max" },
          ],
          type: "select",
        },
      ]
    );
  } finally {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout =
      realSetTimeout;
  }
});

test("MagPiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update", async () => {
  const conn = new FakeAgentSideConnection();
  const state = {
    model: { id: "alpha", provider: "test" },
    thinkingLevel: "medium",
  };
  const setModelCalls: { provider: string; modelId: string }[] = [];

  const session = {
    cwd: process.cwd(),
    proc: {
      getAvailableModels() {
        return {
          models: [
            { id: "alpha", name: "Alpha", provider: "test" },
            { id: "beta", name: "Beta", provider: "test" },
          ],
        };
      },
      getState() {
        return state;
      },
      setModel(provider: string, modelId: string) {
        setModelCalls.push({ modelId, provider });
        state.model = { id: modelId, provider };
      },
    },
    sessionId: "s1",
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
    session
  ) as never;

  const result = await agent.setSessionConfigOption({
    configId: "model",
    sessionId: "s1",
    value: "test/beta",
  } as never);

  assert.deepEqual(setModelCalls, [{ modelId: "beta", provider: "test" }]);
  assert.equal(
    result.configOptions.find((option) => option.id === "model")?.currentValue,
    "test/beta"
  );
  assert.deepEqual(conn.updates, [
    {
      sessionId: "s1",
      update: {
        configOptions: result.configOptions,
        sessionUpdate: "config_option_update",
      },
    },
  ]);
});

test("MagPiAcpAgent: role config sets the model and thinking level together", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(path.join(tmpdir(), "magpi-acp-roles-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(
    path.join(agentDir, "roles.json"),
    JSON.stringify({ build: { model: "test/beta", thinkingLevel: "high" } })
  );

  try {
    const conn = new FakeAgentSideConnection();
    const state = {
      model: { id: "alpha", provider: "test" },
      thinkingLevel: "medium",
    };
    const setModelCalls: { provider: string; modelId: string }[] = [];
    const thinkingLevels: string[] = [];
    const session = {
      cwd: process.cwd(),
      proc: {
        getAvailableModels() {
          return {
            models: [
              { id: "alpha", name: "Alpha", provider: "test" },
              { id: "beta", name: "Beta", provider: "test" },
            ],
          };
        },
        getState() {
          return state;
        },
        setModel(provider: string, modelId: string) {
          setModelCalls.push({ modelId, provider });
          state.model = { id: modelId, provider };
        },
        setThinkingLevel(level: string) {
          thinkingLevels.push(level);
          state.thinkingLevel = level;
        },
      },
      sessionId: "s1",
    };

    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
    (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
      session
    ) as never;

    const result = await agent.setSessionConfigOption({
      configId: "role",
      sessionId: "s1",
      value: "build",
    } as never);

    assert.deepEqual(setModelCalls, [{ modelId: "beta", provider: "test" }]);
    assert.deepEqual(thinkingLevels, ["high"]);
    assert.deepEqual(
      result.configOptions.map((option) => option.id),
      ["role", "model", "thought_level"]
    );
    assert.deepEqual(
      result.configOptions.find((option) => option.id === "role"),
      {
        category: "mode",
        currentValue: "build",
        description: "Switch model and thinking level together",
        id: "role",
        name: "Role",
        options: [
          {
            description: "test/beta · Thinking: high",
            name: "build",
            value: "build",
          },
        ],
        type: "select",
      }
    );
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { force: true, recursive: true });
  }
});

test("MagPiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates", async () => {
  const conn = new FakeAgentSideConnection();
  const state = {
    model: { id: "alpha", provider: "test" },
    thinkingLevel: "medium",
  };
  const thinkingLevels: string[] = [];

  const session = {
    cwd: process.cwd(),
    proc: {
      getAvailableModels() {
        return {
          models: [{ id: "alpha", name: "Alpha", provider: "test" }],
        };
      },
      getState() {
        return state;
      },
      setThinkingLevel(level: string) {
        thinkingLevels.push(level);
        state.thinkingLevel = level;
      },
    },
    sessionId: "s1",
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
  (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
    session
  ) as never;

  const result = await agent.setSessionConfigOption({
    configId: "thought_level",
    sessionId: "s1",
    value: "xhigh",
  } as never);

  assert.deepEqual(thinkingLevels, ["xhigh"]);
  assert.equal(
    result.configOptions.find((option) => option.id === "thought_level")
      ?.currentValue,
    "xhigh"
  );
  assert.deepEqual(conn.updates, [
    {
      sessionId: "s1",
      update: {
        currentModeId: "xhigh",
        sessionUpdate: "current_mode_update",
      },
    },
    {
      sessionId: "s1",
      update: {
        configOptions: result.configOptions,
        sessionUpdate: "config_option_update",
      },
    },
  ]);
});
