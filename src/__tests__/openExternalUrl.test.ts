import { describe, expect, it } from 'vitest'

import { externalUrlLaunchCommand } from '../harness/openExternalUrl.js'

const authorizationUrl = 'https://auth.openai.com/oauth/authorize?client_id=client&state=state&code_challenge=challenge'

describe('external URL launcher', () => {
  it('uses Windows FileProtocolHandler without shell interpolation', () => {
    expect(externalUrlLaunchCommand(authorizationUrl, 'win32')).toEqual({
      args: ['url.dll,FileProtocolHandler', authorizationUrl],
      command: 'rundll32.exe'
    })
  })

  it('uses the native default-browser launchers on macOS and Linux', () => {
    expect(externalUrlLaunchCommand(authorizationUrl, 'darwin')).toEqual({
      args: [authorizationUrl],
      command: 'open'
    })
    expect(externalUrlLaunchCommand(authorizationUrl, 'linux')).toEqual({
      args: [authorizationUrl],
      command: 'xdg-open'
    })
  })

  it('refuses non-HTTP(S) URL schemes', () => {
    expect(() => externalUrlLaunchCommand('file:///C:/sensitive.txt', 'win32')).toThrow('Only HTTP(S) URLs can be opened externally')
  })
})
