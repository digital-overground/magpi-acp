import test from 'node:test'
import assert from 'node:assert/strict'
import { MagPiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

test('MagPiAcpAgent: startup message shows versions and tagline', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const prevPiCommand = process.env.MAGPI_ACP_PI_COMMAND
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'magpi-acp-startup-'))
  process.env.MAGPI_ACP_PI_COMMAND = process.execPath

  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    let startupInfo = ''
    const session = {
      sessionId: 's1',
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
        }
      },
      sendStartupInfoIfPending() {},
      sendUsageUpdate() {},
      setStartupInfo(text: string) {
        startupInfo = text
      }
    }

    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal('_meta' in result, false)
    assert.match(startupInfo, /^MagPi v\d+\.\d+\.\d+\npi v\d+\.\d+\.\d+\ncollect shiny things\n/)
    assert.doesNotMatch(startupInfo, /```/)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    if (prevPiCommand == null) delete process.env.MAGPI_ACP_PI_COMMAND
    else process.env.MAGPI_ACP_PI_COMMAND = prevPiCommand
  }
})

test('MagPiAcpAgent: quietStartup=true disables startup info generation/emission', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // Force quietStartup in pi settings by pointing PI_CODING_AGENT_DIR at a temp dir.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'magpi-acp-quietstartup-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir

  // Spy on setTimeout calls (agent schedules startup info + available commands)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()

    let startupInfo: string | null = null
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(text: string) {
        startupInfo = text
      },
      sendStartupInfoIfPending() {
        // may be called when an update notice is available
      }
    }

    const agent = new MagPiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal('_meta' in res, false)

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/)
      assert.equal(timeouts.length, 2)
    } else {
      assert.equal(timeouts.length, 2)
    }
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})
