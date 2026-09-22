import assert from 'node:assert/strict'
import test from 'node:test'
import registerMagPiAcpAskUser from '../../src/pi-extension/ask-user.js'

function loadAskUserTool(): any {
  let sessionStart: (() => void) | undefined
  let tool: unknown
  registerMagPiAcpAskUser({
    getAllTools: () => [],
    on: (_event, handler) => {
      sessionStart = handler
    },
    registerTool: registered => {
      tool = registered
    }
  })
  assert.ok(sessionStart)
  sessionStart()
  return tool
}

test('Pi ask_user extension returns the selected answer', async () => {
  const tool = loadAskUserTool()

  assert.equal(tool.name, 'ask_user')
  assert.equal(tool.executionMode, 'sequential')

  const prompts: unknown[] = []
  const result = await tool.execute(
    'ask-1',
    {
      question: 'Which option?',
      context: 'Choose the safer default.',
      options: [
        { title: 'Alpha', description: 'First option' },
        { title: 'Beta', description: 'Second option' }
      ]
    },
    undefined,
    undefined,
    {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          prompts.push({ title, options })
          return 'Beta'
        },
        input: async () => undefined
      }
    }
  )

  assert.deepEqual(prompts, [
    {
      title: 'Which option?\n\nContext:\nChoose the safer default.',
      options: ['Alpha', 'Beta', '✏️ Type custom response...']
    }
  ])
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'User answered: Beta' }],
    details: {
      question: 'Which option?',
      context: 'Choose the safer default.',
      options: [
        { title: 'Alpha', description: 'First option' },
        { title: 'Beta', description: 'Second option' }
      ],
      response: { kind: 'selection', selections: ['Beta'] },
      cancelled: false
    }
  })
})

test('Pi ask_user extension does not conflict with an installed ask_user tool', async () => {
  const registered: unknown[] = []
  let sessionStart: (() => void) | undefined

  registerMagPiAcpAskUser({
    getAllTools: () => [{ name: 'ask_user' }],
    on: (_event, handler) => {
      sessionStart = handler
    },
    registerTool: tool => registered.push(tool)
  })

  assert.deepEqual(registered, [])
  assert.ok(sessionStart)
  sessionStart()
  assert.deepEqual(registered, [])
})

test('Pi ask_user extension treats an empty response as cancellation', async () => {
  const tool = loadAskUserTool()

  const result = await tool.execute(
    'ask-2',
    { question: 'Continue?', options: [{ title: 'Yes' }] },
    undefined,
    undefined,
    {
      hasUI: true,
      ui: {
        select: async () => '   ',
        input: async () => undefined
      }
    }
  )

  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'User cancelled the question' }],
    details: {
      question: 'Continue?',
      options: [{ title: 'Yes' }],
      response: null,
      cancelled: true
    }
  })
})
