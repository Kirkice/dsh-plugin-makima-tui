#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-V')) {
  console.log(pkg.version)
  process.exit(0)
}

const authCli = join(here, '..', 'dist', 'openai-codex-auth.js')
if (!existsSync(authCli)) {
  console.error('makima-tui-auth: OAuth CLI bundle is missing. Reinstall or rebuild Makima TUI.')
  process.exit(1)
}

const child = spawn(process.execPath, [authCli, ...args], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
  stdio: 'inherit'
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
