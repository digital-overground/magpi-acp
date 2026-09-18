import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('SessionManager clones the current leaf when no native entry is selected', async () => {
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
  const stored: unknown[] = []
  const manager = new SessionManager({
    get: () => null,
    delete: () => {},
    upsert: (value: unknown) => stored.push(value)
  } as never)

  try {
    assert.equal(
      await manager.fork({
        cwd: '/workspace',
        sourceSessionFile: '/sessions/source.jsonl'
      }),
      'clone-session'
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }

  assert.deepEqual(calls, ['clone'])
  assert.deepEqual(stored, [{ cwd: '/workspace', sessionFile: '/sessions/clone.jsonl', sessionId: 'clone-session' }])
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
  const manager = new SessionManager({ get: () => null, delete: () => {}, upsert: () => {} } as never)

  try {
    assert.equal(
      await manager.fork({
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
  const stored: unknown[] = []
  const manager = new SessionManager({
    get: () => null,
    delete: () => {},
    upsert: (value: unknown) => stored.push(value)
  } as never)

  try {
    await assert.rejects(
      manager.fork({
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
  assert.deepEqual(stored, [])
})
