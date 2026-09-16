import { EventEmitter } from 'events'

import React from 'react'
import { describe, expect, it } from 'vitest'

import Text from './components/Text.js'
import Ink from './ink.js'
import { CURSOR_HOME, ERASE_SCREEN } from './termio/csi.js'

class FakeTty extends EventEmitter {
  chunks: string[] = []
  columns = 20
  rows = 5
  isTTY = true

  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    cb?.()

    return true
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const waitForOutput = async (stdout: FakeTty, expected: string): Promise<string> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const output = stdout.chunks.join('')

    if (output.includes(expected)) {
      return output
    }

    // A resize queues Ink.render() in a microtask, but the concurrent React
    // commit, Yoga layout callback, throttled renderer, and terminal write can
    // cross macrotask boundaries. Wait for the observable terminal effect
    // instead of assuming a fixed number of microtasks is sufficient.
    await tick()
  }

  return stdout.chunks.join('')
}

describe('Ink resize healing', () => {
  it('clears only the visible main-screen viewport before repainting a resized frame', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()

    const ink = new Ink({
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    ink.render(React.createElement(Text, null, 'a border that must reflow'))
    ink.onRender()
    expect(stdout.chunks.join('')).toContain('reflow')
    stdout.chunks = []

    stdout.columns = 14
    stdout.emit('resize')

    const output = await waitForOutput(stdout, ERASE_SCREEN + CURSOR_HOME)
    expect(output).toContain(ERASE_SCREEN + CURSOR_HOME)
    expect(output).not.toContain('\u001b[3J')
    expect(output).toContain('border')
    expect(output).toContain('reflow')

    ink.unmount()
  })

  it('treats same-dimension main-screen resize as a physical-buffer invalidation', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()

    const ink = new Ink({
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    ink.render(React.createElement(Text, null, 'stable content'))
    ink.onRender()
    expect(stdout.chunks.join('')).toContain('content')
    stdout.chunks = []

    stdout.emit('resize')

    const output = await waitForOutput(stdout, ERASE_SCREEN + CURSOR_HOME)
    expect(output).toContain(ERASE_SCREEN + CURSOR_HOME)
    expect(output).not.toContain('\u001b[3J')
    expect(output).toContain('stable')
    expect(output).toContain('content')

    ink.unmount()
  })

  it('heals same-dimension alt-screen resize events with an erase before repaint', async () => {
    const stdout = new FakeTty()
    const stdin = new FakeTty()
    const stderr = new FakeTty()

    const ink = new Ink({
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    })

    ink.setAltScreenActive(true)
    ink.render(React.createElement(Text, null, 'hello'))
    ink.onRender()
    expect(stdout.chunks.join('')).toContain('hello')
    stdout.chunks = []

    stdout.emit('resize')

    expect(await waitForOutput(stdout, ERASE_SCREEN + CURSOR_HOME)).toContain(ERASE_SCREEN + CURSOR_HOME)

    ink.unmount()
  })
})
