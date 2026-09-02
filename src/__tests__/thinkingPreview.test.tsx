/**
 * The transcript's reasoning block: a line or two by default, the whole chain
 * of thought behind ctrl+o.
 *
 * The thinking section defaults to `expanded` so the stream is VISIBLE, and
 * reading that default as a request for the full chain printed a turn's entire
 * reasoning — hundreds of lines — above every answer.
 */
import { PassThrough } from 'node:stream'

import { renderSync } from '@makima-tui/ink'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.FORCE_COLOR = '0'
  process.env.NO_COLOR = '1'
})

import { ToolTrail } from '../components/thinking.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

const REASONING = Array.from({ length: 60 }, (_, i) => `reasoning line ${i + 1}: weighing the options at length`).join('\n')

const renderToString = (element: React.ReactElement): string => {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let output = ''

  Object.assign(stdout, { columns: 100, isTTY: false, rows: 40 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })

  const instance = renderSync(element, {
    patchConsole: false,
    stderr: stderr as never,
    stdin: stdin as never,
    stdout: stdout as never
  })

  instance.unmount()
  instance.cleanup()

  return stripAnsi(output)
}

const trail = (detailsMode: 'collapsed' | 'expanded') =>
  renderToString(React.createElement(ToolTrail, { detailsMode, reasoning: REASONING, t: DEFAULT_THEME, trail: [] }))

describe('ToolTrail reasoning', () => {
  it('shows a line or two by default, and says where the rest is', () => {
    const out = trail('collapsed')
    const body = out.split('∴ Thinking…')[1] ?? ''

    expect(out).toContain('∴ Thinking…')
    expect(out).toContain('reasoning line 1')
    expect(out).toContain('(ctrl+o to expand)')
    // the tail is not printed above the answer
    expect(out).not.toContain('reasoning line 40')
    expect(body.split('\n').filter((line) => line.trim()).length).toBeLessThanOrEqual(3)
  })

  it('gives the whole chain back under ctrl+o', () => {
    const out = trail('expanded')

    expect(out).toContain('reasoning line 1')
    expect(out).toContain('reasoning line 40')
    expect(out).not.toContain('(ctrl+o to expand)')
  })

  it('offers no expand hint when the reasoning already fits', () => {
    const out = renderToString(
      React.createElement(ToolTrail, {
        detailsMode: 'collapsed',
        reasoning: 'one short thought',
        t: DEFAULT_THEME,
        trail: []
      })
    )

    expect(out).toContain('one short thought')
    expect(out).not.toContain('(ctrl+o to expand)')
  })
})
