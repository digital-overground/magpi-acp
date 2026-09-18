import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MagPiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('MagPiAcpAgent: loadSession restores tool arguments from their assistant calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magpi-acp-tool-restore-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '0000_s1.jsonl'),
    JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp/project' }) + '\n',
    'utf8'
  )
  process.env.PI_CODING_AGENT_DIR = root

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hello' } },
              { type: 'toolCall', id: 'call_2', name: 'read', arguments: { path: 'src/a.ts' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_2',
            toolName: 'read',
            content: [{ type: 'text', text: 'contents' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new MagPiAcpAgent(asAgentConn(conn))

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)
    const toolCall = (id: string) => updates.find(u => u?.sessionUpdate === 'tool_call' && u.toolCallId === id)
    const bash = toolCall('call_1')
    assert.ok(bash)
    assert.equal(bash.title, 'echo hello')
    assert.equal(bash.kind, 'execute')
    assert.deepEqual(bash.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(bash._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })

    const read = toolCall('call_2')
    assert.ok(read)
    assert.equal(read.title, 'read')
    assert.equal(read.kind, 'read')
    assert.deepEqual(read.rawInput, { path: 'src/a.ts' })
    assert.deepEqual(read.locations, [{ path: '/tmp/project/src/a.ts' }])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
})
