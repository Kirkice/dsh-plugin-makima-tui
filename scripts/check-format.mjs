import { spawnSync } from 'node:child_process'

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })

  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }

  return result.stdout.trim()
}

function changedFiles(base) {
  return run('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean)
}

function resolveBase() {
  if (process.env.FORMAT_BASE_REF) return process.env.FORMAT_BASE_REF

  return run('git', ['merge-base', 'HEAD', 'origin/main'])
}

const files = changedFiles(resolveBase())

if (files.length === 0) {
  console.log('No changed files require format checking.')
  process.exit(0)
}

const result = spawnSync(npx, ['biome', 'format', '--no-errors-on-unmatched', '--files-ignore-unknown=true', ...files], {
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
