import { PassThrough } from 'stream'

import { Box, renderSync, stringWidth } from '@makima-tui/ink'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { Panel } from '../components/branding.js'
import { TodoPanel } from '../components/todoPanel.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderPanel(cols: number, child: React.ReactElement): Promise<string[]> {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let captured = ''

  Object.assign(stdout, { columns: cols, isTTY: false, rows: 40 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', (chunk) => {
    captured += chunk.toString()
  })

  const instance = renderSync(React.createElement(Box, { flexDirection: 'column', width: cols }, child), {
    patchConsole: false,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream
  })

  try {
    await delay(20)
    return stripAnsi(captured).split('\n').filter(Boolean)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

describe('transcript primary panels', () => {
  it('keeps a long command description in the panel width instead of collapsing it into a narrow column', async () => {
    const lines = await renderPanel(
      64,
      React.createElement(Panel, {
        sections: [
          {
            rows: [
              ['/advisor', 'Configure the advisor reviewer model (consulted mid-task by the worker) with an intentionally long description']
            ],
            title: 'Commands'
          }
        ],
        t: DEFAULT_THEME,
        title: 'Help'
      })
    )
    const commandLines = lines.filter((line) => line.includes('/advisor'))

    expect(commandLines).toHaveLength(1)
    expect(commandLines[0]).toContain('Configure')
    expect(commandLines[0]).toContain('…')
  })

  it('uses the same full transcript width for standalone todo cards', async () => {
    const cols = 64
    const lines = await renderPanel(
      cols,
      React.createElement(TodoPanel, {
        t: DEFAULT_THEME,
        todos: [{ content: 'Keep transcript cards aligned', id: 'alignment', status: 'pending' }]
      })
    )
    const borderedRows = lines.filter((line) => /[╭│╰]/.test(line))

    expect(borderedRows).not.toHaveLength(0)
    for (const row of borderedRows) {
      expect(stringWidth(row)).toBe(cols)
    }
  })
})
