/**
 * Backend-owned MCP runtime for the in-process Harness gateway.
 *
 * Makima owns entries in mcp.json. Other profile-owned MCP clients are observed
 * through the Harness tool registry and can be disabled safely at runtime, but
 * their transport/process is never disposed by Makima.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

export type McpTransport = 'stdio' | 'streamable-http'
export type McpRuntimeTransport = McpTransport | 'external'
export type McpRuntimeStatus = 'connected' | 'connecting' | 'disabled' | 'failed' | 'stopped'

export interface McpServerConfig {
  args?: string[]
  command?: string
  cwd?: string
  enabled?: boolean
  env?: Record<string, string>
  headers?: Record<string, string>
  name: string
  transport: McpTransport
  url?: string
}

export interface McpToolRuntime {
  agentIds: string[]
  enabled: boolean
  name: string
}

export interface McpServerRuntime extends Omit<McpServerConfig, 'transport'> {
  agentIds: string[]
  enabled: boolean
  error?: string
  managed: boolean
  runtimeDisabled: boolean
  status: McpRuntimeStatus
  toolNames: string[]
  tools: number
  transport: McpRuntimeTransport
}

interface LiveServer {
  config: McpServerConfig
  fiber: Fiber
}

interface McpPolicy {
  disabledServers?: string[]
  disabledTools?: string[]
}

interface ToolScope {
  id: string
  key?: unknown
}

const RECONNECT = { enabled: true, initialDelayMs: 500, maxAttempts: 10, maxDelayMs: 30_000 }
const TOOL_CALL_TIMEOUT_MS = 60_000
const MCP_TOOL = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/

const normalizeMap = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}

export function validateMcpServer(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'server must be an object'
  const server = input as McpServerConfig
  if (typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server.name.trim())) return 'invalid name (1-32 chars of A-Z, a-z, 0-9, _ or -)'
  if (server.transport !== 'stdio' && server.transport !== 'streamable-http') return "transport must be 'stdio' or 'streamable-http'"
  if (server.transport === 'stdio' && (!server.command || !server.command.trim())) return 'stdio transport requires command'
  if (server.transport === 'streamable-http' && (!server.url || !server.url.trim())) return 'streamable-http transport requires url'
  return null
}

export function normalizeMcpServer(server: McpServerConfig): McpServerConfig {
  const normalized: McpServerConfig = { enabled: server.enabled !== false, name: server.name.trim(), transport: server.transport }
  if (server.transport === 'stdio') {
    normalized.args = Array.isArray(server.args) ? server.args.filter(arg => typeof arg === 'string') : []
    normalized.command = server.command?.trim() ?? ''
    normalized.cwd = server.cwd?.trim() ?? ''
    normalized.env = normalizeMap(server.env)
  } else {
    normalized.headers = normalizeMap(server.headers)
    normalized.url = server.url?.trim() ?? ''
  }
  return normalized
}

const sameConfig = (left: McpServerConfig, right: McpServerConfig): boolean =>
  JSON.stringify(normalizeMcpServer(left)) === JSON.stringify(normalizeMcpServer(right))

/** Global MCP inventory, lifecycle owner for Makima config, and runtime policy guard. */
export class HarnessMcpManager {
  private readonly live = new Map<string, LiveServer>()
  private readonly statuses = new Map<string, { error?: string; status: McpRuntimeStatus }>()
  private policy: Required<McpPolicy>

  constructor(private readonly ctx: Context) {
    this.policy = this.readPolicy()
    const tools = ctx.get('tools') as { guard?: (guard: (execution: { name?: string }) => string | undefined) => () => void } | undefined
    tools?.guard?.(execution => this.denialFor(execution.name))
  }

  configPath(): string {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mcp.json')
  }

  policyPath(): string {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'makima-mcp-policy.json')
  }

  list(): McpServerRuntime[] {
    return this.summarize(this.read())
  }

  async reload(): Promise<McpServerRuntime[]> {
    const servers = this.read()
    await this.sync(servers)
    return this.summarize(servers)
  }

  async save(input: McpServerConfig): Promise<McpServerRuntime> {
    const error = validateMcpServer(input)
    if (error) throw new Error(error)
    const next = normalizeMcpServer(input)
    const servers = this.read()
    const index = servers.findIndex(server => server.name === next.name)
    if (index >= 0) servers[index] = next
    else servers.push(next)
    this.write(servers)
    await this.sync(servers)
    return this.summarize(servers).find(server => server.name === next.name)!
  }

  /** Managed services really stop/start; external services are guarded at runtime. */
  async setEnabled(name: string, enabled: boolean): Promise<McpServerRuntime> {
    const servers = this.read()
    const index = servers.findIndex(server => server.name === name)
    if (index >= 0) {
      servers[index] = { ...servers[index]!, enabled }
      this.write(servers)
      await this.sync(servers)
      return this.summarize(servers)[index]!
    }
    this.setPolicyItem('disabledServers', name, !enabled)
    const server = this.list().find(item => item.name === name)
    if (!server) throw new Error(`MCP server not found: ${name}`)
    return server
  }

  setToolEnabled(name: string, enabled: boolean): McpToolRuntime {
    const match = MCP_TOOL.exec(name)
    if (!match) throw new Error('tool name must be mcp__<server>__<tool>')
    if (!this.allTools().has(name)) throw new Error(`MCP tool not found: ${name}`)
    this.setPolicyItem('disabledTools', name, !enabled)
    return { agentIds: this.toolAgentIds(name), enabled: !this.denialFor(name), name }
  }

  toolsFor(serverName: string): McpToolRuntime[] {
    return [...this.allTools()].filter(name => MCP_TOOL.exec(name)?.[1] === serverName).sort().map(name => ({
      agentIds: this.toolAgentIds(name), enabled: !this.denialFor(name), name
    }))
  }

  async delete(name: string): Promise<void> {
    const servers = this.read()
    const next = servers.filter(server => server.name !== name)
    if (next.length === servers.length) throw new Error(`Only Makima-managed MCP servers can be deleted: ${name}`)
    this.write(next)
    await this.sync(next)
  }

  async dispose(): Promise<void> {
    for (const [name, entry] of [...this.live]) {
      this.live.delete(name)
      this.statuses.set(name, { status: 'stopped' })
      try { await entry.fiber.dispose() } catch { /* client teardown is best effort */ }
    }
  }

  private read(): McpServerConfig[] {
    try {
      if (!existsSync(this.configPath())) return []
      const parsed = JSON.parse(readFileSync(this.configPath(), 'utf8')) as { servers?: unknown }
      return Array.isArray(parsed.servers)
        ? parsed.servers.flatMap(server => validateMcpServer(server) ? [] : [normalizeMcpServer(server as McpServerConfig)])
        : []
    } catch { return [] }
  }

  private write(servers: McpServerConfig[]): void {
    this.writeJson(this.configPath(), { servers })
  }

  private readPolicy(): Required<McpPolicy> {
    try {
      if (!existsSync(this.policyPath())) return { disabledServers: [], disabledTools: [] }
      const raw = JSON.parse(readFileSync(this.policyPath(), 'utf8')) as McpPolicy
      return {
        disabledServers: Array.isArray(raw.disabledServers) ? raw.disabledServers.filter(name => /^[A-Za-z0-9_-]{1,32}$/.test(name)) : [],
        disabledTools: Array.isArray(raw.disabledTools) ? raw.disabledTools.filter(name => MCP_TOOL.test(name)) : []
      }
    } catch { return { disabledServers: [], disabledTools: [] } }
  }

  private writePolicy(): void {
    this.writeJson(this.policyPath(), this.policy)
  }

  private writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  }

  private setPolicyItem(key: keyof Required<McpPolicy>, item: string, disabled: boolean): void {
    const values = new Set(this.policy[key])
    if (disabled) values.add(item)
    else values.delete(item)
    this.policy = { ...this.policy, [key]: [...values].sort() }
    this.writePolicy()
  }

  private denialFor(name?: string): string | undefined {
    if (!name) return undefined
    const match = MCP_TOOL.exec(name)
    if (!match) return undefined
    if (this.policy.disabledServers.includes(match[1]!)) return `MCP server "${match[1]}" is disabled by Makima runtime policy`
    if (this.policy.disabledTools.includes(name)) return `MCP tool "${name}" is disabled by Makima runtime policy`
    return undefined
  }

  private async sync(servers: readonly McpServerConfig[]): Promise<void> {
    const desired = new Map(servers.filter(server => server.enabled !== false).map(server => [server.name, server]))
    for (const [name, entry] of [...this.live]) {
      const target = desired.get(name)
      if (target && sameConfig(entry.config, target)) continue
      this.live.delete(name)
      this.statuses.set(name, { status: target ? 'connecting' : 'stopped' })
      try { await entry.fiber.dispose() } catch { /* best effort */ }
    }
    for (const [name, config] of desired) {
      if (this.live.has(name)) continue
      this.statuses.set(name, { status: 'connecting' })
      try {
        const fiber = this.ctx.plugin(mcpClient, this.toClientConfig(config)) as Fiber & PromiseLike<Fiber>
        this.live.set(name, { config: normalizeMcpServer(config), fiber })
        void fiber.then(
          () => this.statuses.set(name, { status: 'connected' }),
          cause => { this.live.delete(name); this.statuses.set(name, { error: cause instanceof Error ? cause.message : String(cause), status: 'failed' }) }
        )
      } catch (cause) {
        this.statuses.set(name, { error: cause instanceof Error ? cause.message : String(cause), status: 'failed' })
      }
    }
  }

  private summarize(servers: readonly McpServerConfig[]): McpServerRuntime[] {
    const tools = this.allTools()
    const configured = new Set(servers.map(server => server.name))
    const managed = servers.map(config => this.runtimeFor(config, tools, true))
    const profileServers = this.loaderMcpServers()
    const profileNames = new Set(profileServers.map(server => server.config.name))
    const external = profileServers.flatMap(server => configured.has(server.config.name) ? [] : [this.runtimeFor(server.config, tools, false, server.state)])
    const observed = this.observedMcpServers(tools, new Set([...configured, ...profileNames]))
    return [...managed, ...external, ...observed].sort((left, right) => left.name.localeCompare(right.name))
  }

  private loaderMcpServers(): Array<{ config: McpServerConfig; state?: McpRuntimeStatus }> {
    try {
      const loader = (this.ctx as unknown as { loader?: { entries?: () => Iterable<{ disabled?: boolean; fiber?: { state?: number }; options?: { config?: unknown; name?: unknown } }> } }).loader
      if (!loader?.entries) return []
      return [...loader.entries()].flatMap(entry => {
        if (entry.options?.name !== '@deepseek-ai/dsh-mcp-client') return []
        const raw = entry.options.config && typeof entry.options.config === 'object' ? entry.options.config as Record<string, unknown> : {}
        const candidate: McpServerConfig = raw.transport === 'stdio'
          ? { args: Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [], command: typeof raw.command === 'string' ? raw.command : '', cwd: typeof raw.cwd === 'string' ? raw.cwd : '', enabled: !entry.disabled, env: normalizeMap(raw.env), name: typeof raw.serverName === 'string' ? raw.serverName : '', transport: 'stdio' }
          : { enabled: !entry.disabled, headers: normalizeMap(raw.headers), name: typeof raw.serverName === 'string' ? raw.serverName : '', transport: raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio', url: typeof raw.url === 'string' ? raw.url : '' }
        if (validateMcpServer(candidate)) return []
        const state: McpRuntimeStatus = entry.disabled ? 'disabled' : entry.fiber?.state === 2 ? 'connected' : entry.fiber?.state === 3 ? 'failed' : entry.fiber ? 'connecting' : 'stopped'
        return [{ config: normalizeMcpServer(candidate), state }]
      })
    } catch { return [] }
  }

  private runtimeFor(config: McpServerConfig, toolNames: ReadonlySet<string>, managed: boolean, externalStatus?: McpRuntimeStatus): McpServerRuntime {
    const enabled = config.enabled !== false
    const state = this.statuses.get(config.name)
    const names = [...toolNames].filter(name => MCP_TOOL.exec(name)?.[1] === config.name).sort()
    const runtimeDisabled = this.policy.disabledServers.includes(config.name)
    return { ...normalizeMcpServer(config), agentIds: [...new Set(names.flatMap(name => this.toolAgentIds(name)))].sort(), enabled: managed ? enabled : !runtimeDisabled, error: managed ? state?.error : undefined, managed, runtimeDisabled, status: runtimeDisabled ? 'disabled' : enabled ? (managed ? state?.status ?? 'connecting' : externalStatus ?? 'connected') : 'disabled', toolNames: names, tools: names.length, transport: managed ? config.transport : config.transport }
  }

  private observedMcpServers(toolNames: ReadonlySet<string>, knownNames: ReadonlySet<string>): McpServerRuntime[] {
    const names = new Map<string, string[]>()
    for (const toolName of toolNames) {
      const match = MCP_TOOL.exec(toolName)
      if (!match || knownNames.has(match[1]!)) continue
      const list = names.get(match[1]!) ?? []
      list.push(toolName)
      names.set(match[1]!, list)
    }
    return [...names.entries()].map(([name, toolNames]) => ({ agentIds: [...new Set(toolNames.flatMap(tool => this.toolAgentIds(tool)))].sort(), enabled: !this.policy.disabledServers.includes(name), managed: false, name, runtimeDisabled: this.policy.disabledServers.includes(name), status: this.policy.disabledServers.includes(name) ? 'disabled' : 'connected', toolNames: toolNames.sort(), tools: toolNames.length, transport: 'external' }))
  }

  private scopes(): ToolScope[] {
    const agents = this.ctx.get('agents') as { list?: () => Array<{ id: unknown }> } | undefined
    const live = agents?.list?.() ?? []
    return [{ id: 'global' }, ...live.map(agent => ({ id: String(agent.id), key: agent }))]
  }

  private allTools(): Set<string> {
    const tools = this.ctx.get('tools') as { schemas?: (scope?: unknown) => Array<{ name: string }> } | undefined
    const names = new Set<string>()
    for (const scope of this.scopes()) for (const tool of tools?.schemas?.(scope.key) ?? []) if (MCP_TOOL.test(tool.name)) names.add(tool.name)
    return names
  }

  private toolAgentIds(name: string): string[] {
    const tools = this.ctx.get('tools') as { schemas?: (scope?: unknown) => Array<{ name: string }> } | undefined
    return this.scopes().filter(scope => (tools?.schemas?.(scope.key) ?? []).some(tool => tool.name === name)).map(scope => scope.id)
  }

  private toClientConfig(server: McpServerConfig): mcpClient.Config {
    const base = { failOnStartupError: true, reconnect: RECONNECT, serverName: server.name, toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS }
    return server.transport === 'stdio'
      ? { ...base, args: server.args ?? [], command: server.command ?? '', cwd: server.cwd ?? '', env: server.env ?? {}, transport: 'stdio' } as mcpClient.Config
      : { ...base, headers: server.headers ?? {}, transport: 'streamable-http', url: server.url ?? '' } as mcpClient.Config
  }
}
