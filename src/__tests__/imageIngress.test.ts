import { describe, expect, it } from 'vitest'

import { readWindowsClipboardImage } from '../harness/imageIngress.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gL+J6GXWAAAAABJRU5ErkJggg=='

describe('readWindowsClipboardImage', () => {
  it('does not invoke PowerShell outside Windows', () => {
    let invoked = false

    const image = readWindowsClipboardImage((() => {
      invoked = true
      throw new Error('should not run')
    }) as never, 'linux')

    expect(image).toBeUndefined()
    expect(invoked).toBe(false)
  })

  it('reports an empty native clipboard without treating it as an error', () => {
    const run = ((command: string, args: string[]) => {
      expect(command).toBe('powershell.exe')
      expect(args).toContain('-STA')
      return { status: 3, stderr: '', stdout: '' }
    }) as never

    expect(readWindowsClipboardImage(run, 'win32')).toBeUndefined()
  })

  it('converts Windows clipboard PNG base64 into an attachment-ready image', () => {
    const image = readWindowsClipboardImage((() => ({
      status: 0,
      stderr: '',
      stdout: `${PNG}\n`
    })) as never, 'win32')

    expect(image).toMatchObject({
      mediaType: 'image/png',
      name: 'clipboard-screenshot.png'
    })
    expect(image?.data.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('surfaces clipboard process errors with actionable detail', () => {
    expect(() => readWindowsClipboardImage((() => ({
      status: 1,
      stderr: 'clipboard is busy',
      stdout: ''
    })) as never, 'win32')).toThrow('clipboard is busy')
  })

  it('rejects successful process output that is not an image', () => {
    expect(() => readWindowsClipboardImage((() => ({
      status: 0,
      stderr: '',
      stdout: Buffer.from('not an image').toString('base64')
    })) as never, 'win32')).toThrow('invalid image')
  })
})
