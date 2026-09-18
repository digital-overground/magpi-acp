import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MagPiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('MagPiAcpAgent: does not emit startup info on loadSession', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magpi-acp-startup-load-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    join(sessionsDir, '0000_s1.jsonl'),
    JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp/project' }) + '\n',
    'utf8'
  )
  process.env.PI_CODING_AGENT_DIR = root

  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new MagPiAcpAgent(asAgentConn(conn))

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.magPiAcp?.startupInfo, null)

    // Only available_commands_update should be scheduled.
    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
})
