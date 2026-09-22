import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test('Pi RPC loads both bundled extensions', { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'magpi-pi-extensions-'))
  const argsPath = join(directory, 'args.json')
  const fakePi = join(directory, 'pi')
  const previousArgsPath = process.env.MAGPI_TEST_PI_ARGS_PATH
  t.after(() => {
    if (previousArgsPath === undefined) delete process.env.MAGPI_TEST_PI_ARGS_PATH
    else process.env.MAGPI_TEST_PI_ARGS_PATH = previousArgsPath
    rmSync(directory, { recursive: true, force: true })
  })

  writeFileSync(
    fakePi,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.MAGPI_TEST_PI_ARGS_PATH, JSON.stringify(process.argv.slice(2)))
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\\n')
    if (newline < 0) break
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: command.id,
      command: command.type,
      success: true,
      data: {}
    }) + '\\n')
  }
})
`
  )
  chmodSync(fakePi, 0o755)
  process.env.MAGPI_TEST_PI_ARGS_PATH = argsPath

  const proc = await PiRpcProcess.spawn({ cwd: process.cwd(), piCommand: fakePi })
  try {
    const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[]
    const extensions = args.flatMap((arg, index) => (arg === '--extension' ? [args[index + 1]] : []))

    assert.equal(extensions.length, 2)
    assert.match(extensions[0]!, /(?:pi-tree-extension\.js|pi-extension[/\\]tree\.ts)$/)
    assert.match(extensions[1]!, /(?:pi-ask-user-extension\.js|pi-extension[/\\]ask-user\.ts)$/)
  } finally {
    proc.dispose()
  }
})
