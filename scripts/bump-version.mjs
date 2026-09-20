import { spawnSync } from 'node:child_process'

const version = process.argv[2]
if (!version) {
  console.error('Usage: npm run bump-version <version>')
  process.exit(1)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
for (const args of [
  ['version', version, '--no-git-tag-version'],
  ['run', 'check'],
  ['run', 'smoke'],
  ['pack', '--dry-run']
]) {
  const result = spawnSync(npm, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
