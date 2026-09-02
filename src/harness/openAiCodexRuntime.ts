import type { Context } from '@deepseek-ai/cordis'

import { OpenAiCodexAdapter } from './openAiCodexAdapter.js'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  OpenAiCodexAuthManager,
  OPENAI_CODEX_PROVIDER,
  openAiCodexOAuthConfig,
  type OpenAiCodexAuthView,
  type OAuthLogin
} from './openAiCodexAuth.js'
import { openExternalUrl } from './openExternalUrl.js'

type LoginMethod = 'browser' | 'device_code'

export interface OpenAiCodexLoginView {
  authorization_url?: string
  device_code?: { expires_at: number; user_code: string; verification_uri: string }
  method: LoginMethod
}

let manager: OpenAiCodexAuthManager | undefined
let login: OAuthLogin | undefined
let loginError: string | undefined

/** Install the provider into the host LLM registry. Called once from the Cordis plugin lifecycle. */
export function installOpenAiCodex(ctx: Context): void {
  let config
  try {
    config = openAiCodexOAuthConfig()
  } catch {
    return
  }
  const next = new OpenAiCodexAuthManager(config)
  manager = next

  // Makima itself only requires the agent registry. Register the OAuth adapter
  // in a child lifecycle so Cordis waits for the optional LLM service instead
  // of reading ctx.llm while the parent plugin is still being applied.
  ctx.inject(['llm'], (llmCtx) => {
    const attachments = llmCtx.get('attachments') as
      | { readImage?: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{ data: Uint8Array; ref: ImageAttachmentRef }> }
      | undefined
    const dispose = llmCtx.llm.registerAdapter(
      [OPENAI_CODEX_PROVIDER],
      new OpenAiCodexAdapter(next, fetch, attachments?.readImage?.bind(attachments))
    )
    llmCtx.effect(() => () => dispose())
  })

  ctx.effect(() => () => {
    if (manager === next) manager = undefined
  })
}

export async function openAiCodexStatus(): Promise<
  OpenAiCodexAuthView & { device_code_available?: boolean; login_error?: string; login_method?: LoginMethod; login_pending?: boolean }
> {
  const status = manager ? await manager.status() : { accountIdPresent: false, authenticated: false }
  return {
    ...status,
    ...(manager?.canUseDeviceCode() ? { device_code_available: true } : {}),
    ...(loginError ? { login_error: loginError } : {}),
    ...(login ? { login_method: login.method, login_pending: true } : {})
  }
}

export async function startOpenAiCodexLogin(method: LoginMethod = 'browser'): Promise<OpenAiCodexLoginView> {
  if (!manager) throw new Error('OpenAI Codex OAuth failed to initialize; restart Makima and check the plugin startup logs')
  if (login) throw new Error('OpenAI Codex OAuth login is already in progress')
  loginError = undefined
  login = await manager.beginLogin(method)
  const active = login
  if (active.authorizationUrl) {
    try {
      await openExternalUrl(active.authorizationUrl)
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ''
      loginError = `Could not open the browser automatically${detail}. Open the authorization URL shown below instead.`
    }
  }
  void active
    .complete()
    .catch((error: unknown) => {
      loginError = error instanceof Error ? error.message : 'OpenAI Codex sign-in failed'
    })
    .finally(() => {
      if (login === active) login = undefined
    })
  return {
    ...(active.authorizationUrl ? { authorization_url: active.authorizationUrl } : {}),
    ...(active.deviceCode
      ? {
          device_code: {
            expires_at: active.deviceCode.expiresAt,
            user_code: active.deviceCode.userCode,
            verification_uri: active.deviceCode.verificationUri
          }
        }
      : {}),
    method: active.method
  }
}

export async function cancelOpenAiCodexLogin(): Promise<void> {
  const active = login
  loginError = undefined
  if (!active) return
  login = undefined
  await active.cancel()
}

export async function logoutOpenAiCodex(): Promise<void> {
  await cancelOpenAiCodexLogin()
  loginError = undefined
  await manager?.logout()
}
