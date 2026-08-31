import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'

import lockfile from 'proper-lockfile'

import { appHomePath } from '../lib/appHome.js'

export const OPENAI_CODEX_PROVIDER = 'openai-codex'
export const OPENAI_CODEX_CREDENTIAL_FILE = 'openai-codex-oauth.json'
const CALLBACK_TIMEOUT_MS = 5 * 60_000
const DEVICE_TIMEOUT_MS = 15 * 60_000
const EXPIRY_SKEW_MS = 60_000

// This public client is owned by Makima's maintainer and registered for the
// loopback callback below. Environment variables remain opt-in overrides for
// development or a separately authorized deployment.
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_API_BASE_URL = 'https://chatgpt.com/backend-api'
const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const DEFAULT_DEVICE_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const DEFAULT_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const DEFAULT_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device'
const DEFAULT_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback'

type LoginMethod = 'browser' | 'device_code'

export interface OpenAiCodexOAuthConfig {
  apiBaseUrl: string
  authorizationEndpoint: string
  callbackTimeoutMs: number
  clientId: string
  deviceAuthorizationEndpoint?: string
  deviceRedirectUri?: string
  deviceTokenEndpoint?: string
  deviceVerificationUri?: string
  originator: string
  redirectUri: string
  scopes: string
  tokenEndpoint: string
}

export interface OpenAiCodexCredential {
  accountId?: string
  accessToken: string
  email?: string
  expiresAt: number
  refreshToken: string
  type: typeof OPENAI_CODEX_PROVIDER
}

export interface OpenAiCodexAuthView {
  accountIdPresent: boolean
  authenticated: boolean
  email?: string
  expiresAt?: number
}

export interface OAuthLogin {
  authorizationUrl?: string
  cancel(): Promise<void>
  complete(): Promise<OpenAiCodexCredential>
  deviceCode?: { expiresAt: number; userCode: string; verificationUri: string }
  method: LoginMethod
}

interface TokenResponse {
  access_token: string
  email?: string
  expires_in: number
  id_token?: string
  refresh_token?: string
}

interface JwtClaims {
  chatgpt_account_id?: string
  email?: string
  organizations?: Array<{ id?: string }>
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string }
}

interface DeviceCodeResponse {
  device_auth_id: string
  expires_in?: number
  interval?: number | string
  user_code: string
  verification_uri?: string
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed || undefined
}

const configuredUrl = (value: string | undefined, name: string, allowLoopback = false): string => {
  const raw = nonEmpty(value)
  if (!raw) throw new Error(`${name} is required`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }
  const local = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if (parsed.protocol !== 'https:' && !(allowLoopback && local)) {
    throw new Error(`${name} must use HTTPS (a loopback callback may use HTTP)`)
  }
  return parsed.toString()
}

function optionalUrl(value: string | undefined, name: string, allowLoopback = false): string | undefined {
  return nonEmpty(value) === undefined ? undefined : configuredUrl(value, name, allowLoopback)
}

/**
 * Read the built-in OAuth defaults, allowing explicit environment overrides
 * for development and separately authorized deployments.
 */
export function openAiCodexOAuthConfig(env = process.env): OpenAiCodexOAuthConfig {
  const redirectUri = configuredUrl(env.MAKIMA_OPENAI_CODEX_REDIRECT_URI ?? DEFAULT_REDIRECT_URI, 'MAKIMA_OPENAI_CODEX_REDIRECT_URI', true)
  const callback = new URL(redirectUri)
  if (callback.protocol !== 'http:' || (callback.hostname !== 'localhost' && callback.hostname !== '127.0.0.1')) {
    throw new Error('MAKIMA_OPENAI_CODEX_REDIRECT_URI must be a registered http://localhost or http://127.0.0.1 callback URI')
  }
  const deviceAuthorizationEndpoint = optionalUrl(env.MAKIMA_OPENAI_CODEX_DEVICE_AUTHORIZE_URL ?? DEFAULT_DEVICE_AUTHORIZE_URL, 'MAKIMA_OPENAI_CODEX_DEVICE_AUTHORIZE_URL')
  const deviceTokenEndpoint = optionalUrl(env.MAKIMA_OPENAI_CODEX_DEVICE_TOKEN_URL ?? DEFAULT_DEVICE_TOKEN_URL, 'MAKIMA_OPENAI_CODEX_DEVICE_TOKEN_URL')
  const deviceVerificationUri = optionalUrl(env.MAKIMA_OPENAI_CODEX_DEVICE_VERIFICATION_URI ?? DEFAULT_DEVICE_VERIFICATION_URI, 'MAKIMA_OPENAI_CODEX_DEVICE_VERIFICATION_URI')
  const deviceRedirectUri = optionalUrl(env.MAKIMA_OPENAI_CODEX_DEVICE_REDIRECT_URI ?? DEFAULT_DEVICE_REDIRECT_URI, 'MAKIMA_OPENAI_CODEX_DEVICE_REDIRECT_URI')
  const deviceValues = [deviceAuthorizationEndpoint, deviceTokenEndpoint, deviceVerificationUri, deviceRedirectUri]
  if (deviceValues.some(Boolean) && deviceValues.some(value => !value)) {
    throw new Error('all MAKIMA_OPENAI_CODEX_DEVICE_* OAuth settings are required when Device Code is enabled')
  }
  return {
    apiBaseUrl: configuredUrl(env.MAKIMA_OPENAI_CODEX_API_BASE_URL ?? DEFAULT_API_BASE_URL, 'MAKIMA_OPENAI_CODEX_API_BASE_URL').replace(/\/$/, ''),
    authorizationEndpoint: configuredUrl(env.MAKIMA_OPENAI_CODEX_AUTHORIZE_URL ?? 'https://auth.openai.com/oauth/authorize', 'MAKIMA_OPENAI_CODEX_AUTHORIZE_URL'),
    callbackTimeoutMs: CALLBACK_TIMEOUT_MS,
    clientId: nonEmpty(env.MAKIMA_OPENAI_CODEX_CLIENT_ID) ?? DEFAULT_CLIENT_ID,
    ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint, deviceRedirectUri, deviceTokenEndpoint, deviceVerificationUri } : {}),
    originator: nonEmpty(env.MAKIMA_OPENAI_CODEX_ORIGINATOR) ?? 'makima-tui',
    redirectUri,
    scopes: nonEmpty(env.MAKIMA_OPENAI_CODEX_SCOPES) ?? 'openid profile email offline_access',
    tokenEndpoint: configuredUrl(env.MAKIMA_OPENAI_CODEX_TOKEN_URL ?? 'https://auth.openai.com/oauth/token', 'MAKIMA_OPENAI_CODEX_TOKEN_URL')
  }
}

export function credentialPath(): string {
  return process.env.MAKIMA_OPENAI_CODEX_CREDENTIAL_PATH?.trim() || appHomePath(OPENAI_CODEX_CREDENTIAL_FILE)
}

export function redactedAuthView(credential: OpenAiCodexCredential | undefined): OpenAiCodexAuthView {
  return credential
    ? { accountIdPresent: Boolean(credential.accountId), authenticated: true, email: credential.email, expiresAt: credential.expiresAt }
    : { accountIdPresent: false, authenticated: false }
}

export function createPkcePair(): { challenge: string; verifier: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { challenge: createHash('sha256').update(verifier).digest('base64url'), verifier }
}

export function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed as JwtClaims : undefined
  } catch {
    return undefined
  }
}

export function accountIdFromTokens(tokens: Pick<TokenResponse, 'access_token' | 'id_token'>): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue
    const claims = parseJwtClaims(token)
    const accountId = claims?.chatgpt_account_id ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? claims?.organizations?.find(org => typeof org.id === 'string')?.id
    if (accountId) return accountId
  }
  return undefined
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isCredential(value: unknown): value is OpenAiCodexCredential {
  const candidate = value as Partial<OpenAiCodexCredential> | undefined
  return candidate?.type === OPENAI_CODEX_PROVIDER && typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0 && typeof candidate.refreshToken === 'string' && candidate.refreshToken.length > 0 && typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt) && (candidate.accountId === undefined || typeof candidate.accountId === 'string') && (candidate.email === undefined || typeof candidate.email === 'string')
}

/** Plugin-owned credential file with owner-only permissions, atomic replacement, and an OS-visible lock. */
export class OpenAiCodexCredentialStore {
  constructor(private readonly path = credentialPath()) {}

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('OpenAI Codex credential directory is unsafe')
    await chmod(directory, 0o700)
  }

  private async readUnlocked(): Promise<OpenAiCodexCredential | undefined> {
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('OpenAI Codex credential path is unsafe')
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('OpenAI Codex credential file permissions are unsafe')
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!isCredential(raw)) throw new Error('OpenAI Codex credential file is invalid')
      return { ...raw }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory()
    const release = await lockfile.lock(dirname(this.path), {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 80, factor: 1.15, minTimeout: 10, maxTimeout: 150 }
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  async load(): Promise<OpenAiCodexCredential | undefined> {
    await this.ensureDirectory()
    return this.readUnlocked()
  }

  async modify(fn: (current: OpenAiCodexCredential | undefined) => Promise<OpenAiCodexCredential | undefined>): Promise<OpenAiCodexCredential | undefined> {
    return this.withLock(async () => {
      const next = await fn(await this.readUnlocked())
      if (next === undefined) return undefined
      if (!isCredential(next)) throw new Error('refusing to store an invalid OpenAI Codex credential')
      const temp = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
      let handle
      try {
        handle = await open(temp, 'wx', 0o600)
        await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temp, this.path)
        await chmod(this.path, 0o600)
      } finally {
        await handle?.close()
        await unlink(temp).catch(error => { if (!isMissing(error)) throw error })
      }
      return { ...next }
    })
  }

  async save(credential: OpenAiCodexCredential): Promise<void> {
    await this.modify(async () => credential)
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      const info = await lstat(this.path).catch(error => { if (isMissing(error)) return undefined; throw error })
      if (!info) return
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('OpenAI Codex credential path is unsafe')
      await rm(this.path, { force: true })
    })
  }
}

export class OpenAiCodexAuthManager {
  private refreshInFlight: Promise<OpenAiCodexCredential | undefined> | undefined

  constructor(
    readonly config: OpenAiCodexOAuthConfig,
    readonly store = new OpenAiCodexCredentialStore(),
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async status(): Promise<OpenAiCodexAuthView> { return redactedAuthView(await this.store.load()) }
  async logout(): Promise<void> { await this.store.clear() }
  canUseDeviceCode(): boolean { return Boolean(this.config.deviceAuthorizationEndpoint) }

  async beginLogin(method: LoginMethod = 'browser'): Promise<OAuthLogin> {
    if (method === 'device_code') return this.beginDeviceLogin()
    const { challenge, verifier } = createPkcePair()
    const state = randomBytes(32).toString('base64url')
    const url = new URL(this.config.authorizationEndpoint)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, scope: this.config.scopes, state, code_challenge: challenge, code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: this.config.originator })) url.searchParams.set(key, value)
    const callback = await listenForCallback(this.config.redirectUri, state, this.config.callbackTimeoutMs)
    return {
      authorizationUrl: url.toString(),
      cancel: callback.cancel,
      complete: async () => this.persistTokens(await callback.code, verifier, this.config.redirectUri),
      method
    }
  }

  private async beginDeviceLogin(): Promise<OAuthLogin> {
    const { deviceAuthorizationEndpoint, deviceRedirectUri, deviceTokenEndpoint, deviceVerificationUri } = this.config
    if (!deviceAuthorizationEndpoint || !deviceRedirectUri || !deviceTokenEndpoint || !deviceVerificationUri) throw new Error('OpenAI Device Code login is not configured')
    const abort = new AbortController()
    const response = await this.fetcher(deviceAuthorizationEndpoint, { body: JSON.stringify({ client_id: this.config.clientId }), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, method: 'POST', signal: abort.signal })
    const raw: unknown = await response.json().catch(() => undefined)
    if (!response.ok || !isDeviceCodeResponse(raw)) throw new Error('OpenAI Device Code authorization request failed')
    const expiresAt = Date.now() + (raw.expires_in && raw.expires_in > 0 ? raw.expires_in * 1000 : DEVICE_TIMEOUT_MS)
    const intervalMs = Math.max(1_000, Number(raw.interval ?? 5) * 1_000)
    const verificationUri = raw.verification_uri || deviceVerificationUri
    return {
      cancel: async () => abort.abort('OpenAI Device Code login cancelled'),
      complete: async () => {
        while (Date.now() < expiresAt) {
          await delay(intervalMs, abort.signal)
          const poll = await this.fetcher(deviceTokenEndpoint, { body: JSON.stringify({ device_auth_id: raw.device_auth_id, user_code: raw.user_code }), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, method: 'POST', signal: abort.signal })
          if (poll.ok) {
            const token: unknown = await poll.json().catch(() => undefined)
            if (!token || typeof token !== 'object') throw new Error('OpenAI Device Code authorization returned invalid data')
            const value = token as Record<string, unknown>
            if (typeof value.authorization_code !== 'string' || typeof value.code_verifier !== 'string') throw new Error('OpenAI Device Code authorization is incomplete')
            return this.persistTokens(value.authorization_code, value.code_verifier, deviceRedirectUri)
          }
          const pending: unknown = await poll.json().catch(() => undefined)
          const code = pending && typeof pending === 'object' ? String((pending as Record<string, unknown>).error ?? '') : ''
          if (poll.status === 403 || poll.status === 404 || code === 'authorization_pending' || code === 'deviceauth_authorization_pending') continue
          if (code === 'slow_down') { await delay(5_000, abort.signal); continue }
          throw new Error('OpenAI Device Code authorization failed')
        }
        throw new Error('OpenAI Device Code expired')
      },
      deviceCode: { expiresAt, userCode: raw.user_code, verificationUri },
      method: 'device_code'
    }
  }

  async accessToken(): Promise<string> {
    let credential = await this.store.load()
    if (!credential) throw new Error('OpenAI Codex is not authenticated; run the login flow first')
    if (credential.expiresAt > Date.now() + EXPIRY_SKEW_MS) return credential.accessToken
    credential = await this.refresh(credential)
    if (!credential) throw new Error('OpenAI Codex login expired; authenticate again')
    return credential.accessToken
  }

  private async refresh(current: OpenAiCodexCredential): Promise<OpenAiCodexCredential | undefined> {
    this.refreshInFlight ??= this.store.modify(async stored => {
      if (!stored) return undefined
      if (stored.expiresAt > Date.now() + EXPIRY_SKEW_MS) return stored
      try { return this.credentialFrom(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }), stored.refreshToken) } catch (error) {
        if (isInvalidGrant(error)) return undefined
        throw error
      }
    }).finally(() => { this.refreshInFlight = undefined })
    return this.refreshInFlight
  }

  private async persistTokens(code: string, verifier: string, redirectUri: string): Promise<OpenAiCodexCredential> {
    const credential = this.credentialFrom(await this.tokenRequest({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }))
    await this.store.save(credential)
    return credential
  }

  private async tokenRequest(values: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetcher(this.config.tokenEndpoint, { body: new URLSearchParams({ client_id: this.config.clientId, ...values }), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, method: 'POST' })
    const text = await response.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = undefined }
    if (!response.ok) throw new OAuthTokenError(response.status, data)
    if (!isTokenResponse(data)) throw new Error('OpenAI OAuth token response is malformed')
    return data
  }

  private credentialFrom(tokens: TokenResponse, priorRefreshToken?: string): OpenAiCodexCredential {
    const claims = parseJwtClaims(tokens.id_token ?? tokens.access_token)
    return { accountId: accountIdFromTokens(tokens), accessToken: tokens.access_token, email: tokens.email ?? claims?.email, expiresAt: Date.now() + tokens.expires_in * 1_000, refreshToken: tokens.refresh_token ?? priorRefreshToken ?? missingRefreshToken(), type: OPENAI_CODEX_PROVIDER }
  }
}

class OAuthTokenError extends Error {
  constructor(readonly status: number, readonly details: unknown) { super(typeof details === 'object' && details && typeof (details as Record<string, unknown>).error_description === 'string' ? (details as Record<string, string>).error_description : `OpenAI OAuth token request failed (${status})`) }
}

function isInvalidGrant(error: unknown): boolean {
  if (!(error instanceof OAuthTokenError)) return false
  const code = typeof error.details === 'object' && error.details ? (error.details as Record<string, unknown>).error : undefined
  return code === 'invalid_grant' || /invalid_grant|revoked|expired|invalid refresh/i.test(error.message)
}
function missingRefreshToken(): string { throw new Error('OpenAI OAuth token response did not contain a refresh token') }
function isTokenResponse(value: unknown): value is TokenResponse { const candidate = value as Partial<TokenResponse> | undefined; return typeof candidate?.access_token === 'string' && candidate.access_token.length > 0 && typeof candidate.expires_in === 'number' && Number.isFinite(candidate.expires_in) && candidate.expires_in > 0 && (candidate.refresh_token === undefined || typeof candidate.refresh_token === 'string') }
function isDeviceCodeResponse(value: unknown): value is DeviceCodeResponse { const candidate = value as Partial<DeviceCodeResponse> | undefined; return typeof candidate?.device_auth_id === 'string' && candidate.device_auth_id.length > 0 && typeof candidate.user_code === 'string' && candidate.user_code.length > 0 }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('OpenAI OAuth login cancelled'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('OpenAI OAuth login cancelled'))
    }, { once: true })
  })
}

async function listenForCallback(redirectUri: string, expectedState: string, timeoutMs: number): Promise<{ cancel(): Promise<void>; code: Promise<string> }> {
  const callback = new URL(redirectUri)
  const server = createServer()
  let settled = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  const close = async () => new Promise<void>(resolve => server.close(() => resolve()))
  const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void close(); fn() }
  const timer = setTimeout(() => settle(() => rejectCode(new Error('OpenAI OAuth callback timed out'))), timeoutMs)
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? callback.host}`)
    if (requestUrl.pathname !== callback.pathname) { response.writeHead(404).end('Not found'); return }
    const error = requestUrl.searchParams.get('error')
    const state = requestUrl.searchParams.get('state')
    const authCode = requestUrl.searchParams.get('code')
    if (error || state !== expectedState || !authCode) { response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('OpenAI authorization failed. You may close this tab.'); settle(() => rejectCode(new Error(error ? 'OpenAI authorization failed' : 'OpenAI OAuth callback validation failed'))); return }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('OpenAI authorization completed. You may close this tab and return to Makima TUI.')
    settle(() => resolveCode(authCode))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(callback.port || '80'), callback.hostname, () => { server.off('error', reject); resolve() }) })
  return { cancel: async () => settle(() => rejectCode(new Error('OpenAI OAuth login cancelled'))), code }
}
