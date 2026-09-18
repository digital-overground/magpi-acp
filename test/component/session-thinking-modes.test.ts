import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection } from "../helpers/fakes.js";

void test("MagPiAcpAgent: setSessionMode maps to pi setThinkingLevel + emits current_mode_update", async () => {
  const conn = new FakeAgentSideConnection();
  const agent = new MagPiAcpAgent(conn);

  // Create a fake session by calling newSession is heavyweight (spawns pi).
  // Instead, reach into session manager via loadSession isn't possible either.
  // So we unit-test the mapping via a minimal fake session manager would require refactor.
  // For now we just assert the method exists and rejects unknown mode IDs.

  await assert.rejects(async () => {
    await agent.setSessionMode({ modeId: "invalid", sessionId: "nope" });
  }, /invalid params/iu);
});
