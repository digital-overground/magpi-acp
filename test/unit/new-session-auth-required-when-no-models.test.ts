import assert from "node:assert/strict";
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

  async create(_params: unknown) {
    await Promise.resolve();
    return this.session;
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId);
  }
}

void test("MagPiAcpAgent: newSession throws AUTH_REQUIRED when pi reports zero available models", async () => {
  const conn = new FakeAgentSideConnection();

  const session = {
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        await Promise.resolve();
        return { models: [] };
      },
      async getState() {
        await Promise.resolve();
        return { model: null, thinkingLevel: "medium" };
      },
    },
    sessionId: "s1",
  };

  const sessions = new FakeSessions(session);
  const agent = new MagPiAcpAgent(asAgentConn(conn), {});
  replaceProperty(agent, "sessions", sessions);

  let threw = false;
  try {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  } catch (error: unknown) {
    threw = true;
    const details = asRecord(error);
    assert.equal(details.code, -32_000);
    assert.match(
      typeof details.message === "string" ? details.message : "",
      /Configure an API key or log in with an OAuth provider/iu
    );
  }

  assert.equal(threw, true);
  assert.deepEqual(sessions.closeCalls, ["s1"]);
});
