import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  accountIdFromTokens,
  createPkcePair,
  openAiCodexOAuthConfig,
  OpenAiCodexAuthManager,
  OpenAiCodexCredentialStore,
  type OpenAiCodexOAuthConfig
} from '../harness/openAiCodexAuth.js'

const config: OpenAiCodexOAuthConfig = {
  apiBaseUrl: 'https://example.test/codex',
  authorizationEndpoint: 'https://auth.example.test/authorize',
  callbackTimeoutMs: 1_000,
  clientId: 'test-client',
  originator: 'makima-tui',
  redirectUri: 'http://localhost:45678/callback',
  scopes: 'openid offline_access',
  tokenEndpoint: 'https://auth.example.test/token'
}

const jwt = (claims: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

describe('OpenAI Codex OAuth host credential lifecycle', () => {
  it('creates a PKCE S256 pair with URL-safe values', async () => {
    const { challenge, verifier } = createPkcePair()
    const crypto = await import('node:crypto')

    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'))
  })

  it('uses the authorized built-in OAuth client when no environment variables are set', () => {
    expect(openAiCodexOAuthConfig({})).toMatchObject({
      apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
      authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      deviceAuthorizationEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
      deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
      deviceTokenEndpoint: 'https://auth.openai.com/api/accounts/deviceauth/token',
      deviceVerificationUri: 'https://auth.openai.com/codex/device',
      redirectUri: 'http://localhost:1455/auth/callback',
      tokenEndpoint: 'https://auth.openai.com/oauth/token'
    })
  })

  it('extracts the ChatGPT account ID from standard and namespaced claims', () => {
    expect(accountIdFromTokens({ access_token: jwt({ chatgpt_account_id: 'account-root' }) })).toBe('account-root')
    expect(
      accountIdFromTokens({
        access_token: jwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'account-namespaced' }
        })
      })
    ).toBe('account-namespaced')
    expect(accountIdFromTokens({ access_token: jwt({ organizations: [{ id: 'org-fallback' }] }) })).toBe('org-fallback')
  })

  it('persists a rotated refresh token and returns the refreshed access token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'makima-codex-auth-'))
    const store = new OpenAiCodexCredentialStore(join(dir, 'credential.json'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          expires_in: 3_600,
          refresh_token: 'new-refresh'
        }),
        { status: 200 }
      )
    )

    try {
      await store.save({
        accessToken: 'old-access',
        expiresAt: Date.now() - 1,
        refreshToken: 'old-refresh',
        type: 'openai-codex'
      })
      const auth = new OpenAiCodexAuthManager(config, store, fetcher)

      await expect(auth.accessToken()).resolves.toBe('new-access')
      await expect(store.load()).resolves.toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  it('clears a revoked refresh token instead of retaining a stale login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'makima-codex-auth-'))
    const store = new OpenAiCodexCredentialStore(join(dir, 'credential.json'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token revoked'
        }),
        { status: 400 }
      )
    )

    try {
      await store.save({
        accessToken: 'expired-access',
        expiresAt: Date.now() - 1,
        refreshToken: 'revoked-refresh',
        type: 'openai-codex'
      })
      const auth = new OpenAiCodexAuthManager(config, store, fetcher)

      await expect(auth.accessToken()).rejects.toThrow('authenticate again')
      await expect(store.load()).resolves.toBeUndefined()
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
