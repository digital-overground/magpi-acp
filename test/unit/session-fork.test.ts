import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('SessionManager forks natively at the selected client message', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'magpi-acp-fork-'))
  const sourceSessionFile = join(directory, 'source.jsonl')
  writeFileSync(
    sourceSessionFile,
    [
      { type: 'session', id: 'source-session' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        message: { role: 'user', content: 'first' }
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        message: { role: 'assistant', content: 'answer' }
      },
      {
        type: 'custom',
        id: 'marker-2',
        parentId: 'assistant-1',
        customType: 'magpi-acp-client-message',
        data: { clientMessageId: 'client-message-2', userEntryId: 'assistant-1' }
      },
      {
        type: 'message',
        id: 'user-2',
        parentId: 'marker-2',
        message: { role: 'user', content: 'fork here' }
      }
    ]
      .map(entry => JSON.stringify(entry))
      .join('\n')
  )

  const forkedMessages: string[] = []
  const rewoundMessages: string[] = []
  const spawnParams: unknown[] = []
  const proc = {
    dispose() {},
    async forkClientMessage(clientMessageId: string) {
      forkedMessages.push(clientMessageId)
    },
    async getState() {
      return { sessionFile: '/sessions/fork.jsonl', sessionId: 'fork-session' }
    },
    async rewindClientMessage(clientMessageId: string) {
      rewoundMessages.push(clientMessageId)
    }
  }
  const originalSpawn = PiRpcProcess.spawn
  PiRpcProcess.spawn = async params => {
    spawnParams.push(params)
    return proc as unknown as PiRpcProcess
  }
  const stored: unknown[] = []
  const manager = new SessionManager({
    get: () => null,
    delete: () => {},
    upsert: (value: unknown) => stored.push(value)
  } as never)

  try {
    await manager.fork({
      clientMessageId: 'client-message-2',
      cwd: directory,
      sourceSessionFile
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }

  assert.deepEqual(forkedMessages, ['client-message-2'])
  assert.deepEqual(rewoundMessages, [])
  assert.deepEqual(spawnParams, [{ cwd: directory, piCommand: undefined, sessionPath: sourceSessionFile }])
  assert.deepEqual(stored, [{ cwd: directory, sessionFile: '/sessions/fork.jsonl', sessionId: 'fork-session' }])
})
