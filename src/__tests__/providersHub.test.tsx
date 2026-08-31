import { PassThrough } from 'node:stream'

import { renderSync } from '@makima-tui/ink'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ProvidersHub } from '../components/providersHub.js'
import { stripAnsi } from '../lib/text.js'
import { DEFAULT_THEME } from '../theme.js'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ENTER = '\r'
const ESC = '\u001b'

const BSU = '\u001b[?2026h'
const ESU = '\u001b[?2026l'

const lastFrame = (output: string): string => {
  const frames = output
    .split(BSU)
    .map(chunk => chunk.split(ESU)[0] ?? '')
    .filter(frame => stripAnsi(frame).trim() !== '')

  return stripAnsi(frames.at(-1) ?? '')
}

function mount() {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let output = ''
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const onClose = vi.fn()

  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  Object.assign(stdout, { columns: 100, rows: 40 })
  Object.assign(stdin, { isTTY: true, ref: () => {}, setRawMode: () => {}, unref: () => {} })

  const gw = {
    request: (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })

      if (method === 'providers.list') {
        return Promise.resolve({
          current_provider: 'makima-demo',
          items: [
            {
              api: 'openai-completions',
              base_url: 'https://api.example.test/v1',
              credential_configured: true,
              current: true,
              display_name: 'Demo API',
              id: 'makima-demo',
              models: ['demo-1'],
              removable: true,
              type: 'api_key'
            },
            {
              display_name: 'OpenAI ChatGPT / Codex',
              id: 'openai-codex',
              models: [],
              removable: false,
              type: 'oauth'
            }
          ],
          protocols: ['openai-completions', 'openai-responses']
        })
      }

      if (method === 'providers.saveOpenAiCompatible') {
        return Promise.resolve({ id: String(params.id ?? 'makima-new'), saved: true })
      }

      if (method === 'providers.remove') {
        return Promise.resolve({ id: params.id, removed: true })
      }

      if (method === 'llm.openAiCodex.status') {
        return Promise.resolve({ authenticated: false, device_code_available: true })
      }

      if (method === 'llm.openAiCodex.login') {
        return Promise.resolve({ authorization_url: 'https://auth.example.test/authorize', login_pending: true })
      }

      return Promise.resolve({})
    }
  }

  const app = renderSync(
    React.createElement(ProvidersHub, { gw: gw as never, onClose, t: DEFAULT_THEME }),
    {
      exitOnCtrlC: false,
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    }
  )

  return {
    frame: () => lastFrame(output),
    onClose,
    press: async (input: string, settle = 40) => {
      stdin.write(input)
      await delay(settle)
    },
    requests,
    unmount: () => app.unmount()
  }
}

describe('ProvidersHub', () => {
  it('shows provider routes and opens the OAuth controls', async () => {
    const hub = mount()
    await delay(40)

    expect(hub.frame()).toContain('Demo API')
    expect(hub.frame()).toContain('/provider switches quickly')

    await hub.press('o')

    expect(hub.frame()).toContain('ChatGPT / Codex')
    expect(hub.frame()).toContain('b browser login')

    await hub.press('b')
    expect(hub.requests).toContainEqual({ method: 'llm.openAiCodex.login', params: { method: 'browser' } })
    hub.unmount()
  })

  it('edits an owned provider without sending a stored API key back to the host', async () => {
    const hub = mount()
    await delay(40)
    await hub.press(ENTER)

    expect(hub.frame()).toContain('Edit OpenAI-compatible provider')
    expect(hub.frame()).toContain('stored; leave blank to keep')

    await hub.press('s')

    const save = hub.requests.find(request => request.method === 'providers.saveOpenAiCompatible')
    expect(save?.params).toMatchObject({
      api: 'openai-completions',
      api_key: '',
      base_url: 'https://api.example.test/v1',
      display_name: 'Demo API',
      id: 'makima-demo',
      image_models: [],
      models: ['demo-1']
    })
    hub.unmount()
  })

  it('saves an explicit image-capable model declaration', async () => {
    const hub = mount()
    await delay(40)
    await hub.press(ENTER)
    await hub.press('\t')
    await hub.press('\t')
    await hub.press('\t')
    await hub.press('\t')
    await hub.press('demo-1')
    await hub.press('s')

    const save = hub.requests.find(request => request.method === 'providers.saveOpenAiCompatible')
    expect(save?.params).toMatchObject({ image_models: ['demo-1'], models: ['demo-1'] })
    hub.unmount()
  })

  it('requires confirmation before removing an owned provider', async () => {
    const hub = mount()
    await delay(40)
    await hub.press(ENTER)
    await hub.press('x')

    expect(hub.frame()).toContain('Remove provider?')

    await hub.press(ENTER)
    expect(hub.requests.some(request => request.method === 'providers.remove')).toBe(false)

    await hub.press('x')
    await hub.press('\u001b[C')
    await hub.press(ENTER)

    expect(hub.requests).toContainEqual({ method: 'providers.remove', params: { id: 'makima-demo' } })
    hub.unmount()
  })

  it('closes from the provider list', async () => {
    const hub = mount()
    await delay(40)
    await hub.press(ESC, 200)

    expect(hub.onClose).toHaveBeenCalledOnce()
    hub.unmount()
  })
})
