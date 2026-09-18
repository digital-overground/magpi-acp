import { spawn } from 'node:child_process'

const cwd = process.cwd()

// Build first so source-style invocation (node dist/index.js) works.
await new Promise((resolve, reject) => {
  const p = spawn('npm', ['run', 'build'], { stdio: 'inherit', cwd })
  p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))))
})

const child = spawn('node', ['dist/index.js'], {
  cwd,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  process.stdout.write(chunk)
})

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

// Standard ACP handshake, prompt, fork, and load. Simulate a generic client by
// stripping every private metadata field before processing agent messages.
function withoutMeta(value) {
  if (Array.isArray(value)) return value.map(withoutMeta)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '_meta')
      .map(([key, item]) => [key, withoutMeta(item)])
  )
}
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: cwd, mcpServers: [] } })

// We'll send prompt a moment later; sessionId is in response to id=2.
let sessionId = null
let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = withoutMeta(JSON.parse(line))
    } catch {
      continue
    }

    if (msg?.id === 2 && msg?.result?.sessionId && !sessionId) {
      sessionId = msg.result.sessionId
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [{ type: 'text', text: 'Say hello in one short sentence.' }]
        }
      })
    }

    if (msg?.id === 3) {
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/fork',
        params: { sessionId, cwd, mcpServers: [] }
      })
    }

    if (msg?.id === 4 && msg?.result?.sessionId) {
      send({
        jsonrpc: '2.0',
        id: 5,
        method: 'session/load',
        params: { sessionId: msg.result.sessionId, cwd, mcpServers: [] }
      })
    }

    if (msg?.id === 5) setTimeout(() => child.kill('SIGTERM'), 50)
  }
})
