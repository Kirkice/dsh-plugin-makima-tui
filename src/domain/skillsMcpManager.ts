import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export type SkillKind = 'bundle' | 'file'
export type SkillLevel = 'project' | 'user'
export type SkillSource = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'
export type McpTransport = 'stdio' | 'streamable-http'

export interface ManagedSkill {
  description: string
  enabled: boolean
  kind: SkillKind
  level: SkillLevel
  name: string
  path: string
  source: SkillSource
  whenToUse: string
}

export interface ManagedSkillDetail extends ManagedSkill {
  content: string
}

export interface ScannedSkill {
  description: string
  kind: SkillKind
  name: string
  sourcePath: string
}

export interface ImportSkillInput {
  kind: SkillKind
  sourcePath: string
}

export interface ImportSkillResult {
  name: string
  ok: boolean
  reason?: string
}

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

export interface SkillsMcpManagerOptions {
  dshHome?: string
  home?: string
  workspace?: string
}

interface Frontmatter {
  body: string
  data: Record<string, string>
}

interface ParsedSkill {
  content: string
  description: string
  enabled: boolean
  name: string
  whenToUse: string
}

const scalar = (value: string) => value.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')

function parseFrontmatter(raw: string): Frontmatter | null {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) return null

  const data: Record<string, string> = {}
  for (const line of lines.slice(1, close)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    data[line.slice(0, colon).trim()] = scalar(line.slice(colon + 1).trim())
  }

  return { body: lines.slice(close + 1).join('\n').trim(), data }
}

function parseSkill(raw: string): ParsedSkill | null {
  const frontmatter = parseFrontmatter(raw)
  if (!frontmatter) return null
  const name = frontmatter.data.name ?? ''
  const description = frontmatter.data.description ?? ''
  if (!name || !description) return null

  const disabled = frontmatter.data['disable-model-invocation']?.toLowerCase() === 'true'
  const invocable = frontmatter.data['user-invocable']?.toLowerCase()
  return {
    content: frontmatter.body,
    description,
    enabled: !disabled || invocable !== 'false',
    name,
    whenToUse: frontmatter.data.whenToUse ?? ''
  }
}

function rewriteInvocation(raw: string, enabled: boolean): string {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new Error('skill requires YAML frontmatter')
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) throw new Error('skill frontmatter is not closed')
  const kept = lines.slice(1, close).filter(line => !/^\s*(disable-model-invocation|user-invocable)\s*:/.test(line))
  if (!enabled) kept.push('disable-model-invocation: true', 'user-invocable: false')
  return [lines[0]!, ...kept, ...lines.slice(close)].join('\n')
}

function normalizeMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export function validateMcpServer(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'server must be an object'
  const server = input as McpServerConfig
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.name ?? '')) return 'invalid name (1-32 chars of A-Za-z0-9_-)'
  if (server.transport !== 'stdio' && server.transport !== 'streamable-http') return "transport must be 'stdio' or 'streamable-http'"
  if (server.transport === 'stdio' && !server.command?.trim()) return 'stdio transport requires command'
  if (server.transport === 'streamable-http' && !server.url?.trim()) return 'streamable-http transport requires url'
  return null
}

export function normalizeMcpServer(server: McpServerConfig): McpServerConfig {
  const base: McpServerConfig = { enabled: server.enabled !== false, name: server.name, transport: server.transport }
  if (server.transport === 'stdio') {
    return { ...base, args: Array.isArray(server.args) ? server.args.filter(arg => typeof arg === 'string') : [], command: server.command?.trim(), cwd: server.cwd ?? '', env: normalizeMap(server.env) }
  }
  return { ...base, headers: normalizeMap(server.headers), url: server.url?.trim() }
}

/** Local filesystem/configuration manager for the Makima process. It deliberately
 * does not own MCP connections; the agent-server remains the runtime owner. */
export class SkillsMcpManager {
  private readonly dshHome: string
  private readonly home: string
  private readonly workspace: string

  constructor(options: SkillsMcpManagerOptions = {}) {
    this.home = options.home ?? homedir()
    this.dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(this.home, '.dsh')
    this.workspace = resolve(options.workspace ?? process.cwd())
  }

  mcpConfigPath(): string {
    return join(this.dshHome, 'mcp.json')
  }

  listSkills(): ManagedSkill[] {
    const projectRoot = this.findProjectRoot()
    const roots: Array<[string, SkillSource]> = [
      [join(projectRoot, '.dsh', 'skills'), 'project-dsh'],
      [join(projectRoot, '.agents', 'skills'), 'project-agents'],
      [join(this.dshHome, 'skills'), 'user-dsh'],
      [join(this.home, '.agents', 'skills'), 'user-agents']
    ]
    return roots.flatMap(([path, source]) => this.scanRoot(path, source)).sort((a, b) => a.name.localeCompare(b.name))
  }

  readSkill(path: string): ManagedSkillDetail | null {
    const summary = this.listSkills().find(skill => skill.path === resolve(path))
    if (!summary) return null
    const parsed = parseSkill(readFileSync(summary.path, 'utf8'))
    return parsed ? { ...summary, content: parsed.content } : null
  }

  setSkillEnabled(path: string, enabled: boolean): void {
    const skill = this.requireManagedSkill(path)
    writeFileSync(skill.path, rewriteInvocation(readFileSync(skill.path, 'utf8'), enabled), 'utf8')
  }

  deleteSkill(path: string, kind: SkillKind): string {
    const skill = this.requireManagedSkill(path)
    if (skill.kind !== kind) throw new Error('skill kind does not match managed file')
    const target = kind === 'bundle' ? dirname(skill.path) : skill.path
    rmSync(target, { force: true, recursive: true })
    return target
  }

  scanImportDirectory(directory: string): ScannedSkill[] {
    const dir = resolve(directory)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`directory not found: ${dir}`)
    return this.scanRoot(dir, 'user-dsh').map(skill => ({ description: skill.description, kind: skill.kind, name: skill.name, sourcePath: skill.kind === 'bundle' ? dirname(skill.path) : skill.path }))
  }

  importSkills(items: ImportSkillInput[]): ImportSkillResult[] {
    const destination = join(this.dshHome, 'skills')
    mkdirSync(destination, { recursive: true })
    return items.map(item => {
      const source = resolve(item.sourcePath)
      const target = join(destination, basename(source))
      if (!existsSync(source)) return { name: basename(source), ok: false, reason: 'source not found' }
      if (existsSync(target)) return { name: basename(source), ok: false, reason: 'already exists' }
      try {
        if (item.kind === 'bundle') cpSync(source, target, { recursive: true })
        else copyFileSync(source, target)
        return { name: basename(source), ok: true }
      } catch (error) {
        return { name: basename(source), ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  listMcpServers(): McpServerConfig[] {
    const path = this.mcpConfigPath()
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { servers?: unknown }
      return Array.isArray(parsed.servers) ? parsed.servers.filter(server => validateMcpServer(server) === null).map(server => normalizeMcpServer(server as McpServerConfig)) : []
    } catch {
      return []
    }
  }

  saveMcpServer(input: McpServerConfig): McpServerConfig {
    const error = validateMcpServer(input)
    if (error) throw new Error(error)
    const server = normalizeMcpServer(input)
    const servers = this.listMcpServers()
    const index = servers.findIndex(candidate => candidate.name === server.name)
    if (index >= 0) servers[index] = server
    else servers.push(server)
    this.writeMcpServers(servers)
    return server
  }

  setMcpEnabled(name: string, enabled: boolean): McpServerConfig {
    const servers = this.listMcpServers()
    const server = servers.find(candidate => candidate.name === name)
    if (!server) throw new Error(`server not found: ${name}`)
    server.enabled = enabled
    this.writeMcpServers(servers)
    return server
  }

  deleteMcpServer(name: string): void {
    const servers = this.listMcpServers()
    if (!servers.some(server => server.name === name)) throw new Error(`server not found: ${name}`)
    this.writeMcpServers(servers.filter(server => server.name !== name))
  }

  private findProjectRoot(): string {
    let current = this.workspace
    for (;;) {
      if (existsSync(join(current, '.git'))) return current
      const parent = dirname(current)
      if (parent === current) return this.workspace
      current = parent
    }
  }

  private requireManagedSkill(path: string): ManagedSkill {
    const absolute = resolve(path)
    const skill = this.listSkills().find(candidate => candidate.path === absolute)
    if (!skill) throw new Error('skill path is outside managed roots or is not a valid skill')
    return skill
  }

  private scanRoot(dir: string, source: SkillSource): ManagedSkill[] {
    if (!existsSync(dir)) return []
    const level: SkillLevel = source.startsWith('project-') ? 'project' : 'user'
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry: Dirent): ManagedSkill[] => {
        if (entry.name.startsWith('.')) return []
        if (!entry.isDirectory() && (!entry.isFile() || !entry.name.endsWith('.md'))) return []
        const path = entry.isDirectory() ? join(dir, entry.name, 'SKILL.md') : join(dir, entry.name)
        if (!existsSync(path)) return []
        try {
          const parsed = parseSkill(readFileSync(path, 'utf8'))
          return parsed ? [{ ...parsed, kind: entry.isDirectory() ? 'bundle' as const : 'file' as const, level, path: resolve(path), source }] : []
        } catch { return [] }
      })
    } catch { return [] }
  }

  private writeMcpServers(servers: McpServerConfig[]): void {
    mkdirSync(this.dshHome, { recursive: true })
    const target = this.mcpConfigPath()
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ servers }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, target)
  }
}
