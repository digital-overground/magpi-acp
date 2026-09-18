import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: Record<string, unknown>;

  constructor(session: Record<string, unknown>) {
    this.session = session;
  }

  create(_params: unknown) {
    return this.session;
  }

  closeAllExcept(_sessionId: string): void {
    void this.session;
  }
}

test("MagPiAcpAgent: startup message shows versions and tagline", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPiCommand = process.env.MAGPI_ACP_PI_COMMAND;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(
    path.join(tmpdir(), "magpi-acp-startup-")
  );
  process.env.MAGPI_ACP_PI_COMMAND = process.execPath;

  const realSetTimeout = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = () =>
    0 as never;

  try {
    const conn = new FakeAgentSideConnection();
    const session = {
      proc: {
        getAvailableModels() {
          return Promise.resolve({
            models: [{ id: "model", name: "model", provider: "test" }],
          });
        },
        getState() {
          return Promise.resolve({
            model: { id: "model", provider: "test" },
            thinkingLevel: "medium",
          });
        },
      },
      sendStartupInfoIfPending() {},
      sendUsageUpdate() {},
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
    const startupInfo = result?._meta?.magPiAcp?.startupInfo ?? "";

    assert.match(
      startupInfo,
      /^MagPi v\d+\.\d+\.\d+\npi v\d+\.\d+\.\d+\ncollect shiny things\n/u
    );
    assert.doesNotMatch(startupInfo, /```/u);
  } finally {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout =
      realSetTimeout;
    if (prevAgentDir === null) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
    if (prevPiCommand === null) {
      delete process.env.MAGPI_ACP_PI_COMMAND;
    } else {
      process.env.MAGPI_ACP_PI_COMMAND = prevPiCommand;
    }
  }
});

test("MagPiAcpAgent: quietStartup=true disables startup info generation/emission", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  // Force quietStartup in pi settings by pointing PI_CODING_AGENT_DIR at a temp dir.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "magpi-acp-quietstartup-"));
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ quietStartup: true }, null, 2),
    "utf-8"
  );
  process.env.PI_CODING_AGENT_DIR = dir;

  // Spy on setTimeout calls (agent schedules startup info + available commands)
  const realSetTimeout = globalThis.setTimeout;
  const timeouts: unknown[] = [];
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = (
    fn: unknown,
    _ms?: number
  ) => {
    timeouts.push(fn);
    return 0 as never;
  };

  try {
    const conn = new FakeAgentSideConnection();

    let setStartupInfoCalled = false;
    const session = {
      cwd: process.cwd(),
      proc: {
        getAvailableModels() {
          return Promise.resolve({
            models: [{ id: "model", name: "model", provider: "test" }],
          });
        },
        getState() {
          return Promise.resolve({
            model: { id: "model", provider: "test" },
            thinkingLevel: "medium",
          });
        },
      },
      sendStartupInfoIfPending() {
        // may be called when an update notice is available
      },
      sessionId: "s1",
      setStartupInfo(_text: string) {
        setStartupInfoCalled = true;
      },
    };

    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
    (agent as unknown as { sessions: unknown }).sessions = new FakeSessions(
      session
    ) as never;

    const res = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    } as never);

    const startupInfo = res?._meta?.magPiAcp?.startupInfo ?? null;

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/u);
      assert.equal(setStartupInfoCalled, true);
    } else {
      assert.equal(setStartupInfoCalled, false);
    }
    assert.equal(timeouts.length, 2);
  } finally {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout =
      realSetTimeout;
    if (prevAgentDir === null) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  }
});
