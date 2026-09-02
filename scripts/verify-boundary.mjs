#!/usr/bin/env node
// Adapter-boundary gate (pattern from dsh-TUI's ADAPTER.md): only
// src/harness/** may import @deepseek-ai/*. Everything else stays
// backend-agnostic so the app survives harness upgrades untouched.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

// URL.pathname retains a leading slash before a Windows drive letter
// (for example, /h:/...). Convert through Node's platform-aware helper.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const violations = []

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)

    if (st.isDirectory()) {
      walk(path)
    } else if (/\.(ts|tsx)$/.test(name)) {
      const rel = relative(ROOT, path)

      if (rel.split(/[\\/]/).slice(0, 2).join('/') === 'src/harness') {
        continue
      }

      const body = readFileSync(path, 'utf8')
      const matches = body.match(/^\s*(?:import|export)[^'"\n]*['"](@deepseek-ai\/[^'"]+)['"]/gm) ?? []

      for (const m of matches) {
        violations.push(`${rel}: ${m.trim()}`)
      }
    }
  }
}

walk(SRC)

if (violations.length) {
  console.error('adapter boundary violated — @deepseek-ai/* imports outside src/harness/:')

  for (const v of violations) {
    console.error('  ' + v)
  }

  process.exit(1)
}

console.log('adapter boundary OK (only src/harness imports @deepseek-ai/*)')
