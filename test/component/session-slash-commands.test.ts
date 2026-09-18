import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpSession } from "../../src/acp/session.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
} from "../helpers/fakes.js";

test("MagPiAcpSession: expands /command before sending to pi", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  const session = new MagPiAcpSession({
    conn: asAgentConn(conn),
    cwd: process.cwd(),
    fileCommands: [
      {
        content: "Expanded $1",
        description: "(user)",
        name: "hello",
        source: "(user)",
      },
    ],
    mcpServers: [],
    proc: proc as never,
    sessionId: "s1",
  });

  const p = session.prompt("/hello world");

  proc.emit({ type: "agent_start" });
  proc.emit({ type: "turn_end" });
  proc.emit({ type: "agent_end" });
  proc.emit({ type: "agent_settled" });
  const reason = await p;

  assert.equal(reason, "end_turn");
  assert.equal(proc.prompts.length, 1);
  assert.equal(proc.prompts.at(0)?.message, "Expanded world");
});
