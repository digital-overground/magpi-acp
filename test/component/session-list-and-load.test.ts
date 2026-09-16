import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MagPiAcpAgent } from '../../src/acp/agent.js'
import { activeSessionMessages } from '../../src/acp/pi-session-tree.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

// We mock PiRpcProcess.spawn so loadSession doesn't actually spawn `pi`.
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('MagPiAcpAgent: listSessions lists pi sessions and loadSession replays history', async () => {
  // Create a fake PI_CODING_AGENT_DIR with one session.
  const root = mkdtempSync(join(tmpdir(), 'magpi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--project--')
  const sessionFile = join(sessionsDir, '0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl')

  // Ensure parent dirs.
  mkdirSync(sessionsDir, { recursive: true })

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-02-11T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-02-11T00:00:01.000Z',
        message: { role: 'user', content: 'Hello' }
      }),
      JSON.stringify({
        type: 'message',
        id: 'b2c3d4e5',
        parentId: 'a1b2c3d4',
        timestamp: '2026-02-11T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      }),
      JSON.stringify({
        type: 'message',
        id: 'c3d4e5f6',
        parentId: 'b2c3d4e5',
        timestamp: '2026-02-11T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolName: 'todo',
          details: {
            tasks: [{ id: 1, subject: 'Verify the restored session', status: 'in_progress' }]
          }
        }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'd4e5f6a7',
        parentId: 'c3d4e5f6',
        timestamp: '2026-02-11T00:00:04.000Z',
        name: 'My Named Session'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  assert.deepEqual(
    activeSessionMessages(sessionFile).map(entry => entry.id),
    ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new MagPiAcpAgent(asAgentConn(conn))

    // 1) list sessions
    const listed = await agent.listSessions({ cwd: null, cursor: null, _meta: null } as any)
    assert.ok(listed.sessions.length >= 1)

    const s = listed.sessions.find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.cwd, '/tmp/project')
    assert.equal(s?.title, 'My Named Session')
    ;(agent as any).store = {
      get: () => ({
        sessionId: 'sess-1',
        cwd: '/tmp/project',
        sessionFile,
        updatedAt: '2026-02-11T00:00:04.000Z'
      }),
      upsert: () => {}
    }

    // 2) load session: mock spawn to return fake proc with compacted history
    const originalSpawn = PiRpcProcess.spawn

    ;(PiRpcProcess as any).spawn = async (params: any) => {
      // ensure loadSession resolves to some jsonl that ends with our expected filename
      assert.ok(typeof params.sessionPath === 'string')
      assert.ok(params.sessionPath.endsWith('/0000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jsonl'))

      return {
        onEvent: () => () => {
          // noop unsubscribe
        },
        getMessages: async () => ({
          messages: [{ role: 'user', content: 'Only the compacted context' }]
        }),
        getAvailableModels: async () => ({ models: [] }),
        getState: async () => ({ thinkingLevel: 'medium' })
      } as any
    }

    try {
      await agent.loadSession({ sessionId: 'sess-1', cwd: '/tmp/project', mcpServers: [], _meta: null } as any)

      // loadSession should have replayed messages as session/update notifications.
      const texts = conn.updates
        .map(u => (u as any).update)
        .filter(Boolean)
        .map(u => ({ kind: u.sessionUpdate, messageId: u.messageId, text: u.content?.text }))

      assert.ok(texts.some(t => t.kind === 'user_message_chunk' && t.messageId === 'a1b2c3d4' && t.text === 'Hello'))
      assert.ok(
        texts.some(t => t.kind === 'agent_message_chunk' && t.messageId === 'b2c3d4e5' && t.text === 'Hi there!')
      )
      assert.deepEqual(conn.updates.find(update => update.update.sessionUpdate === 'plan')?.update, {
        sessionUpdate: 'plan',
        entries: [{ content: 'Verify the restored session', priority: 'medium', status: 'in_progress' }]
      })
    } finally {
      PiRpcProcess.spawn = originalSpawn
    }
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
