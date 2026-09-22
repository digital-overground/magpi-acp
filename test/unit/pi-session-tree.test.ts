import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeSessionMessages } from '../../src/acp/pi-session-tree.js'

test('activeSessionMessages returns only messages on the latest branch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'magpi-acp-tree-'))
  const sessionFile = join(directory, 'session.jsonl')
  const entries = [
    { type: 'session', id: 'session-1' },
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      message: { role: 'user', content: 'first' }
    },
    {
      type: 'message',
      id: 'assistant-abandoned',
      parentId: 'user-1',
      message: { role: 'assistant', content: 'old answer' }
    },
    {
      type: 'message',
      id: 'user-abandoned',
      parentId: 'assistant-abandoned',
      message: { role: 'user', content: 'old follow-up' }
    },
    {
      type: 'message',
      id: 'assistant-2',
      parentId: 'user-1',
      message: { role: 'assistant', content: 'new answer' }
    },
    {
      type: 'branch_summary',
      id: 'branch-summary-1',
      parentId: 'assistant-2',
      summary: 'The abandoned branch changed the adapter.'
    },
    {
      type: 'compaction',
      id: 'compaction-1',
      parentId: 'branch-summary-1',
      summary: 'Compacted context'
    },
    {
      type: 'message',
      id: 'user-2',
      parentId: 'compaction-1',
      message: { role: 'user', content: 'new follow-up' }
    }
  ]
  writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n'))

  const messages = activeSessionMessages(sessionFile)
  assert.deepEqual(
    messages.map(entry => entry.id),
    ['user-1', 'assistant-2', 'branch-summary-1', 'user-2']
  )
  assert.deepEqual(messages[2]?.message, {
    role: 'branchSummary',
    content: 'The abandoned branch changed the adapter.'
  })
})
