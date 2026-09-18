import assert from "node:assert/strict";
import test from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

test("MagPiAcpAgent: newSession returns a helpful Internal error when pi is not installed", async () => {
  const prevPiCmd = process.env.MAGPI_ACP_PI_COMMAND;
  process.env.MAGPI_ACP_PI_COMMAND = "pi-does-not-exist-12345";

  try {
    const conn = new FakeAgentSideConnection();
    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as never);

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as never),
      (error: unknown) => {
        const details = error as { code?: unknown; message?: unknown } | null;
        return (
          details?.code === -32_603 &&
          String(details.message ?? "")
            .toLowerCase()
            .includes("executable not found")
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
