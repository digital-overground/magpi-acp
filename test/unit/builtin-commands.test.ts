import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PI_ACP_TREE_COMMAND, PI_ACP_TREE_REWIND_METHOD } from '../../src/pi-rpc/tree-command.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'My Session')

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Session name set: My Session/)
})

test('PiAcpAgent: automatically names a thread from its first user message', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  let sessionName: string | undefined
  let titleRequest: any
  let titleApplied!: () => void
  const applied = new Promise<void>(resolve => {
    titleApplied = resolve
  })

  proc.getState = async () => ({
    sessionName,
    model: { provider: 'openai-codex', id: 'gpt-5.6-sol' }
  })
  proc.getMessages = async () => ({ messages: [] })
  proc.setSessionName = async (name: string) => {
    sessionName = name
    titleApplied()
  }

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    prompt: async () => 'end_turn',
    wasCancelRequested: () => false
  }
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any
  ;(agent as any).generateTitle = async (request: any) => {
    titleRequest = request
    return 'Fix Login Cache Bug'
  }

  await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'fix the login caching bug' }]
  } as any)
  await applied
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(titleRequest.model, 'openai-codex/gpt-5.6-sol')
  assert.equal(titleRequest.user, 'fix the login caching bug')
  assert.equal(sessionName, 'Fix Login Cache Bug')
  const info = conn.updates.find(update => (update as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'Fix Login Cache Bug')
})

test('PiAcpAgent: /tree invokes the bundled Pi tree command adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.commands = { commands: [{ name: PI_ACP_TREE_COMMAND }] }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/tree' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.deepEqual(proc.prompts, [{ message: `/${PI_ACP_TREE_COMMAND}`, attachments: [] }])
})

test('PiAcpAgent: /tree does not send an unloaded internal command to the model', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/tree' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.match((conn.updates.at(-1) as any).update.content.text, /tree extension did not load/i)
})

test('PiAcpAgent: tree rewind extension method delegates to Pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const response = await agent.extMethod(PI_ACP_TREE_REWIND_METHOD, {
    sessionId: 's1',
    clientMessageId: 'zed-message-1'
  })

  assert.deepEqual(response, { rewound: true })
  assert.deepEqual(proc.rewoundClientMessages, ['zed-message-1'])
})
