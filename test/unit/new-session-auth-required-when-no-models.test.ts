import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

class FakeSessions {
  private readonly session: Record<string, unknown>;
  closeCalls: string[] = [];

  constructor(session: Record<string, unknown>) {
    this.session = session;
  }

  create(_params: unknown) {
    return this.session;
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId);
  }
}

test("MagPiAcpAgent: newSession throws AUTH_REQUIRED when pi reports zero available models", async () => {
  const conn = new FakeAgentSideConnection();

  const session = {
    cwd: process.cwd(),
    proc: {
      getAvailableModels() {
        return Promise.resolve({ models: [] });
      },
      getState() {
        return Promise.resolve({ model: null, thinkingLevel: "medium" });
      },
    },
    sessionId: "s1",
  };

  const sessions = new FakeSessions(session);
  const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);
  (agent as unknown as { sessions: unknown }).sessions = sessions as never;

  let threw = false;
  try {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as never);
  } catch (error: unknown) {
    threw = true;
    const details = error as { code?: unknown; message?: unknown };
    assert.equal(details.code, -32_000);
    assert.match(
      String(details.message),
      /Configure an API key or log in with an OAuth provider/iu
    );
  }

  assert.equal(threw, true);
  assert.deepEqual(sessions.closeCalls, ["s1"]);
});
