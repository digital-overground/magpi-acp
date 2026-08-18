import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * We intentionally keep this separate from pi's own ~/.pi/agent/* directory.
 */
export function getMagPiAcpDir(): string {
  return join(homedir(), '.pi', 'magpi-acp')
}

export function getMagPiAcpSessionMapPath(): string {
  return join(getMagPiAcpDir(), 'session-map.json')
}
