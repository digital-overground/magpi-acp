import assert from 'node:assert/strict'
import test from 'node:test'
import registerMagPiAcpTree from '../../src/pi-extension/tree.js'
import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from '../../src/pi-rpc/tree-command.js'

test('Pi tree extension only bridges a native entry ID to navigateTree without summarizing', async () => {
  const commands = new Map<string, { handler(args: string, context: any): Promise<void> }>()
  registerMagPiAcpTree({
    registerCommand(name, command) {
      commands.set(name, command)
    }
  })
  assert.deepEqual([...commands.keys()], [MAGPI_ACP_NAVIGATE_TREE_COMMAND])

  const calls: unknown[] = []
  await commands.get(MAGPI_ACP_NAVIGATE_TREE_COMMAND)?.handler('pi-assistant-1', {
    waitForIdle: async () => calls.push('idle'),
    navigateTree: async (entryId: string, options: unknown) => {
      calls.push({ entryId, options })
      return { cancelled: false }
    }
  })

  assert.deepEqual(calls, ['idle', { entryId: 'pi-assistant-1', options: { summarize: false } }])
})

test('Pi tree extension reports native cancellation', async () => {
  let command: { handler(args: string, context: any): Promise<void> } | undefined
  registerMagPiAcpTree({
    registerCommand(_name, registered) {
      command = registered
    }
  })

  assert.ok(command)
  await assert.rejects(
    command.handler('pi-user-1', {
      waitForIdle: async () => {},
      navigateTree: async () => ({ cancelled: true })
    }),
    /cancelled tree navigation/i
  )
})
