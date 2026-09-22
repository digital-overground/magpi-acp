import test from 'node:test'
import assert from 'node:assert/strict'
import { MagPiAcpAgent, generateThreadTitle } from '../../src/acp/agent.js'
import {
  MAGPI_ACP_FORK_ENTRY_ID_META,
  MAGPI_ACP_FORK_MESSAGES_METHOD,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
  MAGPI_ACP_TREE_METHOD
} from '../../src/pi-rpc/tree-command.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class FakeSessions {
  forkParams: unknown

  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
  async fork(params: unknown) {
    this.forkParams = params
    return 'forked-session'
  }
}

test('MagPiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new MagPiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('MagPiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new MagPiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

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

test('MagPiAcpAgent: automatically names a thread from its first user message', async () => {
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
    prompt: async () => 'end_turn',
    wasCancelRequested: () => false
  }
  const agent = new MagPiAcpAgent(asAgentConn(conn))
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

  assert.deepEqual(titleRequest, {
    cwd: process.cwd(),
    model: 'openai-codex/gpt-5.6-sol',
    user: 'fix the login caching bug'
  })
  assert.equal(sessionName, 'Fix Login Cache Bug')
  const info = conn.updates.find(update => (update as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'Fix Login Cache Bug')
})

test('generateThreadTitle runs a hardened one-shot Pi call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magpi-title-'))
  const command = join(dir, 'fake-pi')
  const argsPath = join(dir, 'args.json')
  const previousCommand = process.env.MAGPI_ACP_PI_COMMAND
  const previousArgsPath = process.env.MAGPI_TEST_ARGS_PATH
  writeFileSync(
    command,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.MAGPI_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)))\nprocess.stdin.resume()\nprocess.stdin.on("end", () => console.log("One Two Three Four Five Six Seven"))\n'
  )
  chmodSync(command, 0o755)
  process.env.MAGPI_ACP_PI_COMMAND = command
  process.env.MAGPI_TEST_ARGS_PATH = argsPath

  try {
    assert.equal(
      await generateThreadTitle({ cwd: dir, model: 'test/model', user: 'test prompt' }),
      'One Two Three Four Five Six'
    )
    const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[]
    for (const flag of [
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes'
    ]) {
      assert.ok(args.includes(flag), `missing ${flag}`)
    }
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'test/model'])
    assert.deepEqual(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2), ['--thinking', 'off'])
  } finally {
    if (previousCommand === undefined) delete process.env.MAGPI_ACP_PI_COMMAND
    else process.env.MAGPI_ACP_PI_COMMAND = previousCommand
    if (previousArgsPath === undefined) delete process.env.MAGPI_TEST_ARGS_PATH
    else process.env.MAGPI_TEST_ARGS_PATH = previousArgsPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MagPiAcpAgent: standard fork clones the current Pi leaf without metadata', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ sessionFile: '/sessions/source.jsonl' })
  const sessions = new FakeSessions({ sessionId: 's1', proc })
  const agent = new MagPiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = sessions as any

  const response = await agent.unstable_forkSession({
    cwd: '/workspace',
    mcpServers: [],
    sessionId: 's1'
  })

  assert.deepEqual(response, { sessionId: 'forked-session' })
  assert.deepEqual(sessions.forkParams, {
    entryId: undefined,
    cwd: '/workspace',
    piCommand: undefined,
    sourceSessionFile: '/sessions/source.jsonl'
  })
})

test('MagPiAcpAgent: targeted fork passes a native Pi entry ID', async () => {
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ sessionFile: '/sessions/source.jsonl' })
  const sessions = new FakeSessions({ sessionId: 's1', proc })
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = sessions as any

  await agent.unstable_forkSession({
    _meta: { [MAGPI_ACP_FORK_ENTRY_ID_META]: 'pi-user-1' },
    cwd: '/workspace',
    mcpServers: [],
    sessionId: 's1'
  })

  assert.deepEqual(sessions.forkParams, {
    entryId: 'pi-user-1',
    cwd: '/workspace',
    piCommand: undefined,
    sourceSessionFile: '/sessions/source.jsonl'
  })
})

test('MagPiAcpAgent: fork picker returns Pi native fork messages unchanged', async () => {
  const proc = new FakePiRpcProcess() as any
  const messages = [{ entryId: 'pi-user-1', text: 'Fix login' }]
  proc.getForkMessages = async () => messages
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  assert.deepEqual(await agent.extMethod(MAGPI_ACP_FORK_MESSAGES_METHOD, { sessionId: 's1' }), { messages })
})

test('MagPiAcpAgent: tree picker returns Pi native tree and leaf unchanged', async () => {
  const proc = new FakePiRpcProcess() as any
  const tree = [{ entry: { id: 'pi-user-1', type: 'message' }, children: [] }]
  proc.getTree = async () => ({ tree, leafId: 'pi-user-1' })
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  assert.deepEqual(await agent.extMethod(MAGPI_ACP_TREE_METHOD, { sessionId: 's1' }), {
    tree,
    leafId: 'pi-user-1'
  })
})

test('MagPiAcpAgent: tree navigation passes summary choices and keeps the session identity', async () => {
  const proc = new FakePiRpcProcess() as any
  const navigations: Array<{ entryId: string; options: unknown }> = []
  const tree = [
    {
      entry: {
        id: 'pi-user-1',
        type: 'message',
        message: { role: 'user', content: 'Fix login' }
      },
      children: []
    }
  ]
  proc.getTree = async () => ({ tree, leafId: navigations.length ? 'pi-user-1' : 'pi-assistant-2' })
  proc.getState = async () => ({ sessionFile: '/sessions/source.jsonl', sessionId: 's1' })
  proc.navigateTree = async (entryId: string, options: unknown) => navigations.push({ entryId, options })
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any
  const customInstructions = 'Focus on auth paths.\nKeep exact errors.'
  const choices = [
    { params: {}, options: { summarize: false, customInstructions: undefined } },
    { params: { summarize: false }, options: { summarize: false, customInstructions: undefined } },
    { params: { summarize: true }, options: { summarize: true, customInstructions: undefined } },
    {
      params: { summarize: true, customInstructions },
      options: { summarize: true, customInstructions }
    }
  ]

  for (const choice of choices) {
    assert.deepEqual(
      await agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
        sessionId: 's1',
        entryId: 'pi-user-1',
        ...choice.params
      }),
      { leafId: 'pi-user-1', draft: 'Fix login' }
    )
  }
  assert.deepEqual(
    navigations,
    choices.map(({ options }) => ({ entryId: 'pi-user-1', options }))
  )
})

test('MagPiAcpAgent: tree navigation rejects malformed summary options before invoking Pi', async () => {
  const proc = new FakePiRpcProcess() as any
  let piCalls = 0
  proc.getTree = async () => {
    piCalls += 1
    return { tree: [], leafId: null }
  }
  proc.getState = async () => {
    piCalls += 1
    return {}
  }
  proc.navigateTree = async () => {
    piCalls += 1
  }
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  for (const options of [{ summarize: 'true' }, { customInstructions: ['focus'] }]) {
    await assert.rejects(
      agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
        sessionId: 's1',
        entryId: 'pi-user-1',
        ...options
      }),
      { code: -32602 }
    )
  }
  assert.equal(piCalls, 0)
})

test('MagPiAcpAgent: tree navigation surfaces summary failure without changing the leaf', async () => {
  const proc = new FakePiRpcProcess() as any
  const tree = [
    {
      entry: {
        id: 'pi-user-1',
        type: 'message',
        message: { role: 'user', content: 'Fix login' }
      },
      children: []
    }
  ]
  const activeLeaf = 'pi-assistant-2'
  let attempts = 0
  proc.getTree = async () => ({ tree, leafId: activeLeaf })
  proc.getState = async () => ({ sessionFile: '/sessions/source.jsonl', sessionId: 's1' })
  proc.navigateTree = async () => {
    attempts += 1
    throw new Error('branch summary failed')
  }
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      sessionId: 's1',
      entryId: 'pi-user-1',
      summarize: true
    }),
    /branch summary failed/
  )
  assert.equal(attempts, 1)
  assert.equal((await proc.getTree()).leafId, activeLeaf)
})

test('MagPiAcpAgent: tree navigation rejects non-message and stale entry IDs', async () => {
  const proc = new FakePiRpcProcess() as any
  proc.getTree = async () => ({
    tree: [{ entry: { id: 'compaction-1', type: 'compaction' }, children: [] }],
    leafId: 'compaction-1'
  })
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      sessionId: 's1',
      entryId: 'compaction-1'
    }),
    { code: -32602 }
  )
  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      sessionId: 's1',
      entryId: 'foreign-entry'
    }),
    { code: -32602 }
  )
})
