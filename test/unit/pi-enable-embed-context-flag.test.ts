import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PI_ACP_TREE_REWIND_CAPABILITY } from '../../src/pi-rpc/tree-command.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

beforeEach(() => {
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
})

afterEach(() => {
  delete process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT
})

async function initializeWithEmbeddedContext(value?: string) {
  if (value != null) process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT = value

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.ok(res.agentCapabilities)
  assert.ok(res.agentCapabilities.promptCapabilities)
  return res.agentCapabilities.promptCapabilities.embeddedContext
}

test('PI_ACP_ENABLE_EMBEDDED_CONTEXT: defaults embeddedContext to false when undefined', async () => {
  assert.equal(await initializeWithEmbeddedContext(), false)
})

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'false' keeps embeddedContext disabled", async () => {
  assert.equal(await initializeWithEmbeddedContext('false'), false)
})

test("PI_ACP_ENABLE_EMBEDDED_CONTEXT: 'true' enables embeddedContext", async () => {
  assert.equal(await initializeWithEmbeddedContext('true'), true)
})

test('initialize advertises Pi tree rewind support', async () => {
  const agent = new PiAcpAgent({} as any)
  const response = await agent.initialize({ protocolVersion: 1 } as any)

  assert.equal(response.agentCapabilities?._meta?.[PI_ACP_TREE_REWIND_CAPABILITY], true)
})
