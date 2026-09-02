import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same fake-child harness as fusionModel.test.ts: the adapter spawns
// `clawcodex agent-server --stdio`, so the test feeds protocol lines on the
// fake stdout and answers the control_requests it sees on stdin.
const harness = vi.hoisted(() => ({ proc: null as null | EventEmitter, spawnCalls: [] as unknown[][] }))

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    harness.spawnCalls.push(args)

    return harness.proc
  }
}))

import { GatewayClient } from '../gatewayClient.js'

class FakeProc extends EventEmitter {
  kill = vi.fn()
  stderr = new PassThrough()
  stdin = new PassThrough()
  stdout = new PassThrough()

  line(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n')
  }
}

describe('/vision', () => {
  const prevWs = process.env.MAKIMA_TUI_WORKSPACE
  let gw: GatewayClient
  let proc: FakeProc
  let seen: any[]

  beforeEach(() => {
    process.env.MAKIMA_TUI_WORKSPACE = '/ws'
    proc = new FakeProc()
    harness.proc = proc
    harness.spawnCalls = []
    seen = []
    gw = new GatewayClient()
    gw.start()
    gw.drain()
  })

  afterEach(() => {
    gw.kill()
    if (prevWs === undefined) {
      delete process.env.MAKIMA_TUI_WORKSPACE
    } else {
      process.env.MAKIMA_TUI_WORKSPACE = prevWs
    }
  })

  const stdinFrames = (): any[] => {
    const raw = (proc.stdin as any).read()?.toString() ?? ''

    return raw
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l))
  }

  const replyToControl = async (subtype: string, response: unknown) => {
    let req: any

    await vi.waitFor(() => {
      seen.push(...stdinFrames())
      req = seen.find((f) => f.type === 'control_request' && f.request?.subtype === subtype)
      expect(req).toBeTruthy()
    })
    proc.line({ response: { request_id: req.request_id, response }, type: 'control_response' })
  }

  it('relays /vision to the backend and prints the reply', async () => {
    const p = gw.request('slash.exec', { command: 'vision openai:gpt-5.6-luna' })

    await replyToControl('vision', { ok: true, text: 'Vision model set to openai:gpt-5.6-luna.' })
    await expect(p).resolves.toMatchObject({
      output: expect.stringContaining('openai:gpt-5.6-luna')
    })
  })

  it('forwards the argument verbatim — the backend owns the grammar', async () => {
    const p = gw.request('slash.exec', { command: 'vision off' })

    await vi.waitFor(() => {
      seen.push(...stdinFrames())
      const req = seen.find((f) => f.type === 'control_request' && f.request?.subtype === 'vision')

      expect(req?.request?.arg).toBe('off')
    })
    const req = seen.find((f) => f.type === 'control_request' && f.request?.subtype === 'vision')

    proc.line({ response: { request_id: req.request_id, response: { ok: true, text: 'Vision disabled.' } }, type: 'control_response' })
    await p
  })

  it('surfaces a /vision error when the backend refuses', async () => {
    const p = gw.request('slash.exec', { command: 'vision on' })

    await replyToControl('vision', { error: '/vision is only available on single-session transports', ok: false })
    await expect(p).resolves.toMatchObject({
      output: expect.stringContaining('single-session')
    })
  })

  it('does not list legacy /vision in the slash-command menu', async () => {
    const p = gw.request<{ items: Array<{ text: string }> }>('complete.slash', { text: '/vis' })

    // Dynamic workflow commands are still merged into the menu.
    await replyToControl('list_workflow_commands', { commands: [] })
    const r = await p

    expect(r.items.map((item) => item.text)).not.toContain('/vision')
  })
})
