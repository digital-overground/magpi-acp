import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { MagPiAcpAgent } from "../../src/acp/agent.js";
import {
  MAGPI_ACP_FORK_PICKER_CAPABILITY,
  MAGPI_ACP_TREE_PICKER_CAPABILITY,
} from "../../src/pi-rpc/tree-command.js";
import { FakeAgentSideConnection, asAgentConn } from "../helpers/fakes.js";

beforeEach(() => {
  delete process.env.MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT;
});

afterEach(() => {
  delete process.env.MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT;
});

const initializeWithEmbeddedContext = async (value?: string) => {
  if (value !== null) {
    process.env.MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT = value;
  }

  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  const res = await agent.initialize({ protocolVersion: 1 });

  assert.ok(res.agentCapabilities);
  assert.ok(res.agentCapabilities.promptCapabilities);
  return res.agentCapabilities.promptCapabilities.embeddedContext;
};

void test("MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: defaults embeddedContext to false when undefined", async () => {
  assert.equal(await initializeWithEmbeddedContext(), false);
});

void test("MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false' keeps embeddedContext disabled", async () => {
  assert.equal(await initializeWithEmbeddedContext("false"), false);
});

void test("MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' enables embeddedContext", async () => {
  assert.equal(await initializeWithEmbeddedContext("true"), true);
});

void test("initialize advertises optional native Pi fork and tree pickers", async () => {
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  const response = await agent.initialize({ protocolVersion: 1 });

  assert.deepEqual(response.agentCapabilities?._meta, {
    [MAGPI_ACP_FORK_PICKER_CAPABILITY]: true,
    [MAGPI_ACP_TREE_PICKER_CAPABILITY]: true,
  });
});
