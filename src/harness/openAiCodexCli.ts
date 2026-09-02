#!/usr/bin/env node
import { openAiCodexOAuthConfig, OpenAiCodexAuthManager } from './openAiCodexAuth.js'

type Command = 'login' | 'logout' | 'status'
type Method = 'browser' | 'device_code'

function usage(): string {
  return `Usage: makima-tui-auth <login|status|logout> openai-codex [--browser|--device-code]\n\nCommands:\n  login openai-codex    Start a configured OAuth login\n  status openai-codex   Print redacted local login status\n  logout openai-codex   Delete only Makima's local OAuth credential\n\nOptions:\n  --browser             Use registered loopback PKCE login (default)\n  --device-code         Use a configured Device Code flow\n`
}

function parse(argv: readonly string[]): { command: Command; method: Method; provider: string } | undefined {
  const [command, provider, ...flags] = argv
  if ((command !== 'login' && command !== 'status' && command !== 'logout') || provider !== 'openai-codex') return undefined
  const browser = flags.includes('--browser')
  const device = flags.includes('--device-code')
  if ((browser && device) || flags.some((flag) => flag !== '--browser' && flag !== '--device-code')) return undefined
  return { command, method: device ? 'device_code' : 'browser', provider }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage())
    return 0
  }
  const parsed = parse(args)
  if (!parsed) {
    process.stderr.write(usage())
    return 2
  }
  let auth: OpenAiCodexAuthManager
  try {
    auth = new OpenAiCodexAuthManager(openAiCodexOAuthConfig())
  } catch (error) {
    process.stderr.write(`makima-tui-auth: ${error instanceof Error ? error.message : 'OAuth configuration is invalid'}\n`)
    return 2
  }
  if (parsed.command === 'status') {
    const status = await auth.status()
    process.stdout.write(`${status.authenticated ? 'authenticated' : 'not authenticated'}${status.email ? ` (${status.email})` : ''}\n`)
    return status.authenticated ? 0 : 1
  }
  if (parsed.command === 'logout') {
    await auth.logout()
    process.stdout.write('OpenAI Codex OAuth credential removed.\n')
    return 0
  }
  if (parsed.method === 'device_code' && !auth.canUseDeviceCode()) {
    process.stderr.write('makima-tui-auth: Device Code is not configured. Set all MAKIMA_OPENAI_CODEX_DEVICE_* variables.\n')
    return 2
  }
  const login = await auth.beginLogin(parsed.method)
  const interrupt = (): void => {
    void login.cancel()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    if (login.deviceCode) {
      process.stdout.write(`Open ${login.deviceCode.verificationUri} and enter code: ${login.deviceCode.userCode}\n`)
    } else if (login.authorizationUrl) {
      process.stdout.write(`Open this URL in your browser:\n${login.authorizationUrl}\n`)
    }
    const credential = await login.complete()
    process.stdout.write(`OpenAI Codex sign-in complete${credential.email ? ` (${credential.email})` : ''}.\n`)
    return 0
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`makima-tui-auth: ${error instanceof Error ? error.message : 'OAuth login failed'}\n`)
  return 1
})
