import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('SessionManager clones the current leaf using Pi-reported identity', async () => {
  const calls: string[] = []
  const proc = {
    dispose() {},
    async clone() {
      calls.push('clone')
    },
    async getState() {
      return { sessionFile: '/sessions/clone.jsonl', sessionId: 'clone-session' }
    }
  }
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess

  try {
    assert.equal(
      await new SessionManager().fork({
        cwd: '/workspace',
        sourceSessionFile: '/sessions/source.jsonl'
      }),
      'clone-session'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }

  assert.deepEqual(calls, ['clone'])
})

test('SessionManager validates and forks a native Pi user entry', async () => {
  const calls: string[] = []
  const proc = {
    dispose() {},
    async getForkMessages() {
      calls.push('get_fork_messages')
      return [{ entryId: 'user-1', text: 'Fork here' }]
    },
    async fork(entryId: string) {
      calls.push(`fork:${entryId}`)
    },
    async getState() {
      return { sessionFile: '/sessions/fork.jsonl', sessionId: 'fork-session' }
    }
  }
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess

  try {
    assert.equal(
      await new SessionManager().fork({
        cwd: '/workspace',
        entryId: 'user-1',
        sourceSessionFile: '/sessions/source.jsonl'
      }),
      'fork-session'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }

  assert.deepEqual(calls, ['get_fork_messages', 'fork:user-1'])
})

test('SessionManager rejects a new session without a Pi-reported identity', async () => {
  let disposed = false
  const proc = {
    dispose() {
      disposed = true
    },
    async getState() {
      return {}
    }
  }
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess

  try {
    await assert.rejects(
      new SessionManager().create({
        conn: {} as never,
        cwd: '/workspace',
        mcpServers: []
      }),
      { code: -32603 }
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }

  assert.equal(disposed, true)
})

test('SessionManager rejects entries absent from Pi native fork messages', async () => {
  let forked = false
  const proc = {
    dispose() {},
    async getForkMessages() {
      return [{ entryId: 'user-1', text: 'Fork here' }]
    },
    async fork() {
      forked = true
    }
  }
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async () => proc as unknown as PiRpcProcess

  try {
    await assert.rejects(
      new SessionManager().fork({
        cwd: '/workspace',
        entryId: 'assistant-or-stale-entry',
        sourceSessionFile: '/sessions/source.jsonl'
      }),
      { code: -32602 }
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }

  assert.equal(forked, false)
})
