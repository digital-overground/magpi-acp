import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import registerMagPiAcpTree from '../../src/pi-extension/tree.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from '../../src/pi-rpc/tree-command.js'

test('Pi tree extension passes every summary choice to navigateTree', async () => {
  const commands = new Map<string, { handler(args: string, context: any): Promise<void> }>()
  registerMagPiAcpTree({
    registerCommand(name, command) {
      commands.set(name, command)
    }
  })
  assert.deepEqual([...commands.keys()], [MAGPI_ACP_NAVIGATE_TREE_COMMAND])

  const command = commands.get(MAGPI_ACP_NAVIGATE_TREE_COMMAND)
  assert.ok(command)
  const calls: unknown[] = []
  const context = {
    waitForIdle: async () => calls.push('idle'),
    navigateTree: async (entryId: string, options: unknown) => {
      calls.push({ entryId, options })
      return { cancelled: false }
    }
  }
  const customInstructions = 'Keep "quoted" details.\nFocus on paths.'

  await command.handler(JSON.stringify({ entryId: 'pi-assistant-1', summarize: false }), context)
  await command.handler(JSON.stringify({ entryId: 'pi-assistant-1', summarize: true }), context)
  await command.handler(JSON.stringify({ entryId: 'pi-assistant-1', summarize: true, customInstructions }), context)

  assert.deepEqual(calls, [
    'idle',
    {
      entryId: 'pi-assistant-1',
      options: { summarize: false, customInstructions: undefined }
    },
    'idle',
    {
      entryId: 'pi-assistant-1',
      options: { summarize: true, customInstructions: undefined }
    },
    'idle',
    {
      entryId: 'pi-assistant-1',
      options: { summarize: true, customInstructions }
    }
  ])
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
    command.handler(JSON.stringify({ entryId: 'pi-user-1', summarize: false }), {
      waitForIdle: async () => {},
      navigateTree: async () => ({ cancelled: true })
    }),
    /cancelled tree navigation/i
  )
})

test('Pi tree extension surfaces a summary failure without retrying', async () => {
  let command: { handler(args: string, context: any): Promise<void> } | undefined
  registerMagPiAcpTree({
    registerCommand(_name, registered) {
      command = registered
    }
  })

  assert.ok(command)
  let attempts = 0
  await assert.rejects(
    command.handler(JSON.stringify({ entryId: 'pi-user-1', summarize: true }), {
      waitForIdle: async () => {},
      navigateTree: async () => {
        attempts += 1
        throw new Error('summary failed')
      }
    }),
    /summary failed/
  )
  assert.equal(attempts, 1)
})

test('Pi RPC tree navigation completes without an agent_settled event', async () => {
  let prompt = ''
  const proc = Object.create(PiRpcProcess.prototype) as PiRpcProcess
  ;(proc as any).onEvent = () => () => {}
  ;(proc as any).prompt = async (message: string) => {
    prompt = message
  }

  const customInstructions = 'Preserve whitespace:\n  exact'
  await Promise.race([
    proc.navigateTree('pi-assistant-1', { summarize: true, customInstructions }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Tree navigation stayed pending.')), 50))
  ])

  assert.equal(
    prompt,
    `/${MAGPI_ACP_NAVIGATE_TREE_COMMAND} ${JSON.stringify({
      entryId: 'pi-assistant-1',
      summarize: true,
      customInstructions
    })}`
  )
})

test('Pi RPC tree navigation surfaces extension errors without an agent_settled event', async () => {
  let emit: (event: Record<string, unknown>) => void = () => {}
  const proc = Object.create(PiRpcProcess.prototype) as PiRpcProcess
  ;(proc as any).onEvent = (handler: typeof emit) => {
    emit = handler
    return () => {}
  }
  ;(proc as any).prompt = async () => {
    emit({ type: 'extension_error', error: 'summary failed' })
  }

  await assert.rejects(proc.navigateTree('pi-assistant-1', { summarize: true }), /summary failed/)
})

test('Pi RPC rejects a closed stdin write without crashing MagPi', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "require('node:fs').closeSync(0); console.log('ready'); setTimeout(() => {}, 10_000)"],
    { stdio: 'pipe' }
  )
  const proc = Reflect.construct(PiRpcProcess, [child]) as PiRpcProcess

  try {
    await once(child.stdout, 'data')
    await assert.rejects(proc.getState(), /EPIPE|closed|destroyed/i)
  } finally {
    proc.dispose()
  }
})
