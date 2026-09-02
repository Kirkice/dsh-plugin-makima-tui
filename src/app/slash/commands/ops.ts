import type {
  BrowserManageResponse,
  CommandsCatalogResponse,
  DelegationPauseResponse,
  ProcessStopResponse,
  ReloadEnvResponse,
  ReloadMcpResponse,
  RollbackDiffResponse,
  RollbackListResponse,
  RollbackRestoreResponse,
  SlashExecResponse,
  SpawnTreeListResponse,
  SpawnTreeLoadResponse,
  ToolsConfigureResponse
} from '../../../gatewayTypes.js'
import { qualityGateStatusLabel, qualityGateSummary, type QualityGateCheck } from '../../../domain/qualityGate.js'
import { inspectVcs } from '../../../lib/vcs.js'
import type { PanelSection } from '../../../types.js'
import { applyDelegationStatus, getDelegationState } from '../../delegationStore.js'
import { patchOverlayState } from '../../overlayStore.js'
import { getSpawnHistory, pushDiskSnapshot, setDiffPair, type SpawnSnapshot } from '../../spawnHistoryStore.js'
import type { SlashCommand } from '../types.js'

interface ManagedMcpServer {
  agentIds?: string[]
  enabled: boolean
  error?: string
  managed?: boolean
  name: string
  runtimeDisabled?: boolean
  status?: 'connected' | 'connecting' | 'disabled' | 'failed' | 'stopped'
  toolNames?: string[]
  tools?: number
  transport: 'stdio' | 'streamable-http' | 'external'
}

interface ManagedMcpTool {
  agentIds?: string[]
  enabled: boolean
  name: string
}

interface ManagedMcpListResponse {
  config_path?: string
  policy_path?: string
  servers?: ManagedMcpServer[]
}

interface ManagedMcpToolsResponse {
  tools?: ManagedMcpTool[]
}

interface ManagedMcpMutationResponse {
  deleted?: string
  server?: ManagedMcpServer
}

interface SkillInfo {
  category?: string
  description?: string
  name?: string
  path?: string
}

interface SkillsListResponse {
  skills?: Record<string, string[]>
}

interface SkillsInspectResponse {
  info?: SkillInfo
}

interface SkillsSearchResponse {
  results?: { description?: string; name: string }[]
}

interface SkillsInstallResponse {
  installed?: boolean
  name?: string
}

interface SkillsBrowseItem {
  description?: string
  name: string
  source?: string
  trust?: string
}

interface SkillsBrowseResponse {
  items?: SkillsBrowseItem[]
  page?: number
  total?: number
  total_pages?: number
}

interface SkillsReloadResponse {
  output?: string
}

interface ManagedPlugin {
  builtIn: boolean
  bundle: boolean
  dependency: boolean
  packageName: string
  specifier: string
}

interface RuntimePlugin {
  enabled: boolean
  entryId: string
  fiberPhase: 'active' | 'failed' | 'loading' | 'pending' | 'unloading' | null
  moduleName: string
}

interface ManagedPluginListResponse {
  entries?: unknown
  profile?: unknown
}

interface RuntimePluginListResponse {
  entries?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const profileEntries = (value: unknown): ManagedPlugin[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    const row = asRecord(entry)
    if (!row || typeof row.packageName !== 'string' || typeof row.specifier !== 'string') return []

    return [
      {
        builtIn: row.builtIn === true,
        bundle: row.bundle === true,
        dependency: row.dependency === true,
        packageName: row.packageName,
        specifier: row.specifier
      }
    ]
  })
}

const runtimeEntries = (value: unknown): RuntimePlugin[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    const row = asRecord(entry)
    if (!row || typeof row.entryId !== 'string' || typeof row.moduleName !== 'string') return []

    const fiberPhase = row.fiberPhase
    if (fiberPhase !== null && !['active', 'failed', 'loading', 'pending', 'unloading'].includes(String(fiberPhase))) return []

    return [
      {
        enabled: row.enabled === true,
        entryId: row.entryId,
        fiberPhase: fiberPhase as RuntimePlugin['fiberPhase'],
        moduleName: row.moduleName
      }
    ]
  })
}

const workspaceCwd = (ctx: { ui: { info: null | { cwd?: string } } }) => ctx.ui.info?.cwd || process.cwd()

export const opsCommands: SlashCommand[] = [
  {
    help: 'stop background processes',
    name: 'stop',
    run: (_arg, ctx) => {
      ctx.gateway
        .rpc<ProcessStopResponse>('process.stop', {})
        .then(
          ctx.guarded<ProcessStopResponse>((r) => {
            const killed = Number(r.killed ?? 0)
            const noun = killed === 1 ? 'process' : 'processes'
            ctx.transcript.sys(`stopped ${killed} background ${noun}`)
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    aliases: ['reload_mcp'],
    argumentHint: '[now|always]',
    help: 'reload MCP servers in the live session (warns about prompt cache invalidation)',
    name: 'reload-mcp',
    run: (arg, ctx) => {
      // Parse arg: `now` / `always` skip the confirmation gate.
      // `always` additionally persists approvals.mcp_reload_confirm=false.
      const a = (arg || '').trim().toLowerCase()

      const params: { session_id: string | null; confirm?: boolean; always?: boolean } = {
        session_id: ctx.sid
      }

      if (a === 'now' || a === 'approve' || a === 'once' || a === 'yes') {
        params.confirm = true
      } else if (a === 'always') {
        params.confirm = true
        params.always = true
      }

      ctx.gateway
        .rpc<ReloadMcpResponse>('reload.mcp', params)
        .then(
          ctx.guarded<ReloadMcpResponse>((r) => {
            if (r.status === 'confirm_required') {
              ctx.transcript.sys(r.message || '/reload-mcp requires confirmation')

              return
            }

            if (r.status === 'reloaded') {
              ctx.transcript.sys(
                params.always ? 'MCP servers reloaded · future /reload-mcp will run without confirmation' : 'MCP servers reloaded'
              )

              return
            }

            ctx.transcript.sys('reload complete')
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    aliases: ['skills-manage'],
    help: 'open the local Skills manager',
    name: 'manage-skills',
    run: (_arg, _ctx) => patchOverlayState({ skillsMcpManager: 'skills' })
  },

  {
    argumentHint:
      '[manage|list|reload|tools <server>|enable <server>|disable <server>|enable-tool <tool>|disable-tool <tool>|delete <server>]',
    help: 'list every live MCP scope and control services or individual MCP tools',
    name: 'mcp',
    run: (arg, ctx) => {
      const [action = 'manage', ...nameParts] = arg.trim().split(/\s+/).filter(Boolean)
      const name = nameParts.join(' ')

      if (action === 'manage' || action === 'ui') {
        patchOverlayState({ skillsMcpManager: 'mcp' })
        return
      }

      if (action === 'list' || action === 'reload') {
        const method = action === 'reload' ? 'mcp.manager.reload' : 'mcp.manager.list'
        ctx.gateway
          .rpc<ManagedMcpListResponse>(method, {})
          .then(
            ctx.guarded((r) => {
              const servers = r.servers ?? []
              if (!servers.length)
                return ctx.transcript.sys(
                  `no MCP tools are visible in the global or live Agent scopes · ${r.config_path ?? '~/.dsh/mcp.json'}`
                )
              ctx.transcript.panel('Global MCP Servers', [
                {
                  rows: servers.map((server) => [
                    server.name,
                    `${server.status ?? (server.enabled ? 'connecting' : 'disabled')} · ${server.transport} · ${server.tools ?? 0} tools · ${server.agentIds?.join(', ') || 'global'}${server.managed === false ? (server.runtimeDisabled ? ' · external runtime-disabled' : ' · externally managed') : ''}${server.error ? ` · ${server.error}` : ''}`
                  ])
                },
                {
                  text:
                    action === 'reload'
                      ? 'Makima-owned clients reconciled; the inventory covers global and live Agent scopes.'
                      : `Runtime policy: ${r.policy_path ?? '~/.dsh/makima-mcp-policy.json'}`
                }
              ])
            })
          )
          .catch(ctx.guardedErr)
        return
      }

      if (action === 'tools') {
        if (!name) return ctx.transcript.sys('usage: /mcp tools <server>')
        ctx.gateway
          .rpc<ManagedMcpToolsResponse>('mcp.manager.tools', { name })
          .then(
            ctx.guarded((r) => {
              const tools = r.tools ?? []
              if (!tools.length) return ctx.transcript.sys(`no visible MCP tools for ${name}`)
              ctx.transcript.panel(`MCP Tools · ${name}`, [
                {
                  rows: tools.map((tool) => [
                    tool.name,
                    `${tool.enabled ? 'enabled' : 'runtime-disabled'} · ${tool.agentIds?.join(', ') || 'global'}`
                  ])
                }
              ])
            })
          )
          .catch(ctx.guardedErr)
        return
      }

      if (!name || !['enable', 'disable', 'delete', 'enable-tool', 'disable-tool'].includes(action)) {
        return ctx.transcript.sys(
          'usage: /mcp [manage|list|reload|tools <server>|enable <server>|disable <server>|enable-tool <tool>|disable-tool <tool>|delete <server>]'
        )
      }

      if (action === 'enable-tool' || action === 'disable-tool') {
        ctx.gateway
          .rpc<ManagedMcpMutationResponse>('mcp.manager.set_tool_enabled', { enabled: action === 'enable-tool', name })
          .then(
            ctx.guarded(() => {
              ctx.transcript.sys(
                `MCP tool ${name} ${action === 'enable-tool' ? 'enabled globally' : 'disabled globally by runtime policy'}`
              )
            })
          )
          .catch(ctx.guardedErr)
        return
      }

      const rpc = action === 'delete' ? 'mcp.manager.delete' : 'mcp.manager.set_enabled'
      const params = action === 'delete' ? { name } : { enabled: action === 'enable', name }
      ctx.gateway
        .rpc<ManagedMcpListResponse>('mcp.manager.list', {})
        .then(
          ctx.guarded((result) => {
            const server = result.servers?.find((entry) => entry.name === name)
            if (action === 'delete' && server?.managed === false) {
              ctx.transcript.sys(
                `MCP ${name} is externally managed and cannot be deleted here; use /mcp disable ${name} for Makima runtime control`
              )
              return
            }
            return ctx.gateway
              .rpc<ManagedMcpMutationResponse>(rpc, params)
              .then(
                ctx.guarded(() => {
                  const outcome =
                    action === 'delete'
                      ? 'deleted and unloaded'
                      : action === 'enable'
                        ? 'enabled'
                        : server?.managed === false
                          ? 'disabled by Makima runtime policy (external service remains running)'
                          : 'disabled and unloaded'
                  ctx.transcript.sys(`MCP ${name} ${outcome}`)
                })
              )
              .catch(ctx.guardedErr)
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    help: 're-read the .env into the running session',
    name: 'reload',
    run: (_arg, ctx) => {
      ctx.gateway
        .rpc<ReloadEnvResponse>('reload.env', {})
        .then(
          ctx.guarded<ReloadEnvResponse>((r) => {
            const n = Number(r.updated ?? 0)
            const noun = n === 1 ? 'var' : 'vars'

            ctx.transcript.sys(`reloaded .env (${n} ${noun} updated)`)
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    argumentHint: '[connect [<url>]|disconnect|status]',
    help: 'manage browser CDP connection [connect|disconnect|status]',
    name: 'browser',
    run: (arg, ctx) => {
      const [rawAction = 'status', ...rest] = arg.trim().split(/\s+/).filter(Boolean)
      const action = rawAction.toLowerCase()

      if (!['connect', 'disconnect', 'status'].includes(action)) {
        return ctx.transcript.sys('usage: /browser [connect|disconnect|status] [url] · persistent: set browser.cdp_url in config.yaml')
      }

      const sid = ctx.sid ?? null
      const url = action === 'connect' ? rest.join(' ').trim() || 'http://127.0.0.1:9222' : undefined

      if (url) {
        ctx.transcript.sys(`checking Chromium-family browser remote debugging at ${url}...`)
      }

      ctx.gateway
        .rpc<BrowserManageResponse>('browser.manage', { action, session_id: sid, ...(url && { url }) })
        .then(
          ctx.guarded<BrowserManageResponse>((r) => {
            // Without a session we can't subscribe to streamed
            // browser.progress events, so flush the bundled list.
            if (!sid) {
              r.messages?.forEach((message) => ctx.transcript.sys(message))
            }

            if (action === 'status') {
              return ctx.transcript.sys(
                r.connected
                  ? `browser connected: ${r.url || '(url unavailable)'}`
                  : 'browser not connected (try /browser connect <url> or set browser.cdp_url in config.yaml)'
              )
            }

            if (action === 'disconnect') {
              return ctx.transcript.sys('browser disconnected')
            }

            if (r.connected) {
              ctx.transcript.sys('Browser connected to live Chromium-family browser via CDP')
              ctx.transcript.sys(`Endpoint: ${r.url || '(url unavailable)'}`)
              ctx.transcript.sys('next browser tool call will use this CDP endpoint')
            }
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    argumentHint: '[list | diff <n> | restore <n>]',
    help: 'list, diff, or restore checkpoints',
    name: 'rollback',
    run: (arg, ctx) => {
      if (!ctx.sid) {
        return ctx.transcript.sys('no active session — nothing to rollback')
      }

      const trimmed = arg.trim()
      const [first = '', ...rest] = trimmed.split(/\s+/).filter(Boolean)
      const lower = first.toLowerCase()

      if (!trimmed || lower === 'list' || lower === 'ls') {
        return ctx.gateway
          .rpc<RollbackListResponse>('rollback.list', { session_id: ctx.sid })
          .then(
            ctx.guarded<RollbackListResponse>((r) => {
              if (!r.enabled) {
                return ctx.transcript.sys('checkpoints are not enabled')
              }

              const checkpoints = r.checkpoints ?? []

              if (!checkpoints.length) {
                return ctx.transcript.sys('no checkpoints found')
              }

              ctx.transcript.panel('Rollback checkpoints', [
                {
                  rows: checkpoints.map((c, idx) => [
                    `${idx + 1}. ${c.hash.slice(0, 10)}`,
                    [c.timestamp, c.message].filter(Boolean).join(' · ') || '(no metadata)'
                  ])
                }
              ])
            })
          )
          .catch(ctx.guardedErr)
      }

      if (lower === 'diff') {
        const hash = rest[0]

        if (!hash) {
          return ctx.transcript.sys('usage: /rollback diff <checkpoint>')
        }

        return ctx.gateway
          .rpc<RollbackDiffResponse>('rollback.diff', { hash, session_id: ctx.sid })
          .then(
            ctx.guarded<RollbackDiffResponse>((r) => {
              const body = (r.rendered || r.diff || '').trim()

              if (!body && !r.stat) {
                return ctx.transcript.sys('no changes since this checkpoint')
              }

              const text = [r.stat || '', body].filter(Boolean).join('\n\n')
              ctx.transcript.page(text, 'Rollback diff')
            })
          )
          .catch(ctx.guardedErr)
      }

      const hash = first
      const filePath = rest.join(' ').trim()

      return ctx.gateway
        .rpc<RollbackRestoreResponse>('rollback.restore', {
          ...(filePath ? { file_path: filePath } : {}),
          hash,
          session_id: ctx.sid
        })
        .then(
          ctx.guarded<RollbackRestoreResponse>((r) => {
            if (!r.success) {
              return ctx.transcript.sys(`rollback failed: ${r.error || r.message || 'unknown error'}`)
            }

            const target = filePath || 'workspace'
            const detail = r.reason || r.message || r.restored_to || 'restored'
            ctx.transcript.sys(`rollback restored ${target}: ${detail}`)

            if ((r.history_removed ?? 0) > 0) {
              ctx.transcript.setHistoryItems((prev) => ctx.transcript.trimLastExchange(prev))
            }
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    aliases: ['tasks'],
    help: 'open the spawn-tree dashboard (live audit + kill/pause controls)',
    name: 'agents',
    run: (arg, ctx) => {
      const sub = arg.trim().toLowerCase()

      // Stay compatible with the gateway `/agents [pause|resume|status]` CLI —
      // explicit subcommands skip the overlay and act directly so scripts and
      // multi-step flows can drive it without entering interactive mode.
      if (sub === 'pause' || sub === 'resume' || sub === 'unpause') {
        const paused = sub === 'pause'
        ctx.gateway.gw
          .request<DelegationPauseResponse>('delegation.pause', { paused })
          .then((r) => {
            applyDelegationStatus({ paused: r?.paused })
            ctx.transcript.sys(`delegation · ${r?.paused ? 'paused' : 'resumed'}`)
          })
          .catch(ctx.guardedErr)

        return
      }

      if (sub === 'status') {
        const d = getDelegationState()
        ctx.transcript.sys(
          `delegation · ${d.paused ? 'paused' : 'active'} · caps d${d.maxSpawnDepth ?? '?'}/${d.maxConcurrentChildren ?? '?'}`
        )

        return
      }

      patchOverlayState({ agents: true, agentsInitialHistoryIndex: 0 })
    }
  },

  {
    argumentHint: '[<n>|last|list|load <path>]',
    help: 'replay a completed spawn tree · `/replay [N|last|list|load <path>]`',
    name: 'replay',
    run: (arg, ctx) => {
      const history = getSpawnHistory()
      const raw = arg.trim()
      const lower = raw.toLowerCase()

      // ── Disk-backed listing ─────────────────────────────────────
      if (lower === 'list' || lower === 'ls') {
        ctx.gateway
          .rpc<SpawnTreeListResponse>('spawn_tree.list', {
            limit: 30,
            session_id: ctx.sid ?? 'default'
          })
          .then(
            ctx.guarded<SpawnTreeListResponse>((r) => {
              const entries = r.entries ?? []

              if (!entries.length) {
                return ctx.transcript.sys('no archived spawn trees on disk for this session')
              }

              const rows: [string, string][] = entries.map((e) => {
                const ts = e.finished_at ? new Date(e.finished_at * 1000).toLocaleString() : '?'
                const label = e.label || `${e.count} subagents`

                return [`${ts} · ${e.count}×`, `${label}\n  ${e.path}`]
              })

              ctx.transcript.panel('Archived spawn trees', [{ rows }])
            })
          )
          .catch(ctx.guardedErr)

        return
      }

      // ── Disk-backed load by path ─────────────────────────────────
      if (lower.startsWith('load ')) {
        const path = raw.slice(5).trim()

        if (!path) {
          return ctx.transcript.sys('usage: /replay load <path>')
        }

        ctx.gateway
          .rpc<SpawnTreeLoadResponse>('spawn_tree.load', { path })
          .then(
            ctx.guarded<SpawnTreeLoadResponse>((r) => {
              if (!r.subagents?.length) {
                return ctx.transcript.sys('snapshot empty or unreadable')
              }

              // Push onto the in-memory history so the overlay picks it up
              // by index 1 just like any other snapshot.
              pushDiskSnapshot(r, path)
              patchOverlayState({ agents: true, agentsInitialHistoryIndex: 1 })
            })
          )
          .catch(ctx.guardedErr)

        return
      }

      // ── In-memory nav (same-session) ─────────────────────────────
      if (!history.length) {
        return ctx.transcript.sys('no completed spawn trees this session · try /replay list')
      }

      let index = 1

      if (raw && lower !== 'last') {
        const parsed = parseInt(raw, 10)

        if (Number.isNaN(parsed) || parsed < 1 || parsed > history.length) {
          return ctx.transcript.sys(`replay: index out of range 1..${history.length} · use /replay list for disk`)
        }

        index = parsed
      }

      patchOverlayState({ agents: true, agentsInitialHistoryIndex: index })
    }
  },

  {
    argumentHint: '<baseline> <candidate>',
    help: 'diff two completed spawn trees · `/replay-diff <baseline> <candidate>` (indexes from /replay list or history N)',
    name: 'replay-diff',
    run: (arg, ctx) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean)

      if (parts.length !== 2) {
        return ctx.transcript.sys('usage: /replay-diff <a> <b>  (e.g. /replay-diff 1 2 for last two)')
      }

      const [a, b] = parts
      const history = getSpawnHistory()

      const resolve = (token: string): null | SpawnSnapshot => {
        const n = parseInt(token!, 10)

        if (Number.isFinite(n) && n >= 1 && n <= history.length) {
          return history[n - 1] ?? null
        }

        return null
      }

      const baseline = resolve(a!)
      const candidate = resolve(b!)

      if (!baseline || !candidate) {
        return ctx.transcript.sys(`replay-diff: could not resolve indices · history has ${history.length} entries`)
      }

      setDiffPair({ baseline, candidate })
      patchOverlayState({ agents: true, agentsInitialHistoryIndex: 0 })
    }
  },

  {
    aliases: ['reload_skills'],
    help: 're-scan installed skills in the live TUI gateway',
    name: 'reload-skills',
    run: (_arg, ctx) => {
      ctx.gateway
        .rpc<SkillsReloadResponse>('skills.reload', {})
        .then(
          ctx.guarded<SkillsReloadResponse>((r) => {
            ctx.transcript.page(r.output || 'skills reloaded', 'Reload Skills')
            ctx.gateway
              .rpc<CommandsCatalogResponse>('commands.catalog', {})
              .then(
                ctx.guarded<CommandsCatalogResponse>((catalog) => {
                  if (!catalog?.pairs) {
                    return
                  }

                  ctx.local.setCatalog({
                    canon: (catalog.canon ?? {}) as Record<string, string>,
                    categories: catalog.categories ?? [],
                    hints: (catalog.hints ?? {}) as Record<string, string>,
                    pairs: catalog.pairs as [string, string][],
                    skillCount: (catalog.skill_count ?? 0) as number,
                    sub: (catalog.sub ?? {}) as Record<string, string[]>
                  })
                })
              )
              .catch(() => {})
          })
        )
        .catch(ctx.guardedErr)
    }
  },

  {
    argumentHint: '[manage | list | inspect <name> | search <query> | install <name or url>]',
    help: 'open the Skills Hub; manage local Skills or browse, inspect, and install skills',
    name: 'skills',
    run: (arg, ctx, cmd) => {
      const text = arg.trim()

      // The Skills Hub now shares the native manager with MCP.  Keeping this
      // as the no-argument entry point makes /skills the discoverable surface
      // for enable/disable/delete operations instead of hiding it behind the
      // legacy /manage-skills alias.
      if (!text || text.toLowerCase() === 'manage') {
        return patchOverlayState({ skillsMcpManager: 'skills' })
      }

      const [sub, ...rest] = text.split(/\s+/)
      const query = rest.join(' ').trim()
      const { rpc } = ctx.gateway
      const { panel, sys } = ctx.transcript

      const runViaSlashWorker = () => {
        ctx.gateway.gw
          .request<SlashExecResponse>('slash.exec', { command: cmd.slice(1), session_id: ctx.sid })
          .then((r) => {
            if (ctx.stale()) {
              return
            }

            const body = r?.output || '/skills: no output'
            const formatted = r?.warning ? `warning: ${r.warning}\n${body}` : body
            const long = formatted.length > 180 || formatted.split('\n').filter(Boolean).length > 2

            long ? ctx.transcript.page(formatted, 'Skills') : ctx.transcript.sys(formatted)
          })
          .catch(ctx.guardedErr)
      }

      if (sub === 'list') {
        rpc<SkillsListResponse>('skills.manage', { action: 'list' })
          .then(
            ctx.guarded<SkillsListResponse>((r) => {
              const cats = Object.entries(r.skills ?? {}).sort()

              if (!cats.length) {
                return sys('no skills available')
              }

              panel(
                'Skills',
                cats.map<PanelSection>(([title, items]) => ({ items, title }))
              )
            })
          )
          .catch(ctx.guardedErr)

        return
      }

      if (sub === 'inspect') {
        if (!query) {
          return sys('usage: /skills inspect <name>')
        }

        rpc<SkillsInspectResponse>('skills.manage', { action: 'inspect', query })
          .then(
            ctx.guarded<SkillsInspectResponse>((r) => {
              const info = r.info ?? {}

              if (!info.name) {
                return sys(`unknown skill: ${query}`)
              }

              const rows: [string, string][] = [
                ['Name', String(info.name)],
                ['Category', String(info.category ?? '')],
                ['Path', String(info.path ?? '')]
              ]

              const sections: PanelSection[] = [{ rows }]

              if (info.description) {
                sections.push({ text: String(info.description) })
              }

              panel('Skill', sections)
            })
          )
          .catch(ctx.guardedErr)

        return
      }

      if (sub === 'search') {
        if (!query) {
          return sys('usage: /skills search <query>')
        }

        rpc<SkillsSearchResponse>('skills.manage', { action: 'search', query })
          .then(
            ctx.guarded<SkillsSearchResponse>((r) => {
              const results = r.results ?? []

              if (!results.length) {
                return sys(`no results for: ${query}`)
              }

              panel(`Search: ${query}`, [{ rows: results.map((s) => [s.name, s.description ?? '']) }])
            })
          )
          .catch(ctx.guardedErr)

        return
      }

      if (sub === 'install') {
        if (!query) {
          return sys('usage: /skills install <name or url>')
        }

        sys(`installing ${query}…`)

        rpc<SkillsInstallResponse>('skills.manage', { action: 'install', query })
          .then(ctx.guarded<SkillsInstallResponse>((r) => sys(r.installed ? `installed ${r.name ?? query}` : 'install failed')))
          .catch(ctx.guardedErr)

        return
      }

      if (sub === 'browse') {
        const pageNum = query ? parseInt(query, 10) : 1

        if (Number.isNaN(pageNum) || pageNum < 1) {
          return sys('usage: /skills browse [page]  (page must be a positive number)')
        }

        sys('fetching community skills (scans 6 sources, may take ~15s)…')

        rpc<SkillsBrowseResponse>('skills.manage', { action: 'browse', page: pageNum })
          .then(
            ctx.guarded<SkillsBrowseResponse>((r) => {
              const items = r.items ?? []

              if (!items.length) {
                return sys(`no skills on page ${pageNum}${r.total ? ` (total ${r.total})` : ''}`)
              }

              const rows: [string, string][] = items.map((s) => [
                s.trust ? `${s.name} · ${s.trust}` : s.name,
                String(s.description ?? '').slice(0, 160)
              ])

              const footer: string[] = []

              if (r.page && r.total_pages) {
                footer.push(`page ${r.page} of ${r.total_pages}`)
              }

              if (r.total) {
                footer.push(`${r.total} skills total`)
              }

              if (r.page && r.total_pages && r.page < r.total_pages) {
                footer.push(`/skills browse ${r.page + 1} for more`)
              }

              panel(`Browse Skills${pageNum > 1 ? ` — p${pageNum}` : ''}`, [
                { rows },
                ...(footer.length ? [{ text: footer.join(' · ') }] : [])
              ])
            })
          )
          .catch(ctx.guardedErr)

        return
      }

      runViaSlashWorker()
    }
  },

  {
    // Port of openclaude's /memory (commands/memory/): no-arg opens the file
    // picker overlay (ensure-create + $EDITOR spawn lives in onMemorySelect;
    // cancel closes silently like the sibling pickers). With arguments it is
    // the bounded-store management surface (hermes-agent memory port):
    // status | pending | approve <id|all> | reject <id|all>, routed to the
    // backend memory_manage control via slash.exec.
    argumentHint: '[status|pending|approve <id|all>|reject <id|all>]',
    help: 'edit memory files, or manage the bounded memory store',
    name: 'memory',
    run: (arg, ctx, cmd) => {
      if (!arg.trim()) {
        return patchOverlayState({ memoryPicker: true })
      }

      ctx.gateway.gw
        .request<SlashExecResponse>('slash.exec', { command: cmd.slice(1), session_id: ctx.sid })
        .then((r) => {
          if (ctx.stale()) {
            return
          }

          const text = r?.output || '/memory: no output'
          const long = text.length > 180 || text.split('\n').filter(Boolean).length > 2

          long ? ctx.transcript.page(text, 'Memory') : ctx.transcript.sys(text)
        })
        .catch(ctx.guardedErr)
    }
  },

  {
    aliases: ['changes', 'vcs'],
    help: 'inspect local changes (Git, Perforce, or Subversion)',
    name: 'change-center',
    run: (_arg, ctx) => {
      void inspectVcs(workspaceCwd(ctx))
        .then((snapshot) => {
          const rows: [string, string][] = [
            ['Provider', snapshot.kind.toUpperCase()],
            ['Workspace', snapshot.label],
            ['Summary', snapshot.summary]
          ]
          const items = snapshot.changes.slice(0, 40).map((change) => `${change.kind[0]!.toUpperCase()} ${change.path} · ${change.status}`)
          if (snapshot.changes.length > items.length) items.push(`… +${snapshot.changes.length - items.length} more changes`)
          if (snapshot.kind === 'none') items.push('No source-control client was detected; file changes remain visible in the transcript.')
          ctx.transcript.panel('Change Center', [{ rows }, ...(items.length ? [{ items, title: 'Open changes' }] : [])])
        })
        .catch(ctx.guardedErr)
    }
  },

  {
    aliases: ['verify', 'quality'],
    help: 'show the latest verification and quality-gate result',
    name: 'quality-gate',
    run: (_arg, ctx) => {
      // Gateway support is optional. The UI still gives an honest empty state
      // instead of inventing test results on older harnesses.
      ctx.gateway.gw
        .request<{ checks?: QualityGateCheck[] }>('quality.gate', { session_id: ctx.sid })
        .then((raw) => {
          if (ctx.stale()) return
          const checks = Array.isArray(raw?.checks) ? raw.checks : []
          const summary = qualityGateSummary(checks)
          const rows: [string, string][] = [
            ['Gate', qualityGateStatusLabel(summary.status)],
            ['Checks', `${summary.total} total · ${summary.passed} passed · ${summary.failed} failed`],
            ['In flight', `${summary.running} running · ${summary.pending} pending`]
          ]
          const items = checks.map(
            (check) =>
              `${qualityGateStatusLabel(check.status)} · ${check.name} · ${check.command}${check.summary ? ` — ${check.summary}` : ''}`
          )
          if (!checks.length)
            items.push('No verification results reported yet. Run checks from the agent or workspace, then reopen this panel.')
          ctx.transcript.panel('Quality Gate', [{ rows }, { items, title: 'Verification checks' }])
        })
        .catch(() =>
          ctx.transcript.panel('Quality Gate', [
            { rows: [['Gate', 'UNAVAILABLE']], items: ['This gateway does not expose quality.gate yet.'] }
          ])
        )
    }
  },

  {
    aliases: ['plugin'],
    argumentHint: '[runtime]',
    help: 'open installed plugins manager or inspect current runtime plugin status',
    name: 'plugins',
    run: (arg, ctx) => {
      const action = arg.trim().toLowerCase()

      if (!action || action === 'list' || action === 'ls') {
        return patchOverlayState({ pluginsHub: true })
      }

      if (!['runtime', 'status'].includes(action)) {
        return ctx.transcript.sys('usage: /plugins [runtime]')
      }

      if (action === 'runtime' || action === 'status') {
        ctx.gateway.gw
          .request<RuntimePluginListResponse>('plugins.runtime', {})
          .then((r) => {
            if (ctx.stale()) return

            const entries = runtimeEntries(r?.entries)
            if (!entries.length) return ctx.transcript.sys('no runtime plugin entries reported by the Harness loader')

            const lines = entries.map((plugin) => {
              const state = plugin.fiberPhase ?? 'inactive'
              const enabled = plugin.enabled ? 'enabled' : 'disabled'
              return `${plugin.enabled && state === 'active' ? '✓' : '!'} ${plugin.moduleName} [${enabled}, ${state}] · ${plugin.entryId}`
            })
            ctx.transcript.page(lines.join('\n'), 'Runtime Plugins')
          })
          .catch(ctx.guardedErr)
        return
      }
    }
  },

  {
    argumentHint: '[enable|disable <name> [name ...]]',
    help: 'enable or disable tools (client-side history reset on change)',
    name: 'tools',
    run: (arg, ctx, cmd) => {
      const [subcommand, ...names] = arg.trim().split(/\s+/).filter(Boolean)

      if (subcommand !== 'disable' && subcommand !== 'enable') {
        ctx.gateway.gw
          .request<SlashExecResponse>('slash.exec', { command: cmd.slice(1), session_id: ctx.sid })
          .then((r) => {
            if (ctx.stale()) {
              return
            }

            const body = r?.output || '/tools: no output'
            const text = r?.warning ? `warning: ${r.warning}\n${body}` : body
            const long = text.length > 180 || text.split('\n').filter(Boolean).length > 2

            long ? ctx.transcript.page(text, 'Tools') : ctx.transcript.sys(text)
          })
          .catch(ctx.guardedErr)

        return
      }

      if (!names.length) {
        ctx.transcript.sys(`usage: /tools ${subcommand} <name> [name ...]`)
        ctx.transcript.sys(`built-in toolset: /tools ${subcommand} web`)
        ctx.transcript.sys(`MCP tool: /tools ${subcommand} github:create_issue`)

        return
      }

      ctx.gateway
        .rpc<ToolsConfigureResponse>('tools.configure', { action: subcommand, names, session_id: ctx.sid })
        .then(
          ctx.guarded<ToolsConfigureResponse>((r) => {
            if (r.info) {
              ctx.session.setSessionStartedAt(Date.now())
              ctx.session.resetVisibleHistory(r.info)
            }

            if (r.changed?.length) {
              ctx.transcript.sys(`${subcommand === 'disable' ? 'disabled' : 'enabled'}: ${r.changed.join(', ')}`)
            }

            if (r.unknown?.length) {
              ctx.transcript.sys(`unknown toolsets: ${r.unknown.join(', ')}`)
            }

            if (r.missing_servers?.length) {
              ctx.transcript.sys(`missing MCP servers: ${r.missing_servers.join(', ')}`)
            }

            if (r.reset) {
              ctx.transcript.sys('session reset. new tool configuration is active.')
            }
          })
        )
        .catch(ctx.guardedErr)
    }
  }
]
