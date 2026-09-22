import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  FakeAgentSideConnection,
  asAgentConn,
  asRecord,
} from "../helpers/fakes.js";

void test("MagPiAcpAgent: newSession returns a helpful Internal error when pi is not installed", async () => {
  const prevPiCmd = process.env.MAGPI_ACP_PI_COMMAND;
  process.env.MAGPI_ACP_PI_COMMAND = "pi-does-not-exist-12345";

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn), {});

    await assert.rejects(
      async () => {
        await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      },
      (error: unknown) => {
        const details = asRecord(error);
        return (
          details.code === -32_603 &&
          typeof details.message === "string" &&
          details.message.toLowerCase().includes("executable not found")
        );
      }
    );
  } finally {
    if (prevPiCmd === null) {
      delete process.env.MAGPI_ACP_PI_COMMAND;
    } else {
      process.env.MAGPI_ACP_PI_COMMAND = prevPiCmd;
    }
  }
});
