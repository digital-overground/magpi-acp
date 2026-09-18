import test from 'node:test'
import assert from 'node:assert/strict'
import { MagPiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('MagPiAcpSession: passes slash commands to Pi for native expansion', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new MagPiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })

  const p = session.prompt('/hello world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(reason, 'end_turn')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, '/hello world')
})
