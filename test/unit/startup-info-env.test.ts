import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: unknown;

  constructor(session: unknown) {
    this.session = session;
  }

  create(_params: unknown): Promise<unknown> {
    return Promise.resolve(this.session);
  }

  closeAllExcept = (_sessionId: string): void => {
    assert.notEqual(this.session, undefined);
  };
}

const setSessions = (agent: MagPiAcpAgent, sessions: FakeSessions): void => {
  (agent as unknown as { sessions: unknown }).sessions = sessions;
};

const timeoutOwner = globalThis as unknown as {
  setTimeout: typeof globalThis.setTimeout;
};

test("MagPiAcpAgent: startup message shows versions and tagline", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPiCommand = process.env.MAGPI_ACP_PI_COMMAND;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(
    path.join(tmpdir(), "magpi-acp-startup-")
  );
  process.env.MAGPI_ACP_PI_COMMAND = process.execPath;

  const realSetTimeout = globalThis.setTimeout;
  timeoutOwner.setTimeout = (() =>
    0) as unknown as typeof globalThis.setTimeout;

  try {
    const conn = new FakeAgentSideConnection();
    let startupInfo = "";
    const session = {
      proc: {
        getAvailableModels: () =>
          Promise.resolve({
            models: [{ id: "model", name: "model", provider: "test" }],
          }),
        getState: () =>
          Promise.resolve({
            model: { id: "model", provider: "test" },
            thinkingLevel: "medium",
          }),
      },
      sendStartupInfoIfPending() {},
      sendUsageUpdate() {},
      sessionId: "s1",
      setStartupInfo(text: string) {
        startupInfo = text;
      },
    };

    const agent = new MagPiAcpAgent(asAgentConn(conn), {});
    setSessions(agent, new FakeSessions(session));

    const result = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    assert.equal("_meta" in result, false);
    assert.match(
      startupInfo,
      /^MagPi v\d+\.\d+\.\d+\npi v\d+\.\d+\.\d+\ncollect shiny things\n/u
    );
    assert.doesNotMatch(startupInfo, /```/u);
  } finally {
    timeoutOwner.setTimeout = realSetTimeout;
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (previousPiCommand === undefined) {
      delete process.env.MAGPI_ACP_PI_COMMAND;
    } else {
      process.env.MAGPI_ACP_PI_COMMAND = previousPiCommand;
    }
  }
});

test("MagPiAcpAgent: quietStartup=true disables startup info generation/emission", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-quietstartup-"));
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ quietStartup: true }, null, 2),
    "utf-8"
  );
  process.env.PI_CODING_AGENT_DIR = dir;

  const realSetTimeout = globalThis.setTimeout;
  const timeouts: unknown[] = [];
  timeoutOwner.setTimeout = ((scheduledTask: unknown) => {
    timeouts.push(scheduledTask);
    return 0;
  }) as unknown as typeof globalThis.setTimeout;

  try {
    const conn = new FakeAgentSideConnection();

    let startupInfo: string | null = null;
    const session = {
      cwd: process.cwd(),
      proc: {
        getAvailableModels: () =>
          Promise.resolve({
            models: [{ id: "model", name: "model", provider: "test" }],
          }),
        getState: () =>
          Promise.resolve({
            model: { id: "model", provider: "test" },
            thinkingLevel: "medium",
          }),
      },
      sendStartupInfoIfPending() {},
      sessionId: "s1",
      setStartupInfo(text: string) {
        startupInfo = text;
      },
    };

    const agent = new MagPiAcpAgent(asAgentConn(conn), {});
    setSessions(agent, new FakeSessions(session));

    const result = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    assert.equal("_meta" in result, false);

    if (typeof startupInfo === "string") {
      assert.match(startupInfo, /New version available/u);
    }
    assert.equal(timeouts.length, 2);
  } finally {
    timeoutOwner.setTimeout = realSetTimeout;
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
});
