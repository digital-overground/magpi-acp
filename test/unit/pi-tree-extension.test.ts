import test from 'node:test'
import assert from 'node:assert/strict'
import registerMagPiAcpTree from '../../src/pi-extension/tree.js'
import {
  MAGPI_ACP_MARK_CLIENT_MESSAGE_COMMAND,
  MAGPI_ACP_REWIND_CLIENT_MESSAGE_COMMAND,
  MAGPI_ACP_TREE_COMMAND
} from '../../src/pi-rpc/tree-command.js'

type RegisteredCommand = {
  handler(args: string, context: any): Promise<void>
}

function loadTreeCommand(): RegisteredCommand {
  const registeredCommands = new Map<string, RegisteredCommand>()

  registerMagPiAcpTree({
    registerCommand(name, command) {
      registeredCommands.set(name, command)
    },
    on() {},
    appendEntry() {}
  })

  const registeredCommand = registeredCommands.get(MAGPI_ACP_TREE_COMMAND)
  assert.ok(registeredCommand)
  return registeredCommand
}

test('Pi tree extension maps an ACP client message ID and rewinds with native tree navigation', async () => {
  const commands = new Map<string, RegisteredCommand>()
  let turnStart: ((event: unknown, context: any) => void | Promise<void>) | undefined
  const customEntries: Array<{ customType: string; data: unknown }> = []

  registerMagPiAcpTree({
    registerCommand(name, command) {
      commands.set(name, command)
    },
    on(_event, handler) {
      turnStart = handler
    },
    appendEntry(customType, data) {
      customEntries.push({ customType, data })
    }
  })

  const mark = commands.get(MAGPI_ACP_MARK_CLIENT_MESSAGE_COMMAND)
  const rewind = commands.get(MAGPI_ACP_REWIND_CLIENT_MESSAGE_COMMAND)
  assert.ok(mark)
  assert.ok(rewind)
  assert.ok(turnStart)

  await mark.handler('client-message-1', {} as any)
  await turnStart({}, { sessionManager: { getLeafId: () => 'pi-user-1' } })

  assert.deepEqual(customEntries, [
    {
      customType: 'magpi-acp-client-message',
      data: { clientMessageId: 'client-message-1', userEntryId: 'pi-user-1' }
    }
  ])

  const navigations: Array<{ targetId: string; options: unknown }> = []
  await rewind.handler('client-message-1', {
    waitForIdle: async () => {},
    sessionManager: {
      getEntries: () => [
        {
          id: 'mapping-1',
          parentId: 'pi-user-1',
          type: 'custom',
          customType: 'magpi-acp-client-message',
          data: { clientMessageId: 'client-message-1', userEntryId: 'pi-user-1' }
        }
      ],
      getEntry: () => undefined
    },
    navigateTree: async (targetId: string, options: unknown) => {
      navigations.push({ targetId, options })
      return { cancelled: false }
    }
  } as any)

  assert.deepEqual(navigations, [{ targetId: 'pi-user-1', options: { summarize: false } }])
})

test('Pi tree extension navigates to a selected user message without summarizing', async () => {
  const command = loadTreeCommand()
  const notifications: string[] = []
  const navigations: Array<{ targetId: string; options: unknown }> = []
  let treeOptions: string[] = []
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString()

  await command.handler('', {
    waitForIdle: async () => {},
    sessionManager: {
      getLeafId: () => 'assistant-2',
      getTree: () => [
        {
          entry: {
            id: 'user-1',
            parentId: null,
            type: 'message',
            timestamp: fiveMinutesAgo,
            message: { role: 'user', content: [{ type: 'text', text: 'First request' }] }
          },
          children: [
            {
              entry: {
                id: 'assistant-1',
                parentId: 'user-1',
                type: 'message',
                message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] }
              },
              children: [
                {
                  entry: {
                    id: 'user-2',
                    parentId: 'assistant-1',
                    type: 'message',
                    message: { role: 'user', content: [{ type: 'text', text: 'Second request' }] }
                  },
                  children: [
                    {
                      entry: {
                        id: 'assistant-2',
                        parentId: 'user-2',
                        type: 'message',
                        message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] }
                      },
                      children: []
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    ui: {
      select: async (title: string, options: string[]) => {
        if (title.startsWith('Choose where')) {
          treeOptions = options
          return options.find(option => option.includes('Second request'))
        }
        return 'No summary'
      },
      editor: async () => undefined,
      notify: (message: string) => notifications.push(message)
    },
    navigateTree: async (targetId: string, options: unknown) => {
      navigations.push({ targetId, options })
      return { cancelled: false }
    }
  })

  assert.deepEqual(navigations, [
    {
      targetId: 'user-2',
      options: { summarize: false, customInstructions: undefined }
    }
  ])
  assert.match(notifications.at(-1) ?? '', /active context moved before/i)
  assert.match(notifications.at(-1) ?? '', /remain visible in the client/i)
  assert.equal(
    treeOptions.some(option => option.includes('↳')),
    false
  )
  assert.match(treeOptions[0] ?? '', /^You: First request · 5 mins$/)
})

test('Pi tree extension leaves the session unchanged when selection is cancelled', async () => {
  const command = loadTreeCommand()
  let navigationCount = 0

  await command.handler('', {
    waitForIdle: async () => {},
    sessionManager: {
      getLeafId: () => 'user-1',
      getTree: () => [
        {
          entry: {
            id: 'user-1',
            parentId: null,
            type: 'message',
            message: { role: 'user', content: 'First request' }
          },
          children: []
        }
      ]
    },
    ui: {
      select: async () => undefined,
      editor: async () => undefined,
      notify: () => {}
    },
    navigateTree: async () => {
      navigationCount += 1
      return { cancelled: false }
    }
  })

  assert.equal(navigationCount, 0)
})
