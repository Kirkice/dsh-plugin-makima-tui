// Boot wiring for the TUI inside a dsh process — the plugin-mode equivalent
// of src/entry.tsx. Everything terminal-global (mode resets, graceful exit,
// memory monitor) stays here; React is mounted on the real process streams.
import { writeFileSync } from 'node:fs'
import { createElement } from 'react'

import type { Context } from '@deepseek-ai/cordis'

import type { Config } from './index.js'
import { HarnessGatewayClient } from './client.js'

const DSH_LAUNCH_CWD_KEY = 'launchCwd'

export async function mountCcTui(ctx: Context, config: Config): Promise<void> {
  const allowNoTty = config.allowNoTty || process.env.MAKIMA_TUI_ALLOW_NO_TTY === '1'

  if (!allowNoTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('makima-tui requires an interactive terminal (set allowNoTty for headless tests)')
  }

  // The dev react-reconciler records unbounded performance marks; production
  // is the only sane default inside a long-lived TUI process.
  process.env.NODE_ENV ??= 'production'

  // Must run before chalk/supports-color initialize anywhere downstream.
  await import('../lib/forceTruecolor.js')

  const [{ INLINE_MODE, TERMUX_TUI_MODE }, { resetTerminalModes }, { setupGracefulExit }, { startMemoryMonitor }, { openExternalUrl }] =
    await Promise.all([
      import('../config/env.js'),
      import('../lib/terminalModes.js'),
      import('../lib/gracefulExit.js'),
      import('../lib/memoryMonitor.js'),
      import('../lib/openExternalUrl.js')
    ])

  const FULLSCREEN = !INLINE_MODE

  if (!allowNoTty) {
    resetTerminalModes()
    process.on('exit', () => {
      resetTerminalModes(process.stdout, FULLSCREEN)
    })

    if (TERMUX_TUI_MODE || INLINE_MODE) {
      process.stdout.write('\n')
    } else {
      process.stdout.write('\x1b[2J\x1b[H\x1b[3J')
    }
  }

  const launchCwd = ctx.get(DSH_LAUNCH_CWD_KEY) as string | undefined
  const gw = new HarnessGatewayClient(ctx, {
    cwd: config.cwd,
    launchCwd,
    model: config.model,
    profile: config.profile,
    provider: config.provider,
    sessionId: config.sessionId
  })

  gw.start()

  setupGracefulExit({
    cleanups: [
      () => {
        if (!allowNoTty) {
          resetTerminalModes(process.stdout, FULLSCREEN)
        }

        return gw.kill('graceful-exit-cleanup')
      }
    ],
    onError: (scope, err) => {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

      process.stderr.write(`makima-tui lifecycle ${scope}: ${message.slice(0, 2000)}\n`)
    },
    onSignal: signal => {
      if (!allowNoTty) {
        resetTerminalModes(process.stdout, FULLSCREEN)
      }

      process.stderr.write(`makima-tui lifecycle: received ${signal}\n`)
    }
  })

  const stopMemoryMonitor = startMemoryMonitor({
    onCritical: () => {
      process.stderr.write('makima-tui: exiting to avoid OOM; restart to recover\n')
      process.exit(137)
    },
    onHigh: () => {},
    onWarn: () => {}
  })

  process.on('beforeExit', () => stopMemoryMonitor())

  const [ink, { App }] = await Promise.all([import('@makima-tui/ink'), import('../App.js')])

  const instance = await ink.render(createElement(App, { gw }), {
    exitOnCtrlC: false,
    onHyperlinkClick: (url: string) => {
      openExternalUrl(url)
    }
  })

  // Installer/e2e readiness handshake. Process liveness is insufficient: a
  // profile can mount only background services and remain alive forever while
  // rendering no TUI. Writing after render resolves proves this plugin was
  // composed, loaded, and handed a mounted Ink instance.
  const readyFile = process.env.MAKIMA_TUI_READY_FILE
  if (readyFile) {
    writeFileSync(readyFile, `ready ${process.pid}\n`, 'utf8')
  }

  ctx.effect(() => () => {
    try {
      gw.kill('plugin-teardown')
    } catch {
      // teardown is best effort
    }

    try {
      instance.unmount()
    } catch {
      // teardown is best effort
    }
  })
}
