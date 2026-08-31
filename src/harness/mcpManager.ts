/**
 * Backend-owned MCP runtime for the in-process Harness gateway.
 *
 * The TUI never opens an MCP transport. This manager runs in the same Cordis
 * context as the agent and owns persistence, plugin fibers, tool registration,
 * reconnect policy, and teardown. Each live server is one dsh-mcp-client fiber.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

export type McpTransport = 'stdio' | 'streamable-http'
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

export interface McpServerRuntime extends McpServerConfig {
  enabled: boolean
  error?: string
  status: McpRuntimeStatus
  tools: number
}

interface LiveServer {
  config: McpServerConfig
  fiber: Fiber
}

const RECONNECT = { enabled: true, initialDelayMs: 500, maxAttempts: 10, maxDelayMs: 30_000 }
const TOOL_CALL_TIMEOUT_MS = 60_000

const normalizeMap = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}

export function validateMcpServer(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'server must be an object'

  const server = input as McpServerConfig
  if (typeof server.name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(server.name.trim())) {
    return 'invalid name (1-32 chars of A-Z, a-z, 0-9, _ or -)'
  }
  if (server.transport !== 'stdio' && server.transport !== 'streamable-http') {
    return "transport must be 'stdio' or 'streamable-http'"
  }
  if (server.transport === 'stdio' && (!server.command || !server.command.trim())) return 'stdio transport requires command'
  if (server.transport === 'streamable-http' && (!server.url || !server.url.trim())) return 'streamable-http transport requires url'

  return null
}

export function normalizeMcpServer(server: McpServerConfig): McpServerConfig {
  const normalized: McpServerConfig = {
    enabled: server.enabled !== false,
    name: server.name.trim(),
    transport: server.transport
  }

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

/** Agent-server-side MCP lifecycle manager. */
export class HarnessMcpManager {
  private readonly live = new Map<string, LiveServer>()
  private readonly statuses = new Map<string, { error?: string; status: McpRuntimeStatus }>()

  constructor(private readonly ctx: Context) {}

  configPath(): string {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mcp.json')
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

  async setEnabled(name: string, enabled: boolean): Promise<McpServerRuntime> {
    const servers = this.read()
    const index = servers.findIndex(server => server.name === name)
    if (index < 0) throw new Error(`MCP server not found: ${name}`)
    servers[index] = { ...servers[index]!, enabled }
    this.write(servers)
    await this.sync(servers)
    return this.summarize(servers)[index]!
  }

  async delete(name: string): Promise<void> {
    const servers = this.read()
    const next = servers.filter(server => server.name !== name)
    if (next.length === servers.length) throw new Error(`MCP server not found: ${name}`)
    this.write(next)
    await this.sync(next)
  }

  async dispose(): Promise<void> {
    for (const [name, entry] of [...this.live]) {
      this.live.delete(name)
      this.statuses.set(name, { status: 'stopped' })
      try {
        await entry.fiber.dispose()
      } catch {
        // The mcp client has already removed its tools when disposal rejects.
      }
    }
  }

  private read(): McpServerConfig[] {
    try {
      const path = this.configPath()
      if (!existsSync(path)) return []
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { servers?: unknown }
      if (!Array.isArray(parsed.servers)) return []
      return parsed.servers.flatMap(server => validateMcpServer(server) ? [] : [normalizeMcpServer(server as McpServerConfig)])
    } catch {
      return []
    }
  }

  private write(servers: McpServerConfig[]): void {
    const path = this.configPath()
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ servers }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  }

  private async sync(servers: readonly McpServerConfig[]): Promise<void> {
    const desired = new Map(servers.filter(server => server.enabled !== false).map(server => [server.name, server]))

    for (const [name, entry] of [...this.live]) {
      const target = desired.get(name)
      if (target && sameConfig(entry.config, target)) continue
      this.live.delete(name)
      this.statuses.set(name, { status: target ? 'connecting' : 'stopped' })
      try {
        await entry.fiber.dispose()
      } catch {
        // best effort; dsh-mcp-client unregisters all tools during teardown
      }
    }

    for (const [name, config] of desired) {
      if (this.live.has(name)) continue
      this.statuses.set(name, { status: 'connecting' })
      try {
        const fiber = this.ctx.plugin(mcpClient, this.toClientConfig(config)) as Fiber & PromiseLike<Fiber>
        this.live.set(name, { config: normalizeMcpServer(config), fiber })
        void fiber.then(
          () => this.statuses.set(name, { status: 'connected' }),
          cause => {
            this.live.delete(name)
            this.statuses.set(name, { error: cause instanceof Error ? cause.message : String(cause), status: 'failed' })
          }
        )
      } catch (cause) {
        this.statuses.set(name, { error: cause instanceof Error ? cause.message : String(cause), status: 'failed' })
      }
    }
  }

  private summarize(servers: readonly McpServerConfig[]): McpServerRuntime[] {
    const toolNames = this.toolNames()
    return servers.map(config => {
      const enabled = config.enabled !== false
      const state = this.statuses.get(config.name)
      const prefix = `mcp__${config.name}__`
      return {
        ...normalizeMcpServer(config),
        enabled,
        error: state?.error,
        status: enabled ? (state?.status ?? 'connecting') : 'disabled',
        tools: toolNames.filter(name => name.startsWith(prefix)).length
      }
    })
  }

  private toolNames(): string[] {
    try {
      const tools = this.ctx.get('tools') as { schemas?: (scope?: unknown) => Array<{ name: string }> } | undefined
      return (tools?.schemas?.() ?? []).map(tool => tool.name)
    } catch {
      return []
    }
  }

  private toClientConfig(server: McpServerConfig): mcpClient.Config {
    const base = {
      failOnStartupError: true,
      reconnect: RECONNECT,
      serverName: server.name,
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS
    }
    return server.transport === 'stdio'
      ? { ...base, args: server.args ?? [], command: server.command ?? '', cwd: server.cwd ?? '', env: server.env ?? {}, transport: 'stdio' } as mcpClient.Config
      : { ...base, headers: server.headers ?? {}, transport: 'streamable-http', url: server.url ?? '' } as mcpClient.Config
  }
}
