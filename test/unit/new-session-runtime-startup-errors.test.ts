import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  FakeAgentSideConnection,
  asAgentConn,
  asRecord,
  replaceProperty,
} from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: Record<string, unknown>;
  closeCalls: string[] = [];

  constructor(session: Record<string, unknown>) {
    this.session = session;
  }

  async create() {
    await Promise.resolve();
    return this.session;
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId);
  }
}

void test("MagPiAcpAgent: newSession returns AUTH_REQUIRED when pi reports an auth error after spawn", async () => {
  const conn = new FakeAgentSideConnection();
  const root = mkdtempSync(path.join(tmpdir(), "magpi-acp-runtime-auth-"));
  const sessionFile = path.join(root, "sessions", "failed.jsonl");

  mkdirSync(path.join(root, "sessions"), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      cwd: process.cwd(),
      id: "s-auth",
      timestamp: "2026-05-07T00:00:00.000Z",
      type: "session",
      version: 3,
    })}\n`,
    "utf-8"
  );

  const session = {
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        await Promise.resolve();
        throw new Error("Authentication required: missing key");
      },
      async getState() {
        await Promise.resolve();
        return {
          model: null,
          sessionFile,
          thinkingLevel: "medium",
        };
      },
    },
    sessionId: "s-auth",
  };

  const sessions = new FakeSessions(session);
  const agent = new MagPiAcpAgent(asAgentConn(conn), {});
  replaceProperty(agent, "sessions", sessions);

  await assert.rejects(
    async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    },
    (error: unknown) => asRecord(error).code === -32_000
  );

  assert.deepEqual(sessions.closeCalls, ["s-auth"]);
  assert.equal(existsSync(sessionFile), false);
});

void test("MagPiAcpAgent: newSession returns Internal error on non-auth model probe failures after spawn", async () => {
  const conn = new FakeAgentSideConnection();

  const session = {
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        await Promise.resolve();
        throw new Error("socket hang up");
      },
      async getState() {
        await Promise.resolve();
        return { model: null, thinkingLevel: "medium" };
      },
    },
    sessionId: "s-internal",
  };

  const sessions = new FakeSessions(session);
  const agent = new MagPiAcpAgent(asAgentConn(conn), {});
  replaceProperty(agent, "sessions", sessions);

  await assert.rejects(
    async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    },
    (error: unknown) => {
      const details = asRecord(error);
      return (
        details.code === -32_603 &&
        typeof details.message === "string" &&
        details.message.includes("socket hang up")
      );
    }
  );

  assert.deepEqual(sessions.closeCalls, ["s-internal"]);
});
