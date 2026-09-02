#!/usr/bin/env node
// Bundles the cordis plugin (src/harness/index.ts) into dist/plugin.js.
// Everything except @deepseek-ai/* is bundled in (React, the vendored ink
// fork, the whole app), so a dsh profile needs no extra node_modules to load
// the plugin — the harness packages resolve from the profile itself.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const out = resolve(root, 'dist/plugin.js')
const authCliOut = resolve(root, 'dist/openai-codex-auth.js')

const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-devtools'
    }))
    b.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} }',
      loader: 'js'
    }))
  }
}

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'info'
}

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/harness/index.ts')],
  outfile: out,
  jsx: 'automatic',
  jsxImportSource: 'react',
  // The harness framework and services must be shared with the host process —
  // never bundled — so cordis instanceof/service identities stay unified.
  external: ['@deepseek-ai/*'],
  // Bundle the ink fork from source (the prebuilt bundle's __esm helper breaks
  // lazy-initialized exports like `render`).
  alias: { '@makima-tui/ink': resolve(root, 'packages/makima-tui-ink/src/entry-exports.ts') },
  plugins: [stubDevtools],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  }
})

await build({
  ...shared,
  entryPoints: [resolve(root, 'src/harness/openAiCodexCli.ts')],
  external: ['proper-lockfile'],
  outfile: authCliOut,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  }
})

console.log(`built ${out}`)
console.log(`built ${authCliOut}`)
