#!/usr/bin/env node
/** Packages the built Makima TUI bundle into a portable tarball for `dsh plugin add`. */
import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const output = resolve(root, 'dist/package')

rmSync(output, { force: true, recursive: true })
mkdirSync(output, { recursive: true })

const packed = execFileSync(platform() === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', output], {
  cwd: root,
  encoding: 'utf8',
  shell: platform() === 'win32',
  stdio: ['ignore', 'pipe', 'inherit']
}).trim()

console.log(resolve(output, packed))
