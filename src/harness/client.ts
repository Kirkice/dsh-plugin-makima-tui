// HarnessGatewayClient — the deepseek-harness replacement for the clawcodex
// gateway subprocess. It subclasses GatewayClient so the entire app keeps its
// exact `gw` contract (EventEmitter of GatewayEvent + request()), but start()
// creates an in-process harness Agent instead of spawning Python, and every
// emission is translated from harness `session/event` records.
//
// Boundary rule: src/harness/ is the ONLY directory allowed to import
// @deepseek-ai/* (see docs/ARCHITECTURE.md).
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, type ContentBlock, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { supportedProtocols } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Type-only: activates the 'plan/mode' SessionEventMap augmentation.
import type {} from '@deepseek-ai/dsh-plan-mode'
// Type-only: activates the subagent lifecycle Events and the
// 'subagent/descriptor' SessionEventMap augmentation.
import type {} from '@deepseek-ai/dsh-subagent'
// Type-only: activates the persisted `session/title` SessionEventMap entry.
import type {} from '@deepseek-ai/dsh-session-title'

import { toolArgsPreview } from '../domain/toolArgs.js'
import { isDelegationCall } from '../domain/toolBrief.js'
import { GatewayClient, SLASHES } from '../gatewayClient.js'
import { appHome } from '../lib/appHome.js'
import { compactPreview, fmtK, toolTrailLabel } from '../lib/text.js'
import { structuredPatch } from 'diff'

import type { GatewayEvent, GatewayTranscriptMessage, StructuredDiffPayload } from '../gatewayTypes.js'
import { resolveManagedProfile } from './profile.js'
import {
  cancelOpenAiCodexLogin,
  logoutOpenAiCodex,
  openAiCodexStatus,
  startOpenAiCodexLogin
} from './openAiCodexRuntime.js'
import type { SessionInfo, Usage } from '../types.js'
import { parseImageRefs } from '../protocol/imageRef.js'
import { readImageFile, readWindowsClipboardImage, type IngressImage } from './imageIngress.js'

const PLUGIN_VERSION = (() => {
  const require = createRequire(import.meta.url)

  // '../package.json' from the built dist/plugin.js; '../../package.json'
  // when running from src (tsx, vitest).
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(rel) as { name?: string; version?: string }

      if (pkg.name === 'makima-tui' && pkg.version) {
        return pkg.version
      }
    } catch {
      // try the next candidate
    }
  }

  return ''
})()

const MANAGED_PROVIDER_PREFIX = 'makima-'
const MANAGED_CREDENTIAL_PREFIX = 'MAKIMA_TUI_PROVIDER_'
const PI_AI_SETTINGS_NS = 'llm-pi-ai'

interface ManagedProviderProfile {
  api?: string
  apiKeyEnv?: string
  baseURL?: string
  displayName?: string
  models?: Array<{ id?: string; input?: string[] }>
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const managedProviderId = (value: string): string => {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  if (!slug) throw new Error('provider name must contain a letter or number')

  return `${MANAGED_PROVIDER_PREFIX}${slug}`
}

const isManagedProviderId = (value: string): boolean =>
  value.startsWith(MANAGED_PROVIDER_PREFIX) && /^[a-z0-9][a-z0-9-]*$/.test(value.slice(MANAGED_PROVIDER_PREFIX.length))

const managedCredentialRef = (provider: string): string =>
  `${MANAGED_CREDENTIAL_PREFIX}${provider.slice(MANAGED_PROVIDER_PREFIX.length).replace(/-/g, '_').toUpperCase()}_API_KEY`

const modelsFrom = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []

  return [...new Set(value.flatMap(item => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : []
    if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id?: unknown }).id
      return typeof id === 'string' && id.trim() ? [id.trim()] : []
    }
    return []
  }))]
}

/**
 * Image support is opt-in per configured model. OpenAI-compatible gateways
 * differ, so guessing from a model name could send an invalid image request.
 */
const imageModelsFrom = (value: unknown, models: readonly string[]): string[] => {
  const requested = new Set(modelsFrom(value))
  return models.filter(model => requested.has(model))
}

/**
 * What one running subagent has done so far, accumulated from ITS OWN session
 * log rather than from the delegating call.
 *
 * Correlation is the whole reason this is keyed on the child's session id: the
 * harness's own guidance tells a model to start independent delegations
 * together in one message, so pairing a child with its call by arrival order
 * would attribute one delegation's work to another as soon as two run at once.
 * The child's id appears on both lifecycle edges and on every event its session
 * emits, so nothing has to be guessed.
 */
interface ChildRun {
  /** The delegation's short description, learned from the child's descriptor. */
  goal: string
  /** Spawn order, which is what orders the inline tree's rows. */
  index: number
  inputTokens: number
  outputTokens: number
  startedAt: number
  toolCount: number
}

export interface HarnessClientOptions {
  cwd?: string
  launchCwd?: string
  model?: string
  profile?: string
  provider?: string
  sessionId?: string
}

type ModelRoute = ModelSelection

const textOf = (blocks: readonly ContentBlock[] | undefined, kinds: ReadonlyArray<ContentBlock['type']> = ['text']): string => {
  if (!blocks) {
    return ''
  }

  const out: string[] = []

  for (const b of blocks) {
    if ((kinds as readonly string[]).includes(b.type) && 'text' in b && typeof b.text === 'string') {
      out.push(b.text)
    }
  }

  return out.join('')
}

/**
 * The `⎿ Error: …` line a failed call renders.
 *
 * The original prints the tool's OWN message there — "File does not exist.
 * Note: your current working directory is …", "Exit code 1" over the command's
 * stderr. The harness splits that in two: `tool/result.error` carries the
 * structured identity (`FsError` / `FS_NOT_FOUND`) while the human-readable
 * message rides the result content the model reads. Building the row from the
 * identity alone rendered `⎿ FsError: FS_NOT_FOUND` — accurate, and useless to
 * anyone deciding what to do next.
 *
 * So: the message when there is one, the identity when there is not, and never
 * both, because the identity is a restatement of the message's first clause in
 * every case the tools produce. `Error: ` goes on here rather than in the
 * renderer — the trail line is built from this string, and upstream's own
 * fixtures arrive already carrying the prefix.
 */
const failureText = (message: string, identity?: { code: string; name: string }): string => {
  const body = message.trim() || (identity ? `${identity.name}: ${identity.code}` : '') || 'tool failed'

  return /^error\b/i.test(body) ? body : `Error: ${body}`
}

/**
 * A diff card's header, as plain text, for a transcript row that cannot draw
 * the card itself — the resumed session's flat trail. Mirrors what DiffView
 * prints above the patch (`Wrote N lines to path`, `Added N lines, removed M
 * lines`), so replay says the same thing the live card did rather than the
 * model-facing "the file has been updated successfully" boilerplate.
 */
const diffSummary = (diff: StructuredDiffPayload): string => {
  if (diff.kind === 'create') {
    const all = (diff.content ?? '').split('\n')

    if (all.at(-1) === '') {
      all.pop()
    }

    return `Wrote ${plural(all.length, 'line')} to ${diff.filePath}`
  }

  let added = 0
  let removed = 0

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added++
      } else if (line.startsWith('-')) {
        removed++
      }
    }
  }

  if (!added && !removed) {
    return ''
  }

  const clauses = [added ? `Added ${plural(added, 'line')}` : '', removed ? `${added ? 'r' : 'R'}emoved ${plural(removed, 'line')}` : '']

  return clauses.filter(Boolean).join(', ')
}

/**
 * How many lines of a tool's own output the compact `⎿` body carries.
 *
 * The row's job is to show WHAT came back, not to summarise it away: a few
 * lines of the file, the head of the command's output, the first matches. Four
 * is enough to recognise the result and short enough that a turn of ten reads
 * still fits on a screen; the rest is one ctrl+o away.
 */
const PREVIEW_LINES = 4

/**
 * The compact body, plus an honest count of what did not fit. Bounded HERE
 * rather than by the trail's own safety cap, because only the card knows the
 * real total — and because handing a 2000-line file to every trail line would
 * keep the whole thing alive in the transcript for the rest of the session.
 * `result_raw` carries the full text for the expanded view.
 */
const previewBody = (body: string): string => {
  const lines = body.split('\n')
  const dropped = lines.length - PREVIEW_LINES

  return dropped > 0
    ? [...lines.slice(0, PREVIEW_LINES), `… +${fmtK(dropped)} ${dropped === 1 ? 'line' : 'lines'}`].join('\n')
    : body
}

/** `1 file` / `2 files` — the count the ⎿ summary lines are built from. */
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/**
 * A read's ⎿ body: the head of the file itself, line-numbered, over
 * `… +N lines`. A tally alone (`Read 29 lines`) says a read happened without
 * saying what it found, and the whole point of the row is that a reader can
 * follow along without opening the file themselves.
 */
const readCard = (view: {
  lines?: { number: number; text: string }[]
  path?: string
}): { resultRaw: string; resultText: string } => {
  const lines = view.lines ?? []
  const width = String(lines.at(-1)?.number ?? 0).length
  const body = lines.map(line => `${String(line.number).padStart(width)}  ${line.text}`).join('\n')

  return { resultRaw: body, resultText: previewBody(body) }
}

/** `559 bytes` / `1.2KB` — the size the original reports a fetch by. */
const byteSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  }

  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** The status phrases a fetch actually comes back with; anything else shows
 *  bare, because `(418)` beats inventing a phrase for it. */
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

/**
 * A web call's ⎿ line.
 *
 * A fetch answers with the retrieval, not the page: `Received 559 bytes
 * (200 OK)`. The markdown body is already the model's, and a whole page pasted
 * into the transcript is a page nobody reads — it stays behind ctrl+o.
 *
 * A search answers `Did 1 search in 7s` and stops: what the search FOUND is the
 * model's answer to give, and the row's job is to account for the round trip.
 * The cited sources — the one thing the result text cannot losslessly carry,
 * which is why the harness projects them through presentation meta at all —
 * ride behind ctrl+o.
 */
const webCard = (
  view: {
    answer?: string
    kind?: string
    sources?: { title?: string; url: string }[]
    statusCode?: number
    truncated?: boolean
    url?: string
  },
  fallback: string,
  durationS?: number
): { resultRaw?: string; resultText: string } => {
  if (view.kind === 'fetch') {
    const code = view.statusCode ?? 0
    const phrase = STATUS_TEXT[code]
    const status = [phrase ? `${code} ${phrase}` : String(code), view.truncated ? 'truncated' : '']
      .filter(Boolean)
      .join(', ')

    return { resultRaw: fallback, resultText: `Received ${byteSize(fallback.length)} (${status})` }
  }

  const sources = view.sources ?? []
  const took = durationS === undefined ? '' : ` in ${Math.max(1, Math.round(durationS))}s`
  const cited = `${plural(sources.length, 'source')}${view.truncated ? ' (capped)' : ''}`
  const rows = sources.map(source => (source.title ? `${source.title} — ${source.url}` : source.url))

  return {
    resultRaw: [cited, ...rows, view.answer ?? ''].filter(Boolean).join('\n'),
    resultText: `Did 1 search${took}`
  }
}

/**
 * A search's ⎿ line, over the rows it found: `Found 37 files` for a path search,
 * `Found 6 lines` for a content search — the original's own two phrasings, and
 * literally what each one counts (a grep returns matched LINES, several of which
 * may share a file).
 *
 * `total` is what the search FOUND, which is not always what it kept, so a
 * capped result says how much of it is on screen. A partial list read as
 * complete is how a reader concludes something is not there when it is.
 */
const searchCard = (view: {
  files?: { matches?: { line: string; lineNumber: number }[]; path: string }[]
  paths?: string[]
  shape?: string
  total?: number
  truncated?: boolean
}): { resultRaw: string; resultText: string } => {
  const total = view.total ?? 0
  const matches = view.shape === 'matches'
  const rows = matches
    ? (view.files ?? []).flatMap(file =>
        (file.matches ?? []).map(match => `${file.path}:${match.lineNumber}:${match.line}`)
      )
    : (view.paths ?? [])

  const found = `Found ${plural(total, matches ? 'line' : 'file')}`

  const summary = view.truncated && rows.length < total ? `${found} (showing ${rows.length})` : found
  const body = [summary, ...rows].join('\n')

  return { resultRaw: body, resultText: previewBody(body) }
}

/** Strip a lone ```lang fence so a fenced body reads as plain output. */
const unfence = (text: string): string => {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim())

  return match ? match[1]! : text
}

const prettyArgs = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw)

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>)

      if (entries.length === 1 && typeof entries[0]![1] === 'string') {
        return entries[0]![1] as string
      }

      return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
    }

    return raw
  } catch {
    return raw
  }
}

/**
 * Add one step's token accounting to a running session odometer, in place.
 * `input` folds in cache reads and writes because that is what the client's
 * `Usage` contract means by input — the whole prompt that was paid for, not
 * just its uncached part — and `total` is kept derived so no caller can set
 * one without the other. Shared by live counting and by the log replay a
 * resume runs, which is the only way the two can agree.
 */
const foldUsage = (totals: Usage, usage: TokenUsage): void => {
  totals.calls += 1
  totals.input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  totals.output += usage.outputTokens
  totals.reasoning = (totals.reasoning ?? 0) + (usage.reasoningTokens ?? 0)
  totals.total = totals.input + totals.output
}

export class HarnessGatewayClient extends GatewayClient {
  private readonly ctx: Context
  private readonly opts: HarnessClientOptions

  private agent: Agent | null = null
  private handle: AgentHandle | null = null
  private live = new Map<string, AgentHandle>()
  private disposers: Array<() => void> = []
  private agentDisposers: Array<() => void> = []
  private selection: ModelSelectionRef = { current: undefined, assembled: undefined }

  private harnessReady: Promise<void>
  private harnessReadyResolve!: () => void
  private startFailed: string | null = null

  private sid = ''
  private info: SessionInfo | null = null
  private sessionCreateConsumed = false

  // per-turn accumulation
  private turnStarted = false
  private turnText: string[] = []
  private turnReasoning: string[] = []
  private msgStartedHarness = false
  private callNames = new Map<string, string>()
  private callStarted = new Map<string, number>()
  private usageTotals: Usage = { calls: 0, input: 0, output: 0, total: 0 }
  private turnCount = 0
  private permissionMode = 'default'
  /** Per-call argument preview, for the approval box's command line. */
  private callArgs = new Map<string, string>()
  private callRawArgs = new Map<string, string>()
  /** Live subagents, keyed by the child's own session id. */
  private children = new Map<string, ChildRun>()
  private childCount = 0
  /** Settled children not yet claimed by a delegating call's result row. */
  private settledChildren: ChildRun[] = []
  /** Tool-call ids of delegations still waiting for their result. */
  private inFlightDelegations = new Set<string>()
  private pendingTodos: unknown[] | null = null
  private generatingAnnounced = new Set<string>()
  private gateApproval: { resolve: (o: ApprovalOutcome) => void } | null = null
  private gateQuestion: {
    items: AskUserQuestionItem[]
    planApprove?: string
    resolve: (a: AskUserQuestionAnswer) => void
  } | null = null
  /** Images staged by the composer, indexed by the visible `[Image #N]` chip. */
  private pendingImages = new Map<string, Map<number, ImageAttachmentRef>>()
  private nextImageId = 1

  constructor(ctx: Context, opts: HarnessClientOptions = {}) {
    super()
    this.ctx = ctx
    this.opts = opts
    this.harnessReady = new Promise<void>(resolve => {
      this.harnessReadyResolve = resolve
    })
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  override start(): void {
    void this.init().catch(err => {
      this.startFailed = err instanceof Error ? err.message : String(err)
      this.publishLocalEvent({ payload: { message: `harness agent failed to start: ${this.startFailed}` }, type: 'error' })
      this.harnessReadyResolve()
    })
  }

  private async init(): Promise<void> {
    const loader = this.ctx.get('loader') as { await?: () => Promise<unknown> } | undefined

    await loader?.await?.()
    await this.removeEmptyPersistedSessions()

    const handle = await this.createAgent(this.opts.sessionId)

    this.attach(handle)
    this.installGates()
    void this.refreshContextWindow()
    this.harnessReadyResolve()
    this.publishLocalEvent({ session_id: this.sid, type: 'gateway.ready' })

    if (this.info) {
      this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
    }
  }

  private workingDir(): string {
    return this.opts.cwd ?? this.opts.launchCwd ?? process.env.MAKIMA_TUI_WORKSPACE ?? process.env.MAKIMA_TUI_CWD ?? process.cwd()
  }

  private async createAgent(fixedSessionId?: string): Promise<AgentHandle> {
    const route = this.resolveRoute()
    const sessionId = SessionId(fixedSessionId ?? `makima-tui-${randomUUID()}`)

    this.selection = { assembled: undefined, current: route }

    const handle = await this.ctx.agents.create({
      agentOptions: route ? { model: route.model, provider: route.provider } : {},
      meta: { cwd: this.workingDir() },
      sessionId,
      setup: agentCtx => {
        installModelSelection(agentCtx, this.selection)
      }
    })

    this.live.set(String(sessionId), handle)

    return handle
  }

  private async resumeAgent(sessionId: string): Promise<AgentHandle> {
    const route = this.resolveRoute()

    this.selection = { assembled: undefined, current: route }

    const handle = await this.ctx.agents.resume({
      agentOptions: route ? { model: route.model, provider: route.provider } : {},
      resumeSessionId: SessionId(sessionId),
      setup: agentCtx => {
        installModelSelection(agentCtx, this.selection)
      }
    })

    this.live.set(sessionId, handle)

    return handle
  }

  /** Bind the UI to one live agent: event subscriptions, info, turn odometer. */
  private attach(handle: AgentHandle): void {
    for (const dispose of this.agentDisposers.splice(0)) {
      try {
        dispose()
      } catch {
        // best effort
      }
    }

    this.handle = handle
    this.agent = handle.agent
    this.sid = String(handle.agent.id)
    this.bindAgent(handle.agent)

    const events = handle.agent.session.events

    this.turnCount = events.filter(e => e.type === 'turn/end').length
    this.turnStarted = false
    this.turnText = []
    this.turnReasoning = []
    this.msgStartedHarness = false
    this.usageTotals = this.replayUsage(events)
    this.info = this.buildSessionInfo(this.selection.current, handle.agent.session.header.cwd ?? this.workingDir())
  }

  /**
   * Rebuild the session's token odometer from its log, the same way the line
   * above rebuilds the turn odometer. Every step's accounting is durable —
   * `assistant/message` carries the `usage` the adapter reported — so a
   * resumed session has no reason to restart its counters at zero while
   * `turns:` keeps counting; that mismatch was visible on the stats line.
   *
   * Only this session's own steps: a subagent's live in the child's log, and
   * this session never held those events. Live delegations still fold in
   * through `onChildSessionEvent`.
   */
  private replayUsage(events: readonly SessionEvent[]): Usage {
    const totals: Usage = { calls: 0, input: 0, output: 0, total: 0 }

    for (const event of events) {
      if (event.type !== 'assistant/message') {
        continue
      }

      const { usage } = (event as SessionEvent<'assistant/message'>).data

      if (usage) {
        foldUsage(totals, usage)
      }
    }

    return totals
  }

  /** Fold a session event log into resume-transcript rows. */
  private rehydrate(events: readonly SessionEvent[]): GatewayTranscriptMessage[] {
    const rows: GatewayTranscriptMessage[] = []
    // callId → the tool row waiting for its result. Keyed, not last-wins:
    // parallel calls interleave their results in the log.
    const calls = new Map<string, { name: string; rawArgs: string; row: number }>()

    for (const event of events) {
      switch (event.type) {
        case 'user/message': {
          const message = (event as SessionEvent<'user/message'>).data

          if (message.source.kind !== 'user') {
            break
          }

          const text = textOf(message.content, ['text'])

          if (text) {
            rows.push({ role: 'user', text })
          }

          break
        }

        case 'assistant/message': {
          const { message } = (event as SessionEvent<'assistant/message'>).data
          const text = textOf(message.content, ['text'])

          if (text) {
            rows.push({ role: 'assistant', text })
          }

          break
        }

        case 'tool/call': {
          const { callId, name, arguments: rawArgs } = (event as SessionEvent<'tool/call'>).data

          calls.set(String(callId), { name, rawArgs, row: rows.length })
          rows.push({ context: toolArgsPreview(rawArgs), name, role: 'tool' })
          break
        }

        case 'tool/result': {
          // Replay's whole point is that the transcript reads the same coming
          // back as it did going out. Without this the resumed session showed
          // `⏺ Read(src/a.ts)` and nothing under it — every result the session
          // had ever produced, gone.
          const { message, error, meta } = (event as SessionEvent<'tool/result'>).data
          const block = message.content[0]
          const call = calls.get(String(block.toolCallId))

          if (!call) {
            break
          }

          calls.delete(String(block.toolCallId))

          const view = this.presentResult(call.name, call.rawArgs, block.content, Boolean(block.isError), meta)
          const row = rows[call.row]

          if (row) {
            row.text =
              error || block.isError || view.failed
                ? failureText(view.resultText, error)
                : (view.structuredDiff && diffSummary(view.structuredDiff)) || view.resultText
          }

          break
        }

        default:
          break
      }
    }

    return rows
  }

  private resolveRoute(): ModelRoute | undefined {
    if (this.opts.provider && this.opts.model) {
      return { model: this.opts.model, provider: this.opts.provider }
    }

    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection?: () => { model?: string; provider?: string; reasoningEffort?: string } | undefined }
      | undefined
    const sel = defaults?.currentSelection?.()

    if (sel?.provider && sel.model) {
      return { model: sel.model, provider: sel.provider, reasoningEffort: sel.reasoningEffort } as ModelRoute
    }

    return undefined
  }

  private buildSessionInfo(route: ModelRoute | undefined, cwd: string): SessionInfo {
    let toolNames: string[] = []

    try {
      const tools = this.ctx.get('tools') as { schemas?: (scope?: unknown) => Array<{ name: string }> } | undefined

      toolNames = (tools?.schemas?.() ?? []).map(t => t.name).sort()
    } catch {
      toolNames = []
    }

    return {
      cwd,
      model: route ? route.model : '(default)',
      permission_mode: this.permissionMode,
      reasoning_effort: route?.reasoningEffort,
      skills: {},
      tools: toolNames.length ? { harness: toolNames } : {},
      version: PLUGIN_VERSION || 'dsh'
    }
  }

  private bindAgent(agent: Agent): void {
    this.agentDisposers.push(
      this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (session === agent.session) {
          this.onSessionEvent(event)

          return
        }

        // Any OTHER session on the bus — a sibling top-level session, or a
        // subagent's. `onChildSessionEvent` ignores everything it has not been
        // told is a child by the lifecycle edge below, so a second session in
        // the same process can never leak into this one's transcript.
        this.onChildSessionEvent(String(session.header.id), event)
      }) as () => void
    )
    this.agentDisposers.push(
      this.ctx.on('subagent/start', (info: { id: unknown }) => this.startChild(String(info.id))) as () => void
    )
    this.agentDisposers.push(
      this.ctx.on('subagent/end', (info: { id: unknown; lastAssistantMessage?: ContentBlock[]; stopReason?: string }) =>
        this.endChild(String(info.id), info.stopReason, info.lastAssistantMessage)
      ) as () => void
    )
    this.agentDisposers.push(
      this.ctx.on('agent/status', ({ agent: subject, status }: { agent: Agent; status: 'idle' | 'running' }) => {
        if (subject !== agent) {
          return
        }

        if (status === 'idle' && this.turnStarted) {
          // Safety net: a turn that ends without a turn/end record (dispose,
          // hard error) still has to release the composer.
          this.finishTurn()
        }
      }) as () => void
    )
  }

  // ── subagents ──────────────────────────────────────────────────────────
  //
  // The delegating tool call tells us nothing about what the child did — it
  // returns the child's final answer and no more. Everything the inline tree
  // draws (which tools ran, how long, how many tokens) is read off the child's
  // OWN session log, joined to the lifecycle edges by the child's session id.

  private publishChild(
    type: 'subagent.complete' | 'subagent.start' | 'subagent.thinking' | 'subagent.tool',
    id: string,
    child: ChildRun,
    extra: Record<string, unknown> = {}
  ): void {
    this.publishLocalEvent({
      payload: {
        goal: child.goal,
        subagent_id: id,
        task_index: child.index,
        tool_count: child.toolCount,
        ...extra
      },
      session_id: this.sid,
      type
    } as GatewayEvent)
  }

  private startChild(id: string): void {
    if (this.children.has(id)) {
      return
    }

    this.childCount += 1

    const child: ChildRun = {
      goal: '',
      index: this.childCount,
      inputTokens: 0,
      outputTokens: 0,
      startedAt: Date.now(),
      toolCount: 0
    }

    this.children.set(id, child)
    // The label arrives a beat later, on the child's own descriptor event; the
    // row is upserted by id, so the goal fills itself in.
    this.publishChild('subagent.start', id, child, { status: 'running' })
  }

  private endChild(id: string, stopReason?: string, output?: ContentBlock[]): void {
    const child = this.children.get(id)

    if (!child) {
      return
    }

    this.children.delete(id)
    this.settledChildren.push(child)
    this.publishChild('subagent.complete', id, child, {
      duration_seconds: Math.max(0, Date.now() - child.startedAt) / 1000,
      input_tokens: child.inputTokens,
      output_tokens: child.outputTokens,
      status: stopReason === 'completed' ? 'completed' : stopReason === 'interrupted' ? 'interrupted' : 'failed',
      summary: compactPreview(textOf(output, ['text']), 200)
    })
  }

  /**
   * A delegation's own ⎿ row.
   *
   * The tool answers with the child's whole reply, which is addressed to the
   * MODEL — the parent reads it and writes its own answer, and pasting it into
   * the row buries the turn under work the reader did not ask to see. The
   * original states the delegation instead: `Backgrounded agent` when the child
   * is still going, `Done (2 tool uses · 48.0k tokens · 11s)` when it is not.
   *
   * The counts come from the child's own log, and only when the join is
   * unambiguous: exactly one delegation in flight and exactly one child settled
   * under it. Parallel delegations are explicitly encouraged by the harness's
   * prompt, and attributing one child's tokens to another's row is worse than
   * reporting only the time this call took — which is always this call's own.
   */
  private delegationView(
    callId: string,
    view: { failed?: boolean; resultRaw?: string; resultText: string; structuredDiff?: StructuredDiffPayload },
    durationS?: number
  ): typeof view {
    if (!this.inFlightDelegations.delete(callId) || view.failed) {
      return view
    }

    const claimed = this.inFlightDelegations.size === 0 && this.settledChildren.length === 1 ? this.settledChildren[0] : undefined

    this.settledChildren = []

    const took = durationS === undefined ? '' : `${Math.max(1, Math.round(durationS))}s`

    // A background delegation has not produced any of that yet: it returns a
    // durable id and keeps running.
    if (!claimed) {
      const backgrounded = /^started (?:background )?subagent/.test(view.resultText.trim())

      return {
        ...view,
        resultRaw: view.resultRaw ?? view.resultText,
        resultText: backgrounded ? 'Backgrounded agent' : took ? `Done (${took})` : 'Done'
      }
    }

    const parts = [
      `${claimed.toolCount} tool ${claimed.toolCount === 1 ? 'use' : 'uses'}`,
      `${fmtK(claimed.inputTokens + claimed.outputTokens)} tokens`,
      took
    ].filter(Boolean)

    return { ...view, resultRaw: view.resultRaw ?? view.resultText, resultText: `Done (${parts.join(' · ')})` }
  }

  private onChildSessionEvent(id: string, event: SessionEvent): void {
    const child = this.children.get(id)

    if (!child) {
      return
    }

    switch (event.type) {
      case 'subagent/descriptor': {
        const label = (event.data as { label?: string }).label

        if (label && label !== child.goal) {
          child.goal = label
          this.publishChild('subagent.start', id, child, { status: 'running' })
        }

        break
      }

      case 'tool/call': {
        const { name, arguments: rawArgs } = (event as SessionEvent<'tool/call'>).data

        child.toolCount += 1
        this.publishChild('subagent.tool', id, child, {
          tool_name: name,
          tool_preview: toolArgsPreview(rawArgs)
        })
        break
      }

      case 'assistant/message': {
        const { message, usage } = (event as SessionEvent<'assistant/message'>).data

        if (usage) {
          child.inputTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          child.outputTokens += usage.outputTokens
          // …and onto the session odometer, because a delegated step is spend
          // on this session's behalf: it is the same bill, and the stats line
          // and /status have always claimed to count subagents. Only the
          // child's own row counted it before, so a run that fanned out
          // reported a fraction of what it actually used. The two sides of
          // the bus are disjoint (bindAgent routes by session identity), so
          // nothing is counted twice.
          foldUsage(this.usageTotals, usage)
        }

        // One event per step rather than one per delta: a child's reasoning
        // streams as fast as the parent's, and the tree shows the last few
        // lines, not every keystroke of them.
        const reasoning = textOf(message.content, ['reasoning']).trim()

        if (reasoning) {
          this.publishChild('subagent.thinking', id, child, { text: reasoning })
        }

        break
      }

      default:
        break
    }
  }

  // ── session/event → GatewayEvent translation ──────────────────────────
  private onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        this.turnStarted = true
        this.turnText = []
        this.turnReasoning = []
        this.msgStartedHarness = false
        break
      }

      case 'assistant/chunk': {
        const { chunk } = (event as SessionEvent<'assistant/chunk'>).data

        this.onChunk(chunk)
        break
      }

      case 'assistant/message': {
        const { message, usage } = (event as SessionEvent<'assistant/message'>).data
        const text = textOf(message.content, ['text'])

        if (text) {
          this.turnText.push(text)
        }

        const reasoning = textOf(message.content, ['reasoning'])

        if (reasoning) {
          this.turnReasoning.push(reasoning)
        }

        if (usage) {
          this.addUsage(usage)
        }

        break
      }

      case 'tool/call': {
        const { callId, name, arguments: rawArgs } = (event as SessionEvent<'tool/call'>).data
        const id = String(callId)

        this.callNames.set(id, name)
        this.callStarted.set(id, Date.now())
        this.callArgs.set(id, toolArgsPreview(rawArgs))
        this.callRawArgs.set(id, rawArgs)

        if (isDelegationCall(toolTrailLabel(name))) {
          this.inFlightDelegations.add(id)
          // Only children that start from HERE on can belong to this call.
          this.settledChildren = []
        }
        this.publishLocalEvent({
          // `context` is the `⏺ Tool(args)` row's parenthesized half; the
          // fuller `args_text` only surfaces behind ctrl+o. Without a context
          // every row rendered as a bare `⏺ Read`, and the collapsed brief
          // mis-bucketed shell calls it could no longer read a command out of
          // ("Ran 1 shell command" for what is really "Listed 1 directory").
          payload: { args_text: prettyArgs(rawArgs), context: toolArgsPreview(rawArgs), name, tool_id: id },
          session_id: this.sid,
          type: 'tool.start'
        })
        break
      }

      case 'tool/result': {
        const { message, error, meta } = (event as SessionEvent<'tool/result'>).data
        const block = message.content[0]
        const id = String(block.toolCallId)
        const startedAt = this.callStarted.get(id)
        const durationS = startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt) / 1000
        const presented = this.presentResult(
          this.callNames.get(id),
          this.callRawArgs.get(id),
          block.content,
          Boolean(block.isError),
          meta,
          durationS
        )

        this.callRawArgs.delete(id)

        const view = this.delegationView(id, presented, durationS)
        const todos = this.pendingTodos

        this.pendingTodos = null
        this.publishLocalEvent({
          payload: {
            duration_s: durationS,
            error:
              error || block.isError || view.failed ? failureText(view.resultText, error) : undefined,
            name: this.callNames.get(id),
            result_raw: view.resultRaw,
            result_text: view.resultText,
            structured_diff: view.structuredDiff,
            todos: todos ?? undefined,
            tool_id: id
          },
          session_id: this.sid,
          type: 'tool.complete'
        })
        this.callStarted.delete(id)
        this.generatingAnnounced.delete(id)
        break
      }

      case 'turn/end': {
        const { reason } = (event as SessionEvent<'turn/end'>).data

        this.finishTurn(reason)
        break
      }

      case 'todo/write': {
        this.pendingTodos = (event as SessionEvent<'todo/write'>).data.todos as unknown[]
        break
      }

      case 'plan/mode': {
        const active = Boolean((event as SessionEvent<'plan/mode'>).data.active)
        const mode = active ? 'plan' : this.permissionMode === 'plan' ? 'default' : this.permissionMode

        if (mode !== this.permissionMode) {
          this.permissionMode = mode
          this.publishLocalEvent({ payload: { mode }, session_id: this.sid, type: 'permission.mode' })
        }

        break
      }

      default:
        break
    }
  }

  private onChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta': {
        if (!chunk.text) {
          return
        }

        if (!this.msgStartedHarness) {
          this.msgStartedHarness = true
          this.publishLocalEvent({ session_id: this.sid, type: 'message.start' })
        }

        this.publishLocalEvent({ payload: { text: chunk.text }, session_id: this.sid, type: 'message.delta' })
        break
      }

      case 'reasoning-delta': {
        if (!chunk.text) {
          return
        }

        this.publishLocalEvent({ payload: { text: chunk.text }, session_id: this.sid, type: 'thinking.delta' })
        break
      }

      case 'tool-call-delta': {
        const id = String(chunk.id)

        if (chunk.name && !this.generatingAnnounced.has(id)) {
          this.generatingAnnounced.add(id)
          this.publishLocalEvent({ payload: { name: chunk.name }, session_id: this.sid, type: 'tool.generating' })
        }

        break
      }

      case 'usage': {
        break
      }

      default:
        break
    }
  }

  private addUsage(usage: TokenUsage): void {
    foldUsage(this.usageTotals, usage)
  }

  private finishTurn(reason?: SessionEvent<'turn/end'>['data']['reason']): void {
    if (!this.turnStarted) {
      return
    }

    this.turnStarted = false
    this.turnCount += 1

    const text = this.turnText.join('')
    const usage = { ...this.usageTotals, ...this.usageSnapshot() }

    // A provider/route failure can close a turn before producing either an
    // assistant message or token usage. Treating that edge as a normal empty
    // completion made the transcript show a blank assistant row and hid the
    // actionable provider error. Preserve partial output when one exists, but
    // surface a genuinely empty failed turn through the gateway error path.
    if (!text && !this.msgStartedHarness && reason && reason.kind !== 'completed') {
      const message = (() => {
        switch (reason.kind) {
          case 'error':
            return reason.error.message || `model request failed (${reason.error.code})`
          case 'aborted':
            return reason.reason.kind === 'user' ? 'model request cancelled' : `model request aborted (${reason.reason.kind})`
          case 'blocked':
            return 'model request was blocked before a response was generated'
          case 'max-tokens':
            return 'model reached its output-token limit before generating a response'
          case 'interrupted':
            return 'model request was interrupted before a response was generated'
          default:
            return `model request ended without a response (${String((reason as { kind?: unknown }).kind ?? 'unknown')})`
        }
      })()

      this.publishLocalEvent({ payload: { message }, session_id: this.sid, type: 'error' })
      this.publishLocalEvent({
        payload: { session_turns: this.turnCount, usage },
        session_id: this.sid,
        type: 'session.stats'
      })
      this.msgStartedHarness = false

      return
    }

    this.publishLocalEvent({
      payload: {
        permission_mode: this.permissionMode,
        reasoning: this.turnReasoning.join('') || undefined,
        session_turns: this.turnCount,
        text,
        usage
      },
      session_id: this.sid,
      type: 'message.complete'
    })
    this.msgStartedHarness = false
  }


  // ── interaction gates (approvals / questions / plan review) ────────────
  private installGates(): void {
    if (this.ctx.get('approval') !== undefined) {
      this.disposers.push(
        this.ctx.on('approval/request', (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
          if (req.agent !== this.agent) {
            return next()
          }

          return this.parkApproval(req)
        }) as () => void
      )
    }

    const userQuestions = this.ctx.get('userQuestions') as
      | { registerProvider: (p: { ask: (r: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer> }) => () => void }
      | undefined

    if (userQuestions) {
      try {
        this.disposers.push(userQuestions.registerProvider({ ask: request => this.parkQuestion(request) }))
      } catch {
        // A composed profile may already carry a provider (DUPLICATE_PROVIDER);
        // yield rather than crash the boot — the other surface answers.
      }
    }
  }

  private parkApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const id = req.callId ? String(req.callId) : ''
    // The SALIENT argument, not the whole argument object. This line is what
    // the user actually reads before saying yes, and a shell call's escalation
    // fields (`sandbox_permissions`, `justification`) crowded the command it is
    // asking about off the end of it — while the warning line below already
    // states the escalation and its justification.
    const command = (id ? this.callArgs.get(id) : undefined) || req.reason || req.toolName

    return new Promise<ApprovalOutcome>(resolve => {
      this.gateApproval = { resolve }
      req.signal?.addEventListener(
        'abort',
        () => {
          if (this.gateApproval?.resolve === resolve) {
            this.gateApproval = null
            resolve('cancelled')
          }
        },
        { once: true }
      )
      this.publishLocalEvent({
        payload: {
          allow_permanent: false,
          command,
          tool_name: req.toolName,
          warning: req.reason ?? null
        },
        session_id: this.sid,
        type: 'approval.request'
      })
    })
  }

  private parkQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const items = request.questions

    return new Promise<AskUserQuestionAnswer>(resolve => {
      const planItem = items.length === 1 && items[0]!.intent?.kind === 'plan-review' ? items[0]! : undefined

      this.gateQuestion = { items: [...items], planApprove: planItem?.intent?.approve, resolve }

      if (planItem) {
        this.publishLocalEvent({
          payload: { bypass_available: true, plan: planItem.detail ?? planItem.question, plan_file_path: null },
          session_id: this.sid,
          type: 'plan.approval'
        })

        return
      }

      this.publishLocalEvent({
        payload: {
          questions: items.map(q => ({
            header: q.header,
            multiSelect: q.multiSelect,
            options: q.options?.map(o => ({ description: o.description, label: o.label })),
            question: q.question
          }))
        },
        session_id: this.sid,
        type: 'question.request'
      })
    })
  }

  private applyPermissionMode(mode: string): void {
    const agent = this.agent

    if (!agent) {
      return
    }

    const planMode = this.ctx.get('planMode') as { set?: (a: Agent, active: boolean) => unknown } | undefined
    const approval = this.ctx.get('approval') as { setPolicy?: (a: Agent, policy: 'ask' | 'never') => void } | undefined

    planMode?.set?.(agent, mode === 'plan')
    approval?.setPolicy?.(agent, mode === 'bypassPermissions' ? 'never' : 'ask')
    this.permissionMode = mode

    if (this.info) {
      this.info = { ...this.info, permission_mode: mode }
    }

    this.publishLocalEvent({ payload: { mode }, session_id: this.sid, type: 'permission.mode' })
  }


  /**
   * Refine a tool result through the tool's own presentation view.
   *
   * The call's name and arguments come in rather than off the live maps, so
   * REPLAY can use this too: the harness projects every card's structured
   * shape through `output.presentationMeta`, which is persisted with the
   * session log precisely so `presentResult` reproduces the identical card
   * from a stored event.
   */
  private presentResult(
    name: string | undefined,
    rawArgs: string | undefined,
    content: readonly ContentBlock[],
    isError: boolean,
    meta: unknown,
    durationS?: number
  ): { failed?: boolean; resultRaw?: string; resultText: string; structuredDiff?: StructuredDiffPayload } {
    const fallback = textOf(content, ['text'])

    if (!name) {
      return { resultText: fallback }
    }

    let view: { card?: string } | undefined

    try {
      const tools = this.ctx.get('tools') as
        | { get?: (n: string, scope?: unknown) => { presentResult?: (a: unknown, r: unknown) => unknown } | undefined }
        | undefined
      const definition = tools?.get?.(name, this.agent as unknown)
      let args: unknown

      try {
        args = rawArgs ? JSON.parse(rawArgs) : undefined
      } catch {
        args = undefined
      }

      view = definition?.presentResult?.(args, { content: [...content], isError, meta }) as { card?: string } | undefined
    } catch {
      view = undefined
    }

    if (!view) {
      return { resultText: fallback }
    }

    if (view.card === 'diff') {
      const diffs = (view as { diffs?: Array<{ newText: string; oldText: null | string; path: string }> }).diffs ?? []
      const first = diffs[0]

      if (first) {
        const patch = structuredPatch(first.path, first.path, first.oldText ?? '', first.newText, '', '', { context: 3 })
        const structuredDiff: StructuredDiffPayload = {
          filePath: first.path,
          hunks: patch.hunks.map(h => ({
            // `\ No newline at end of file` is an artifact of diffing the
            // tool's applied HUNK rather than the whole file: a fragment that
            // stops mid-file has no trailing newline by construction, and the
            // file it came from is usually fine. The row renderer has no marker
            // for it either, so it came out as a phantom context line numbered
            // one past the end. Upstream shows no such row.
            lines: h.lines.filter(line => !line.startsWith('\\')),
            newLines: h.newLines,
            newStart: h.newStart,
            oldLines: h.oldLines,
            oldStart: h.oldStart
          })),
          kind: first.oldText === null ? 'create' : 'update'
        }

        if (first.oldText === null) {
          structuredDiff.content = first.newText
          structuredDiff.firstLine = first.newText.split(String.fromCharCode(10))[0] ?? null
        }

        const extra = diffs.length > 1 ? ` (+${diffs.length - 1} more file${diffs.length > 2 ? 's' : ''})` : ''

        return { resultText: fallback || `updated ${first.path}${extra}`, structuredDiff }
      }
    }

    if (view.card === 'terminal') {
      const terminal = view as { exitCode?: number; output?: string; signal?: string }
      const body = (terminal.output ?? '').replace(/\n+$/, '')
      // A command that exits non-zero is a FAILED call in the original — red
      // bullet, `⎿ Error: Exit code 1` with the command's own stderr beneath.
      // The harness reports it as an ordinary result (a shell exit is not a
      // tool error), so the exit status is the only thing that can say so.
      const signal = terminal.signal
      const exitCode = terminal.exitCode
      const failed = signal !== undefined || (typeof exitCode === 'number' && exitCode !== 0)

      if (!failed) {
        const output = body || fallback

        return { resultRaw: output, resultText: previewBody(output) }
      }

      const status = signal === undefined ? `Exit code ${exitCode}` : `Killed by ${signal}`
      const reported = [status, body].filter(Boolean).join(String.fromCharCode(10))

      return { failed: true, resultRaw: reported, resultText: previewBody(reported) }
    }

    if (view.card === 'generic') {
      // The escape hatch every tool shares: a replacement body for the row. A
      // tool that fenced its output for a markdown client (the shell tools do
      // this on the failure path) would otherwise render its backticks
      // literally in a `⎿` row that does no markdown.
      const generic = view as { content?: ContentBlock[] }
      const text = generic.content ? textOf(generic.content, ['text']) : ''

      return { resultText: unfence(text) || fallback }
    }

    if (view.card === 'search') {
      return searchCard(
        view as {
          files?: { matches?: { line: string; lineNumber: number }[]; path: string }[]
          paths?: string[]
          shape?: string
          total?: number
          truncated?: boolean
        }
      )
    }

    if (view.card === 'web') {
      return webCard(
        view as {
          answer?: string
          kind?: string
          sources?: { title?: string; url: string }[]
          statusCode?: number
          truncated?: boolean
          url?: string
        },
        fallback,
        durationS
      )
    }

    if (view.card === 'read') {
      return readCard(view as { lines?: { number: number; text: string }[] })
    }

    return { resultText: fallback }
  }

  // ── outbound ───────────────────────────────────────────────────────────
  private deliver(text: string, placement: 'followup' | 'steer'): void {
    const agent = this.agent

    if (!agent) {
      this.publishLocalEvent({ payload: { message: 'agent not ready yet' }, type: 'error' })

      return
    }

    const pending = this.pendingImages.get(this.sid)
    const refs = [...new Set(parseImageRefs(text))]
    const images = refs.flatMap(id => {
      const attachment = pending?.get(id)
      return attachment ? [{ attachment, type: 'image' } as ContentBlock] : []
    })

    // The chip is a live attachment contract: once submitted, both attached and
    // deleted chips leave this composer staging area. The durable store retains
    // only images actually included in the session event.
    this.pendingImages.delete(this.sid)
    const message = createUserMessage({ content: [{ text, type: 'text' }, ...images], source: { kind: 'user' } })

    if (placement === 'steer') {
      agent.steer(message)
    } else {
      agent.followup(message)
    }
  }

  private async stageImage(image: IngressImage): Promise<{ height: number; id: number; name: string; token_estimate: number; width: number }> {
    const attachments = this.ctx.get('attachments') as
      | { saveImage?: (input: { data: Uint8Array; mediaType: IngressImage['mediaType']; name: string }) => Promise<ImageAttachmentRef> }
      | undefined

    if (!attachments?.saveImage) {
      throw new Error('image attachments are unavailable: this Harness profile does not mount dsh-attachment')
    }

    const attachment = await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: image.name })
    const id = this.nextImageId++
    const staged = this.pendingImages.get(this.sid) ?? new Map<number, ImageAttachmentRef>()
    staged.set(id, attachment)
    this.pendingImages.set(this.sid, staged)

    return {
      height: attachment.height,
      id,
      name: attachment.name ?? image.name,
      token_estimate: Math.ceil((attachment.width * attachment.height) / 750),
      width: attachment.width
    }
  }

  private async attachImageFromClipboard(): Promise<Record<string, unknown>> {
    try {
      const image = readWindowsClipboardImage()
      if (!image) return { message: 'No image found in clipboard' }
      return await this.stageImage(image)
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to read the clipboard image' }
    }
  }

  private async attachImageFromPath(path: string): Promise<Record<string, unknown>> {
    if (!path.trim()) return { error: 'image path is required' }

    try {
      return await this.stageImage(await readImageFile(path.trim()))
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to read the image file' }
    }
  }

  /**
   * Resolve an explorer/terminal pasted file path for the in-process runtime.
   *
   * The legacy gateway delegates this to `detect_file_drop`; Harness has no
   * subprocess control endpoint, so keep the same public RPC contract here.
   * Image files are staged by `image.attach` before this method is reached;
   * this resolver deliberately turns every other existing file into the normal
   * `@absolute-path` reference understood by the agent tools.
   */
  private detectDroppedFile(raw: string): Record<string, unknown> {
    const text = raw.trim()

    if (!text) return { matched: false }

    let candidate = text

    try {
      if (candidate.startsWith('file://')) {
        candidate = fileURLToPath(candidate)
      } else if (
        (candidate.startsWith('"') && candidate.endsWith('"')) ||
        (candidate.startsWith("'") && candidate.endsWith("'"))
      ) {
        candidate = candidate.slice(1, -1)
      }

      const cwd = this.agent?.session.header.cwd ?? this.opts.cwd ?? this.opts.launchCwd ?? process.cwd()
      const path = resolve(cwd, candidate)
      const stat = statSync(path)

      if (!stat.isFile()) return { matched: false }

      return { is_image: false, matched: true, name: basename(path), text: `@${path}` }
    } catch {
      // Missing/invalid paths remain literal composer text, matching the
      // legacy fallback and avoiding a surprising rewrite of ordinary prose.
      return { matched: false }
    }
  }

  override kill(_reason = 'requested'): void {
    for (const dispose of [...this.agentDisposers.splice(0), ...this.disposers.splice(0)]) {
      try {
        dispose()
      } catch {
        // disposal is best effort during teardown
      }
    }

    this.handle = null
    this.agent = null

    for (const handle of this.live.values()) {
      void handle.dispose().catch(() => {})
    }

    this.live.clear()
    this.pendingImages.clear()
  }


  private async listPersisted(): Promise<SessionHeader[]> {
    const persistence = this.ctx.get('sessionPersistence') as
      | { list?: (signal?: AbortSignal) => Promise<SessionHeader[]> }
      | undefined

    if (!persistence?.list) {
      throw new Error('session history is unavailable: session persistence is not configured')
    }

    const headers = await persistence.list()

    return [...headers].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Remove stale records that never received a user-originated message.
   *
   * This runs before the first live agent is created, providing a second line
   * of defence for records that survived an interrupted close or a persistence
   * flush race. Any unavailable/corrupt record is retained for manual review. */
  private async removeEmptyPersistedSessions(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as
      | {
          delete?: (sessionId: string, signal?: AbortSignal) => Promise<void>
          inspect?: (sessionId: SessionId, signal?: AbortSignal) => Promise<{ events: readonly SessionEvent[] }>
          list?: (signal?: AbortSignal) => Promise<SessionHeader[]>
        }
      | undefined

    if (!persistence?.delete || !persistence.inspect || !persistence.list) {
      return
    }

    let headers: SessionHeader[]

    try {
      headers = await persistence.list()
    } catch {
      return
    }

    for (const header of headers) {
      try {
        const { events } = await persistence.inspect(header.id)

        if (!this.hasUserConversation(events)) {
          await persistence.delete(String(header.id))
        }
      } catch {
        // Keep entries that cannot be inspected/deleted visible for manual cleanup.
      }
    }
  }

  /**
   * Build the small human-facing projection missing from SessionHeader.  The
   * persistence API deliberately lists headers only, so this reads a bounded
   * set of selected logs rather than pretending every stored session has zero
   * messages or using the opaque identity as its label.
   */
  private async persistedSummary(header: SessionHeader): Promise<{
    message_count: number
    preview: string
    title: string
    title_source: 'auto' | 'manual' | 'projected'
  }> {
    const projected = this.cachedTitle(header)?.trim()
    const persistence = this.ctx.get('sessionPersistence') as
      | { inspect?: (id: SessionId, signal?: AbortSignal) => Promise<{ events: readonly SessionEvent[] }> }
      | undefined

    if (!persistence?.inspect) {
      const fallback = `Conversation · ${new Date(header.createdAt * 1000).toLocaleDateString()}`
      return { message_count: 0, preview: '', title: projected || fallback, title_source: projected ? 'projected' : 'auto' }
    }

    try {
      const inspected = await persistence.inspect(header.id)
      const prompts: string[] = []
      let manualTitle: string | undefined

      for (const event of inspected.events) {
        if (event.type === 'user/message') {
          const message = (event as SessionEvent<'user/message'>).data
          if (message.source.kind !== 'user') continue
          const text = textOf(message.content, ['text']).replace(/\s+/g, ' ').trim()
          if (text) prompts.push(text)
        } else if (event.type === 'session/title') {
          const data = (event as SessionEvent<'session/title'>).data
          if (data.source.kind === 'user' && data.title.trim()) manualTitle = data.title.trim()
        }
      }

      const automatic = prompts[0] ? compactPreview(prompts[0], 72) : `Conversation · ${new Date(header.createdAt * 1000).toLocaleDateString()}`
      return {
        message_count: prompts.length,
        preview: prompts.at(-1) ? compactPreview(prompts.at(-1)!, 120) : '',
        title: manualTitle || projected || automatic,
        title_source: manualTitle ? 'manual' : projected ? 'projected' : 'auto'
      }
    } catch {
      const fallback = `Conversation · ${new Date(header.createdAt * 1000).toLocaleDateString()}`
      return { message_count: 0, preview: '', title: projected || fallback, title_source: projected ? 'projected' : 'auto' }
    }
  }

  private async renamePersisted(id: string, title: string): Promise<string> {
    const normalized = title.replace(/\s+/g, ' ').trim()
    if (!normalized) throw new Error('session title must contain visible characters')
    const persistence = this.ctx.get('sessionPersistence') as
      | {
          append?: (sessionId: SessionId, events: readonly SessionEvent[]) => Promise<void>
          inspect?: (sessionId: SessionId, signal?: AbortSignal) => Promise<{ events: readonly SessionEvent[] }>
        }
      | undefined
    if (!persistence?.append || !persistence.inspect) {
      throw new Error('session rename is unavailable: session persistence does not support event updates')
    }
    if (this.live.has(id)) throw new Error('rename the active session with /title')

    const inspected = await persistence.inspect(SessionId(id))
    const event = {
      data: { messageSeqs: [], source: { kind: 'user' }, title: normalized },
      seq: (inspected.events.at(-1)?.seq ?? -1) + 1,
      time: Math.floor(Date.now() / 1000),
      type: 'session/title'
    } as SessionEvent<'session/title'>
    await persistence.append(SessionId(id), [event])
    return normalized
  }

  /** A session becomes resumable only after the user has actually contributed a
   * prompt. Agent setup events, titles, and tool metadata alone are disposable
   * scaffolding and must not turn an unopened tab into permanent history. */
  private hasUserConversation(events: readonly SessionEvent[]): boolean {
    return events.some(event => {
      if (event.type !== 'user/message') {
        return false
      }

      return (event as SessionEvent<'user/message'>).data.source.kind === 'user'
    })
  }

  private async deletePersisted(id: string): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as
      | { delete?: (sessionId: string, signal?: AbortSignal) => Promise<void> }
      | undefined

    if (!persistence?.delete) {
      throw new Error('session deletion is unavailable: session persistence does not support deletion')
    }

    await persistence.delete(id)
  }

  private cachedTitle(header: SessionHeader): string | undefined {
    const cache = this.ctx.get('sessionProjectionCache') as
      | { cachedSnapshot?: (meta: SessionHeader) => { values?: { title?: { title?: string } } } | undefined }
      | undefined

    try {
      return cache?.cachedSnapshot?.(header)?.values?.title?.title
    } catch {
      return undefined
    }
  }

  private titleOf(session: Session): string | undefined {
    const titles = this.ctx.get('sessionTitle') as { get?: (s: Session) => { title: string } | undefined } | undefined

    try {
      return titles?.get?.(session)?.title
    } catch {
      return undefined
    }
  }


  private harnessCommands(): Array<{ description: string; hint?: string; name: string }> {
    const agent = this.agent
    const commands = this.ctx.get('commands') as
      | { list?: (agent: Agent) => Array<{ description: string; input?: { hint: string }; name: string }> }
      | undefined

    if (!agent || !commands?.list) {
      return []
    }

    try {
      return commands.list(agent).map(c => ({ description: c.description, hint: c.input?.hint, name: `/${c.name}` }))
    } catch {
      return []
    }
  }

  private async runHarnessCommand(line: string): Promise<{ output?: string }> {
    const agent = this.agent
    const commands = this.ctx.get('commands') as
      | {
          execute?: (
            agent: Agent,
            line: string,
            signal: AbortSignal
          ) => Promise<{ result: { kind: string; text?: string } } | undefined>
        }
      | undefined

    if (!agent || !commands?.execute) {
      throw new Error('commands unavailable')
    }

    const normalized = line.startsWith('/') ? line : `/${line}`
    const execution = await commands.execute(agent, normalized, new AbortController().signal)

    if (!execution) {
      throw new Error(`unknown command: ${normalized.split(/\s+/)[0] ?? ''}`)
    }

    if (execution.result.kind === 'error') {
      throw new Error(execution.result.text || 'command failed')
    }

    return { output: execution.result.text ?? '' }
  }

  private usageSnapshot(): { context_max?: number; context_percent?: number; context_used?: number } {
    const agent = this.agent
    const meter = this.ctx.get('tokenMeter') as
      | { measure?: (session: Session) => { totalTokens: number } }
      | undefined

    if (!agent || !meter?.measure) {
      return {}
    }

    try {
      const used = meter.measure(agent.session).totalTokens
      const max = this.contextWindow

      return {
        context_max: max,
        context_percent: max ? Math.min(100, Math.round((used / max) * 100)) : undefined,
        context_used: used
      }
    } catch {
      return {}
    }
  }

  private contextWindow: number | undefined

  private async refreshContextWindow(): Promise<void> {
    const route = this.selection.current

    if (!route) {
      return
    }

    const llm = this.ctx.get('llm') as
      | { resolveModelInfo?: (p: string, m: string) => Promise<{ context?: { contextWindow?: number } }> }
      | undefined

    try {
      const info = await llm?.resolveModelInfo?.(route.provider, route.model)

      this.contextWindow = info?.context?.contextWindow
    } catch {
      this.contextWindow = undefined
    }
  }

  private async applyModelSwitch(rawValue: string): Promise<{ ok: boolean; provider?: string; value?: string; error?: string }> {
    const raw = rawValue.trim()

    if (!raw) {
      return { error: 'no model given', ok: false }
    }

    let provider = this.selection.current?.provider
    let model = raw

    const flagMatch = raw.match(/^(\S+)\s+--provider\s+(\S+)$/)

    if (flagMatch) {
      model = flagMatch[1]!
      provider = flagMatch[2]!
    } else if (raw.includes(':')) {
      const idx = raw.indexOf(':')

      provider = raw.slice(0, idx)
      model = raw.slice(idx + 1)
    }

    if (!provider) {
      return { error: 'no provider selected', ok: false }
    }

    const route = { model, provider, reasoningEffort: this.selection.current?.reasoningEffort } as ModelRoute

    this.selection.current = route
    void this.refreshContextWindow()

    const defaults = this.ctx.get('agentDefaultModel') as
      | { saveSelection?: (next: ModelRoute) => Promise<void> }
      | undefined

    void defaults?.saveSelection?.(route).catch(() => {})

    if (this.info) {
      this.info = { ...this.info, model, profile_name: provider }
      this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
    }

    return { ok: true, provider, value: model }
  }

  private async listManagedProviders(): Promise<{
    current_provider?: string
    items: Array<Record<string, unknown>>
    protocols: string[]
  }> {
    const llm = this.ctx.get('llm') as
      | {
          listModels?: (provider: string) => Promise<ReadonlyArray<{ id: string }>>
          listProviders?: () => Array<{ id: string; name: string }>
        }
      | undefined
    const settings = this.ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
    const value = settings?.get?.(PI_AI_SETTINGS_NS)
    const profiles = value && typeof value === 'object' && 'providers' in value
      ? (value as { providers?: unknown }).providers
      : undefined
    const profileMap = profiles && typeof profiles === 'object' && !Array.isArray(profiles)
      ? profiles as Record<string, ManagedProviderProfile>
      : {}
    const current = this.selection.current?.provider
    const codexAuth = await openAiCodexStatus()
    const items = await Promise.all((llm?.listProviders?.() ?? []).map(async provider => {
      const profile = profileMap[provider.id]
      const managed = isManagedProviderId(provider.id)
      const credential = managed && profile?.apiKeyEnv
        ? await this.ctx.credentials.describe(credentialRef(profile.apiKeyEnv))
        : undefined
      let models: string[] = []

      try {
        models = ((await llm?.listModels?.(provider.id)) ?? []).map(model => model.id)
      } catch {
        // A partial profile must remain visible and removable.
      }

      if (provider.id === 'openai-codex') {
        return {
          current: provider.id === current,
          display_name: provider.name,
          id: provider.id,
          models,
          removable: false,
          type: 'oauth',
          warning: !codexAuth.authenticated ? (codexAuth.login_error || 'Sign in with ChatGPT to activate') : undefined
        }
      }

      return {
        api: profile?.api,
        base_url: profile?.baseURL,
        image_models: profile?.models
          ?.filter(model => model.input?.includes('image'))
          .flatMap(model => typeof model.id === 'string' ? [model.id] : []),
        credential_configured: credential?.configured,
        credential_source: credential?.source,
        credential_writable: credential?.writable,
        current: provider.id === current,
        display_name: profile?.displayName || provider.name,
        id: provider.id,
        models,
        removable: managed,
        type: managed ? 'api_key' : 'system'
      }
    }))

    return { current_provider: current, items, protocols: [...supportedProtocols()] }
  }

  private async saveManagedProvider(params: Record<string, unknown>): Promise<{ id: string; saved: boolean }> {
    const requestedId = nonEmptyString(params.id) ?? nonEmptyString(params.display_name)
    if (!requestedId) throw new Error('provider name is required')

    const id = isManagedProviderId(requestedId) ? requestedId : managedProviderId(requestedId)
    const displayName = nonEmptyString(params.display_name) ?? id
    const baseURL = nonEmptyString(params.base_url)
    const api = nonEmptyString(params.api) ?? 'openai-completions'
    const models = modelsFrom(params.models)
    const imageModels = imageModelsFrom(params.image_models, models)
    const apiKey = nonEmptyString(params.api_key)

    if (!baseURL) throw new Error('base URL is required')
    try {
      const parsed = new URL(baseURL)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol')
    } catch {
      throw new Error('base URL must be a valid http(s) URL')
    }
    if (!supportedProtocols().includes(api)) throw new Error(`unsupported provider protocol: ${api}`)
    if (!models.length) throw new Error('add at least one model id')

    const settings = this.ctx.get('settings') as
      | { mutate?: (ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]) => Promise<void> }
      | undefined
    if (!settings?.mutate) throw new Error('Harness settings service is unavailable')

    const ref = managedCredentialRef(id)
    const existing = await this.ctx.credentials.describe(credentialRef(ref))
    if (!apiKey && !existing.configured) throw new Error('API key is required for a new provider')

    const createdCredential = !!apiKey && !existing.configured
    if (apiKey) await this.ctx.credentials.set(credentialRef(ref), apiKey)

    try {
      await settings.mutate(PI_AI_SETTINGS_NS, [{
        op: 'set',
        path: ['providers', id],
        value: {
          api,
          apiKeyEnv: ref,
          baseURL,
          displayName,
          models: models.map(id => ({ id, input: imageModels.includes(id) ? ['text', 'image'] : ['text'] }))
        }
      }])
    } catch (error) {
      // Do not leave a new secret behind if its profile was rejected. Existing
      // credentials are intentionally retained because they may still belong
      // to the prior, working version of this managed provider.
      if (createdCredential) {
        await this.ctx.credentials.unset(credentialRef(ref)).catch(() => {})
      }
      throw error
    }

    return { id, saved: true }
  }

  private async removeManagedProvider(rawId: unknown): Promise<{ id: string; removed: boolean }> {
    const id = nonEmptyString(rawId)
    if (!id || !isManagedProviderId(id)) throw new Error('only providers created by Makima can be removed')

    const settings = this.ctx.get('settings') as
      | { mutate?: (ns: string, ops: readonly { op: 'unset'; path: readonly string[] }[]) => Promise<void> }
      | undefined
    if (!settings?.mutate) throw new Error('Harness settings service is unavailable')

    await settings.mutate(PI_AI_SETTINGS_NS, [{ op: 'unset', path: ['providers', id] }])
    await this.ctx.credentials.unset(credentialRef(managedCredentialRef(id)))

    return { id, removed: true }
  }

  // ── RPCs ───────────────────────────────────────────────────────────────
  override request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const p = (params ?? {}) as Record<string, unknown>

    switch (method) {
      case 'setup.status':
        return Promise.resolve({ provider_configured: true } as T)

      case 'plugins.list':
      case 'plugins.install':
      case 'plugins.remove':
      case 'plugins.runtime': {
        const inventory = this.ctx.get('pluginInventory') as {
          list?: () => unknown
          listProfile?: (profile: string) => unknown
          install?: (profile: string, specifier: string) => unknown
          remove?: (profile: string, packageName: string) => unknown
        } | undefined
        const requestedProfile = typeof p.profile === 'string' && p.profile.trim() ? p.profile : undefined
        const profile = resolveManagedProfile({ configured: requestedProfile ?? this.opts.profile })

        if (!inventory) {
          return Promise.reject(new Error('plugin management is unavailable: the profile does not mount pluginInventory'))
        }

        if (method === 'plugins.runtime') {
          if (!inventory.list) return Promise.reject(new Error('plugin management is unavailable: pluginInventory.list is not mounted'))
          return Promise.resolve(inventory.list()) as Promise<T>
        }

        if (method === 'plugins.list') {
          if (!inventory.listProfile) return Promise.reject(new Error('plugin management is unavailable: pluginInventory.listProfile is not mounted'))
          return Promise.resolve(inventory.listProfile(profile)) as Promise<T>
        }

        if (method === 'plugins.install') {
          const specifier = typeof p.specifier === 'string' ? p.specifier.trim() : ''

          if (!specifier) return Promise.reject(new Error('plugin install requires a package specifier'))
          if (!inventory.install) return Promise.reject(new Error('plugin management is unavailable: pluginInventory.install is not mounted'))
          return Promise.resolve(inventory.install(profile, specifier)) as Promise<T>
        }

        const packageName = typeof p.package_name === 'string' ? p.package_name.trim() : ''

        if (!packageName) return Promise.reject(new Error('plugin remove requires a package name'))
        if (!inventory.remove) return Promise.reject(new Error('plugin management is unavailable: pluginInventory.remove is not mounted'))
        return Promise.resolve(inventory.remove(profile, packageName)) as Promise<T>
      }

      case 'session.create':
        return this.harnessReady.then(async () => {
          if (this.startFailed) {
            throw new Error(this.startFailed)
          }

          // Boot uses the agent created by start(); later calls (/new, /clear)
          // spin up a fresh session and switch the binding to it.
          if (this.agent && !this.sessionCreateConsumed) {
            this.sessionCreateConsumed = true

            return { info: this.info ?? undefined, session_id: this.sid } as T
          }

          const handle = await this.createAgent()

          this.attach(handle)
          this.sessionCreateConsumed = true

          return { info: this.info ?? undefined, session_id: this.sid } as T
        })

      case 'session.close': {
        const id = String(p.session_id ?? '')
        const handle = this.live.get(id)
        const discardEmpty = Boolean(handle && !this.hasUserConversation(handle.agent.session.events))

        return (async () => {
          if (handle) {
            this.live.delete(id)

            if (this.handle === handle) {
              for (const dispose of this.agentDisposers.splice(0)) {
                try {
                  dispose()
                } catch {
                  // best effort
                }
              }

              this.handle = null
              this.agent = null
            }

            // Session disposal may flush its creation/header events to durable
            // storage. Wait for it before deleting an untouched session, or a
            // delayed flush can recreate the record after deletion.
            try {
              await handle.dispose()
            } catch {
              // Releasing the live handle remains best effort.
            }
          }

          // Deletion follows disposal deliberately: persistence can receive a
          // final flush while dispose() settles. Failure leaves the 0-message
          // row visible for the user to remove manually, but never blocks close.
          if (discardEmpty) {
            try {
              await this.deletePersisted(id)
            } catch {
              // best effort
            }
          }

          this.pendingImages.delete(id)
          return { discarded_empty: discardEmpty, ok: true } as T
        })()
      }

      case 'session.resume':
      case 'session.activate': {
        const id = String(p.session_id ?? '')

        return (async () => {
          let handle = this.live.get(id)

          if (!handle) {
            handle = await this.resumeAgent(id)
          }

          this.attach(handle)

          const messages = this.rehydrate(handle.agent.session.events)
          const running = handle.agent.status === 'running'

          this.publishLocalEvent({ payload: this.info!, session_id: this.sid, type: 'session.info' })
          this.publishLocalEvent({
            // The odometer AND the totals: both were just replayed out of the
            // log, and the next end-of-turn result may be a whole turn away.
            payload: { session_turns: this.turnCount, usage: { ...this.usageTotals } },
            session_id: this.sid,
            type: 'session.stats'
          })

          return {
            info: this.info ?? undefined,
            message_count: messages.length,
            messages,
            running,
            session_id: id,
            started_at: handle.agent.session.header.createdAt,
            status: running ? 'working' : 'idle'
          } as T
        })()
      }

      case 'session.most_recent': {
        return this.listPersisted().then(headers => {
          const latest = headers[0]

          return (latest ? { session_id: String(latest.id) } : {}) as T
        })
      }

      case 'session.rename': {
        const id = String(p.session_id ?? '')
        const title = typeof p.title === 'string' ? p.title : ''
        if (!id) return Promise.reject(new Error('session_id is required'))
        return this.renamePersisted(id, title).then(accepted => ({ session_id: id, title: accepted }) as T)
      }

      case 'session.title': {
        const agent = this.agent
        const titles = this.ctx.get('sessionTitle') as
          | {
              get?: (s: unknown) => { title: string } | undefined
              rename?: (s: unknown, t: string) => { title: string }
            }
          | undefined

        if (!agent || !titles) {
          return Promise.resolve({} as T)
        }

        const requested = typeof p.title === 'string' ? p.title.trim() : ''

        try {
          if (requested) {
            const snap = titles.rename?.(agent.session, requested)

            return Promise.resolve({ title: snap?.title ?? requested } as T)
          }

          return Promise.resolve({ title: titles.get?.(agent.session)?.title } as T)
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }

      case 'prompt.submit': {
        this.deliver(String(p.text ?? ''), 'followup')

        return Promise.resolve({ ok: true } as T)
      }

      case 'image.clipboard':
        return this.attachImageFromClipboard().then(result => result as T)

      case 'clipboard.paste':
        return this.attachImageFromClipboard().then(result => {
          // The legacy bracketed-paste path expects `{ attached, count }`,
          // whereas the direct composer image probe consumes image metadata.
          // Preserve both RPC contracts instead of silently staging an image
          // that the bracketed-paste UI cannot render.
          const id = typeof result.id === 'number' ? result.id : undefined
          return (id === undefined
            ? result
            : { ...result, attached: true, count: id }) as T
        })

      case 'image.attach':
        return this.attachImageFromPath(String(p.path ?? '')).then(result => result as T)

      case 'input.detect_drop':
        return Promise.resolve(this.detectDroppedFile(String(p.text ?? '')) as T)

      case 'session.steer': {
        this.deliver(String(p.text ?? ''), 'steer')

        return Promise.resolve({ ok: true } as T)
      }

      case 'session.interrupt': {
        this.agent?.cancel({ kind: 'user' })

        return Promise.resolve({ ok: true } as T)
      }

      case 'session.active_list': {
        const sessions = [...this.live.entries()].map(([id, handle]) => ({
          current: id === this.sid,
          cwd: handle.agent.session.header.cwd,
          id,
          last_active: undefined,
          message_count: handle.agent.session.events.filter(e => e.type === 'user/message').length,
          model: this.selection.current?.model,
          started_at: handle.agent.session.header.createdAt,
          status: handle.agent.status === 'running' ? 'working' : 'idle',
          title: this.titleOf(handle.agent.session)
        }))

        return Promise.resolve({ sessions } as T)
      }

      case 'session.list':
        return this.listPersisted().then(async headers => {
          const limit = typeof p.limit === 'number' && Number.isSafeInteger(p.limit) && p.limit >= 0
            ? p.limit
            : 50
          const selected = headers.slice(0, limit)
          // Do not fan out unbounded disk work for a large history list. Eight
          // concurrent inspections keep the browser responsive on JSONL and
          // SQLite persistence alike.
          const summaries: Array<Awaited<ReturnType<typeof this.persistedSummary>>> = []
          for (let start = 0; start < selected.length; start += 8) {
            summaries.push(...await Promise.all(selected.slice(start, start + 8).map(header => this.persistedSummary(header))))
          }
          const sessions = selected.map((header, index) => ({
            cwd: header.cwd,
            id: String(header.id),
            ...summaries[index]!,
            source: 'harness',
            started_at: header.createdAt
          }))

          return { sessions } as T
        })

      case 'session.delete': {
        const id = String(p.session_id ?? '')

        if (!id) {
          return Promise.reject(new Error('session_id is required'))
        }

        if (this.live.has(id)) {
          return Promise.reject(new Error(`cannot delete active session "${id}"`))
        }

        return this.deletePersisted(id).then(() => ({ deleted: id } as T))
      }

      case 'commands.catalog': {
        const pairs = SLASHES.map(s => [s.name, s.desc] as [string, string])
        const canon: Record<string, string> = {}
        const hints: Record<string, string> = {}

        for (const s of SLASHES) {
          canon[s.name] = s.name

          if (s.hint) {
            hints[s.name] = s.hint
          }
        }

        for (const c of this.harnessCommands()) {
          if (canon[c.name]) {
            continue
          }

          canon[c.name] = c.name
          pairs.push([c.name, c.description])

          if (c.hint) {
            hints[c.name] = c.hint
          }
        }

        return Promise.resolve({ canon, categories: [], hints, pairs, skill_count: 0, sub: {} } as T)
      }

      case 'complete.slash': {
        const text = String(p.text ?? '').toLowerCase() || '/'
        const entries = [
          ...SLASHES,
          ...this.harnessCommands()
            .filter(c => !SLASHES.some(s => s.name === c.name))
            .map(c => ({ desc: c.description, hint: c.hint, name: c.name }))
        ]
        const items = entries.filter(s => s.name.toLowerCase().startsWith(text)).map(s => ({
          display: s.name,
          hint: s.hint,
          meta: s.desc,
          text: s.name
        }))

        return Promise.resolve({ items, replace_from: 1 } as T)
      }

      case 'slash.exec': {
        const line = String(p.command ?? '').trim()
        const name = line.split(/\s+/)[0]?.toLowerCase() ?? ''
        const rest = line.slice(name.length).trim()

        if (name === 'effort') {
          if (!this.selection.current) {
            return Promise.reject(new Error('no model selected'))
          }

          const level = rest || undefined

          this.selection.current = {
            ...this.selection.current,
            reasoningEffort: level && level !== 'auto' ? level : undefined
          } as ModelRoute

          if (this.info) {
            this.info = { ...this.info, reasoning_effort: this.selection.current.reasoningEffort as string | undefined }
            this.publishLocalEvent({ payload: this.info, session_id: this.sid, type: 'session.info' })
          }

          return Promise.resolve({ output: `effort: ${level ?? 'auto'}` } as T)
        }

        if (name === 'context') {
          const usage = this.usageSnapshot()
          const used = usage.context_used ?? 0
          const max = usage.context_max

          return Promise.resolve({
            output: max
              ? `context: ${used.toLocaleString()} of ${max.toLocaleString()} tokens (${usage.context_percent ?? 0}%)`
              : `context: ~${used.toLocaleString()} tokens used (window unknown)`
          } as T)
        }

        return this.runHarnessCommand(line).then(r => r as T)
      }

      case 'command.dispatch': {
        const name = String(p.name ?? '').trim()
        const arg = typeof p.arg === 'string' && p.arg.trim() ? ` ${p.arg.trim()}` : ''

        return this.runHarnessCommand(`${name}${arg}`).then(r => ({ output: r.output, type: 'exec' }) as T)
      }

      case 'providers.list':
        return this.listManagedProviders().then(result => result as T)

      case 'providers.saveOpenAiCompatible':
        return this.saveManagedProvider(p).then(result => result as T)

      case 'providers.remove':
        return this.removeManagedProvider(p.id).then(result => result as T)

      case 'llm.openAiCodex.status':
        return openAiCodexStatus().then(status => status as T)

      case 'llm.openAiCodex.login': {
        const method = p.method === 'device_code' ? 'device_code' : 'browser'
        return startOpenAiCodexLogin(method).then(login => login as T)
      }

      case 'llm.openAiCodex.cancelLogin':
        return cancelOpenAiCodexLogin().then(() => ({ cancelled: true }) as T)

      case 'llm.openAiCodex.logout':
        return logoutOpenAiCodex().then(() => ({ logged_out: true }) as T)

      case 'model.options': {
        return (async () => {
          const llm = this.ctx.get('llm') as
            | {
                listModels?: (provider: string) => Promise<ReadonlyArray<{ id: string }>>
                listProviders?: () => Array<{ id: string; name: string }>
              }
            | undefined
          const current = this.selection.current
          const codexAuth = await openAiCodexStatus()
          const providers = await Promise.all(
            (llm?.listProviders?.() ?? []).map(async info => {
              let models: string[] = []

              try {
                models = ((await llm?.listModels?.(info.id)) ?? []).map(m => m.id)
              } catch {
                models = []
              }

              const isOpenAiCodex = info.id === 'openai-codex'

              return {
                auth_type: isOpenAiCodex ? 'oauth' : undefined,
                authenticated: isOpenAiCodex ? codexAuth.authenticated : true,
                is_current: info.id === current?.provider,
                models,
                name: info.name,
                slug: info.id,
                total_models: models.length,
                warning: isOpenAiCodex && !codexAuth.authenticated
                  ? 'Sign in with ChatGPT to activate'
                  : undefined
              }
            })
          )

          return { model: current?.model, provider: current?.provider, providers } as T
        })()
      }

      case 'model.effort_options': {
        return (async () => {
          const route = this.selection.current

          if (!route) {
            return { supported: false } as T
          }

          const llm = this.ctx.get('llm') as
            | {
                resolveModelInfo?: (
                  p: string,
                  m: string
                ) => Promise<{ reasoning?: { defaultEffort?: string; efforts: ReadonlyArray<{ id: string }> } }>
              }
            | undefined

          try {
            const info = await llm?.resolveModelInfo?.(route.provider, route.model)
            const levels = (info?.reasoning?.efforts ?? []).map(e => e.id)

            return {
              current: (route.reasoningEffort as string | undefined) ?? '',
              levels,
              supported: levels.length > 0
            } as T
          } catch {
            return { supported: false } as T
          }
        })()
      }

      case 'approval.respond': {
        const choice = String(p.choice ?? 'deny')
        const pending = this.gateApproval

        this.gateApproval = null
        pending?.resolve(choice === 'deny' ? 'rejected' : 'allowed-once')

        return Promise.resolve({ ok: true } as T)
      }

      case 'planApproval.respond': {
        const choice = String(p.choice ?? 'deny')
        const feedback = typeof p.feedback === 'string' && p.feedback.trim() ? p.feedback.trim() : undefined
        const pending = this.gateQuestion

        this.gateQuestion = null

        if (pending?.planApprove !== undefined) {
          const item = pending.items[0]!

          if (choice === 'deny') {
            pending.resolve({
              answers: [{ custom: feedback ?? 'Keep planning — the user rejected this plan.', id: item.id, selected: [] }]
            })
          } else {
            pending.resolve({ answers: [{ id: item.id, selected: [pending.planApprove] }] })

            if (choice === 'bypass') {
              this.applyPermissionMode('bypassPermissions')
            } else if (choice === 'default' || choice === 'accept-edits') {
              this.applyPermissionMode('default')
            }
          }
        }

        return Promise.resolve({ ok: true } as T)
      }

      case 'question.respond': {
        const answers = (p.answers ?? null) as null | Record<string, string>
        const pending = this.gateQuestion

        this.gateQuestion = null

        if (pending) {
          if (!answers) {
            pending.resolve({ answers: pending.items.map(q => ({ id: q.id, selected: [] })) })
          } else {
            pending.resolve({
              answers: pending.items.map(q => {
                const raw = answers[q.question]

                if (typeof raw !== 'string' || raw === '') {
                  return { id: q.id, selected: [] }
                }

                const labels = new Set((q.options ?? []).map(o => o.label))
                const parts = q.multiSelect ? raw.split(', ') : [raw]
                const selected = parts.filter(part => labels.has(part))
                const custom = parts.filter(part => !labels.has(part)).join(', ')

                return { custom: custom || undefined, id: q.id, selected }
              })
            })
          }
        }

        return Promise.resolve({ ok: true } as T)
      }

      case 'permission.cycle': {
        const order = ['default', 'plan', 'bypassPermissions']
        const next = order[(order.indexOf(this.permissionMode) + 1) % order.length]!

        this.applyPermissionMode(next)

        return Promise.resolve({ mode: next } as T)
      }

      case 'config.set': {
        if (String(p.key ?? '') === 'logoColor') {
          // Banner palette is a TUI-local preference: no harness service owns
          // it, so persist it in the app's own config (read back at the next
          // launch's first paint by readLogoColorSync).
          const value = String(p.value ?? '')

          try {
            const dir = appHome()
            const file = join(dir, 'config.json')
            let current: Record<string, unknown> = {}

            try {
              current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
            } catch {
              current = {}
            }

            mkdirSync(dir, { recursive: true })
            writeFileSync(file, `${JSON.stringify({ ...current, logoColor: value }, null, 2)}\n`, 'utf8')

            return Promise.resolve({ ok: true, value } as T)
          } catch (err) {
            return Promise.resolve({ error: err instanceof Error ? err.message : String(err), ok: false } as T)
          }
        }

        // `/reasoning show|hide` is a TUI-local display toggle — no harness
        // service owns it, and returning `{}` (the catch-all below) left the
        // command silently doing nothing: the caller only flips its state when
        // a value comes back. Echoing it makes an advertised command work.
        // The reasoning EFFORT levels this command also accepts belong to the
        // harness and keep falling through to `/effort`.
        if (String(p.key ?? '') === 'reasoning') {
          const value = String(p.value ?? '')
            .trim()
            .toLowerCase()

          if (value === 'show' || value === 'hide') {
            return Promise.resolve({ ok: true, value } as T)
          }
        }

        if (String(p.key ?? '') === 'model') {
          return this.applyModelSwitch(String(p.value ?? '')).then(r => r as T)
        }

        if (String(p.key ?? '') === 'permission_mode') {
          const value = String(p.value ?? 'default')
          const mode = value === 'acceptEdits' ? 'default' : value

          this.applyPermissionMode(mode)

          return Promise.resolve({ mode, ok: true, persisted: false } as T)
        }

        return Promise.resolve({} as T)
      }

      // Local filesystem completion is backend-free in the parent class.
      case 'complete.path':
        return super.request(method, params)

      case 'session.usage': {
        const usage = this.usageSnapshot()

        return Promise.resolve(
          {
            calls: this.usageTotals.calls,
            context_max: usage.context_max,
            context_percent: usage.context_percent,
            context_used: usage.context_used,
            input: this.usageTotals.input,
            model: this.selection.current?.model,
            output: this.usageTotals.output,
            total: this.usageTotals.total
          } as T
        )
      }

      case 'session.status':
      case 'config.get':
      case 'terminal.resize':
        return Promise.resolve({} as T)

      default:
        // Anything not yet mapped degrades gracefully, exactly like the
        // original client's contract for older backends.
        return Promise.resolve({} as T)
    }
  }
}
