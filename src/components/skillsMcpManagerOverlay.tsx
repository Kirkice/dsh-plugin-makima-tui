import { Box, Text, useInput, useStdout } from '@makima-tui/ink'
import { useEffect, useMemo, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import { rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint } from './overlayControls.js'
import { TextInput } from './textInput.js'

type Tab = 'mcp' | 'skills'
type View = 'confirm-delete' | 'detail' | 'edit-mcp' | 'list' | 'mcp-actions' | 'mcp-tools'
type SkillKind = 'bundle' | 'file'
type McpTransport = 'stdio' | 'streamable-http'
type McpRuntimeTransport = McpTransport | 'external'

interface ManagedSkill {
  description: string
  enabled: boolean
  kind: SkillKind
  level: 'project' | 'user'
  name: string
  path: string
  source: string
  whenToUse: string
}

interface ManagedSkillDetail extends ManagedSkill {
  content: string
}

interface McpServer {
  args?: string[]
  command?: string
  cwd?: string
  enabled?: boolean
  /** False for a server observed or mounted outside Makima's mcp.json. */
  managed?: boolean
  /** Makima blocks this external server's tools but does not stop its owner. */
  runtimeDisabled?: boolean
  agentIds?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  name: string
  transport: McpRuntimeTransport
  url?: string
  /** Live state is reported by the Harness backend that owns the connection. */
  error?: string
  status?: 'connected' | 'connecting' | 'disabled' | 'failed' | 'stopped'
  tools?: number
}

interface McpTool {
  agentIds?: string[]
  enabled: boolean
  name: string
}

const WIDTH_MIN = 56
const WIDTH_MAX = 100

const jsonMap = (raw: string, label: string): Record<string, string> => {
  if (!raw.trim()) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be an object')
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    if (entries.length !== Object.keys(value).length) throw new Error('all values must be strings')
    return Object.fromEntries(entries)
  } catch (cause) {
    throw new Error(`${label} must be a JSON object of string values: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

const prettyMap = (value: Record<string, string> | undefined) =>
  value && Object.keys(value).length ? JSON.stringify(value) : ''

export function SkillsMcpManagerOverlay({ gw, initialTab, onClose, t }: SkillsMcpManagerOverlayProps) {
  const { stdout } = useStdout()
  const width = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, (stdout?.columns ?? 80) - 6))
  const [tab, setTab] = useState<Tab>(initialTab)
  const [view, setView] = useState<View>('list')
  const [skills, setSkills] = useState<ManagedSkill[]>([])
  const [servers, setServers] = useState<McpServer[]>([])
  const [configPath, setConfigPath] = useState('~/.dsh/mcp.json')
  const [index, setIndex] = useState(0)
  const [selectedSkill, setSelectedSkill] = useState<ManagedSkillDetail | null>(null)
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null)
  const [mcpTools, setMcpTools] = useState<McpTool[]>([])
  const [mcpActionIndex, setMcpActionIndex] = useState(0)
  const [mcpToolIndex, setMcpToolIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [field, setField] = useState(0)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [commandOrUrl, setCommandOrUrl] = useState('')
  const [argsOrHeaders, setArgsOrHeaders] = useState('')
  const [cwdOrEnv, setCwdOrEnv] = useState('')
  const [env, setEnv] = useState('')

  const items = tab === 'skills' ? skills : servers
  const clampedIndex = Math.min(index, Math.max(0, items.length - 1))
  const fieldRows = useMemo(() => transport === 'stdio'
    ? [['Name', name], ['Transport', transport], ['Command', commandOrUrl], ['Arguments (space-separated)', argsOrHeaders], ['Working directory', cwdOrEnv], ['Environment (JSON)', env]]
    : [['Name', name], ['Transport', transport], ['URL', commandOrUrl], ['Headers (JSON)', argsOrHeaders]], [argsOrHeaders, commandOrUrl, cwdOrEnv, env, name, transport])

  const load = () => {
    setLoading(true)
    setError('')
    const request = tab === 'skills'
      ? gw.request<{ skills?: ManagedSkill[] }>('skills.manager.list', {}).then(result => {
          const next = result?.skills ?? []
          setSkills(next)
          setIndex(current => Math.min(current, Math.max(0, next.length - 1)))
        })
      : gw.request<{ config_path?: string; servers?: McpServer[] }>('mcp.manager.list', {}).then(result => {
          const next = result?.servers ?? []
          setServers(next)
          setConfigPath(result?.config_path ?? '~/.dsh/mcp.json')
          setIndex(current => Math.min(current, Math.max(0, next.length - 1)))
        })
    void request.catch((cause: unknown) => setError(rpcErrorMessage(cause))).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [gw, tab])

  const changeTab = (next: Tab) => {
    if (saving || next === tab) return
    setTab(next)
    setIndex(0)
    setView('list')
    setNotice('')
    setError('')
  }

  const inspectSkill = (skill: ManagedSkill) => {
    setLoading(true)
    setError('')
    void gw.request<{ skill?: ManagedSkillDetail }>('skills.manager.read', { path: skill.path })
      .then(result => {
        if (!result?.skill) throw new Error('skill not found')
        setSelectedSkill(result.skill)
        setView('detail')
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setLoading(false))
  }

  const toggleSkill = (skill: ManagedSkill) => {
    setSaving(true)
    setError('')
    void gw.request('skills.manager.set_enabled', { enabled: !skill.enabled, path: skill.path })
      .then(() => {
        setNotice(`${skill.name} ${skill.enabled ? 'disabled' : 'enabled'}`)
        setSelectedSkill(current => current?.path === skill.path ? { ...current, enabled: !skill.enabled } : current)
        load()
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setSaving(false))
  }

  const toggleServer = (server: McpServer) => {
    setSaving(true)
    setError('')
    void gw.request('mcp.manager.set_enabled', { enabled: server.enabled === false, name: server.name })
      .then(() => {
        const outcome = server.enabled === false
          ? server.managed === false ? 'enabled by Makima runtime policy' : 'enabled and applying'
          : server.managed === false ? 'runtime-disabled; its external service is still running' : 'disabled and unloaded'
        setNotice(`${server.name} ${outcome}`)
        load()
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setSaving(false))
  }

  const beginAdd = () => {
    setSelectedServer(null)
    setName('')
    setTransport('stdio')
    setCommandOrUrl('')
    setArgsOrHeaders('')
    setCwdOrEnv('')
    setEnv('')
    setField(0)
    setError('')
    setNotice('')
    setView('edit-mcp')
  }

  const inspectMcp = (server: McpServer) => {
    setSelectedServer(server)
    setMcpActionIndex(0)
    setError('')
    setNotice('')
    setView('mcp-actions')
  }

  const loadMcpTools = (server: McpServer) => {
    setLoading(true)
    setError('')
    void gw.request<{ tools?: McpTool[] }>('mcp.manager.tools', { name: server.name })
      .then(result => {
        const next = result.tools ?? []
        setMcpTools(next)
        setMcpToolIndex(current => Math.min(current, Math.max(0, next.length - 1)))
        setView('mcp-tools')
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setLoading(false))
  }

  const toggleTool = (tool: McpTool) => {
    setSaving(true)
    setError('')
    void gw.request('mcp.manager.set_tool_enabled', { enabled: !tool.enabled, name: tool.name })
      .then(() => {
        setMcpTools(current => current.map(item => item.name === tool.name ? { ...item, enabled: !tool.enabled } : item))
        setNotice(`${tool.name} ${tool.enabled ? 'disabled globally' : 'enabled globally'}`)
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setSaving(false))
  }

  const beginEdit = (server: McpServer) => {
    if (server.managed === false) {
      setError(`${server.name} is externally managed and read-only here`)
      return
    }
    setSelectedServer(server)
    setName(server.name)
    setTransport(server.transport === 'external' ? 'stdio' : server.transport)
    setCommandOrUrl(server.transport === 'stdio' ? server.command ?? '' : server.url ?? '')
    setArgsOrHeaders(server.transport === 'stdio' ? (server.args ?? []).join(' ') : prettyMap(server.headers))
    setCwdOrEnv(server.transport === 'stdio' ? server.cwd ?? '' : '')
    setEnv(server.transport === 'stdio' ? prettyMap(server.env) : '')
    setField(0)
    setError('')
    setNotice('')
    setView('edit-mcp')
  }

  const saveServer = () => {
    if (saving) return
    try {
      const server: McpServer = transport === 'stdio'
        ? { args: argsOrHeaders.split(/\s+/).filter(Boolean), command: commandOrUrl, cwd: cwdOrEnv, enabled: selectedServer?.enabled !== false, env: jsonMap(env, 'Environment'), name, transport }
        : { enabled: selectedServer?.enabled !== false, headers: jsonMap(argsOrHeaders, 'Headers'), name, transport, url: commandOrUrl }
      setSaving(true)
      setError('')
      void gw.request<{ server?: McpServer }>('mcp.manager.save', { server })
        .then(() => {
          setNotice(`${name} saved · backend is applying the connection`)
          setView('list')
          load()
        })
        .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
        .finally(() => setSaving(false))
    } catch (cause) {
      setError(rpcErrorMessage(cause))
    }
  }

  const removeSelected = () => {
    if (saving) return
    setSaving(true)
    setError('')
    const request = tab === 'skills'
      ? gw.request<{ removed?: string }>('skills.manager.delete', { kind: selectedSkill?.kind, path: selectedSkill?.path })
      : gw.request<{ deleted?: string }>('mcp.manager.delete', { name: selectedServer?.name })
    void request.then(() => {
      setNotice(tab === 'skills' ? `${selectedSkill?.name ?? 'skill'} deleted` : `${selectedServer?.name ?? 'server'} deleted and unloaded`)
      setSelectedSkill(null)
      setSelectedServer(null)
      setView('list')
      load()
    }).catch((cause: unknown) => setError(rpcErrorMessage(cause))).finally(() => setSaving(false))
  }

  const back = () => {
    if (saving) return
    if (view === 'list') return onClose()
    if (view === 'confirm-delete') return setView(tab === 'skills' ? 'detail' : 'edit-mcp')
    if (view === 'mcp-tools') return setView('mcp-actions')
    if (view === 'mcp-actions') return setView('list')
    setView('list')
  }

  useInput((ch, key) => {
    if (key.escape || ch.toLowerCase() === 'q') return back()
    if (saving || loading) return
    if (view === 'list') {
      if (key.leftArrow) return changeTab('skills')
      if (key.rightArrow) return changeTab('mcp')
      if (ch === '1') return changeTab('skills')
      if (ch === '2') return changeTab('mcp')
      if (ch.toLowerCase() === 'r') return load()
      if (tab === 'mcp' && ch.toLowerCase() === 'a') return beginAdd()
      if (key.upArrow && clampedIndex > 0) return setIndex(clampedIndex - 1)
      if (key.downArrow && clampedIndex < items.length - 1) return setIndex(clampedIndex + 1)
      if (key.return) {
        const item = items[clampedIndex]
        if (!item) return
        return tab === 'skills' ? inspectSkill(item as ManagedSkill) : inspectMcp(item as McpServer)
      }
      if (ch === ' ') {
        const item = items[clampedIndex]
        if (!item) return
        return tab === 'skills' ? toggleSkill(item as ManagedSkill) : toggleServer(item as McpServer)
      }
      return
    }
    if (view === 'mcp-actions') {
      const server = selectedServer
      if (!server) return back()
      if (key.upArrow && mcpActionIndex > 0) return setMcpActionIndex(mcpActionIndex - 1)
      if (key.downArrow && mcpActionIndex < 2) return setMcpActionIndex(mcpActionIndex + 1)
      if (!key.return) return
      if (mcpActionIndex === 0) return toggleServer(server)
      if (mcpActionIndex === 1) return loadMcpTools(server)
      if (server.managed === false) return setError('External MCP servers cannot be edited; use the enable switch or tool permissions.')
      return beginEdit(server)
    }
    if (view === 'mcp-tools') {
      const tool = mcpTools[mcpToolIndex]
      if (key.upArrow && mcpToolIndex > 0) return setMcpToolIndex(mcpToolIndex - 1)
      if (key.downArrow && mcpToolIndex < mcpTools.length - 1) return setMcpToolIndex(mcpToolIndex + 1)
      if (key.return && tool) return toggleTool(tool)
      return
    }
    if (view === 'detail') {
      if (ch === ' ') return selectedSkill ? toggleSkill(selectedSkill) : undefined
      if (ch.toLowerCase() === 'x' && selectedSkill) {
        setDeleteConfirmed(false)
        return setView('confirm-delete')
      }
      return
    }
    if (view === 'confirm-delete') {
      if (key.leftArrow || key.upArrow) return setDeleteConfirmed(false)
      if (key.rightArrow || key.downArrow) return setDeleteConfirmed(true)
      if (key.return) return deleteConfirmed ? removeSelected() : back()
      return
    }
    if (key.tab) return setField(current => Math.min(fieldRows.length - 1, Math.max(0, current + (key.shift ? -1 : 1))))
    if (key.upArrow) return setField(current => Math.max(0, current - 1))
    if (key.downArrow) return setField(current => Math.min(fieldRows.length - 1, current + 1))
    if (field === 1 && (key.leftArrow || key.rightArrow)) return setTransport(current => current === 'stdio' ? 'streamable-http' : 'stdio')
    if (key.return && field === fieldRows.length - 1) return saveServer()
    if (ch.toLowerCase() === 's') return saveServer()
    if (ch.toLowerCase() === 'x' && selectedServer) {
      setDeleteConfirmed(false)
      return setView('confirm-delete')
    }
  })

  if (loading && view === 'list') return <Text color={t.color.muted}>loading {tab === 'skills' ? 'managed skills' : 'MCP configuration'}…</Text>

  if (view === 'confirm-delete') {
    const label = tab === 'skills' ? selectedSkill?.name : selectedServer?.name
    return <Box flexDirection="column" width={width}>
      <Text bold color={t.color.warn}>Delete {tab === 'skills' ? 'skill' : 'MCP server'}?</Text>
      <Text color={t.color.text}>{label}</Text>
      <Text color={t.color.muted}>{tab === 'skills' ? 'This removes the managed skill file or bundle.' : 'The Harness backend unloads the live connection and unregisters its tools.'}</Text>
      <Text bold color={deleteConfirmed ? t.color.error : t.color.accent} inverse={deleteConfirmed}>▸ {deleteConfirmed ? 'Delete permanently' : 'Cancel'}</Text>
      {error ? <Text color={t.color.error}>error: {error}</Text> : null}
      <OverlayHint t={t}>←/→ select · Enter confirm · Esc/q back</OverlayHint>
    </Box>
  }

  if (view === 'mcp-actions' && selectedServer) {
    const actions = [
      `${selectedServer.enabled === false ? 'Enable' : 'Disable'} MCP server`,
      `Tools (${selectedServer.tools ?? 0})`,
      selectedServer.managed === false ? 'Edit connection (external: unavailable)' : 'Edit connection'
    ]
    return <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>MCP · {selectedServer.name}</Text>
      <Text color={t.color.muted}>{selectedServer.managed === false ? 'External service: enable/disable applies Makima runtime policy only.' : 'Makima-managed connection: enable/disable starts or stops the client.'}</Text>
      <Text color={t.color.muted}>{selectedServer.agentIds?.length ? `visible in: ${selectedServer.agentIds.join(', ')}` : 'visible in: global'}</Text>
      <Box marginTop={1} flexDirection="column">{actions.map((action, row) => <Text key={action} color={row === mcpActionIndex ? t.color.accent : t.color.text}>{row === mcpActionIndex ? '▸ ' : '  '}{action}</Text>)}</Box>
      {notice ? <Text color={t.color.accent}>{notice}</Text> : null}
      {error ? <Text color={t.color.error}>error: {error}</Text> : null}
      <OverlayHint t={t}>↑↓ select · Enter open/toggle · Esc/q back</OverlayHint>
    </Box>
  }

  if (view === 'mcp-tools' && selectedServer) {
    return <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>MCP Tools · {selectedServer.name}</Text>
      <Text color={t.color.muted}>Enter toggles the globally persisted runtime permission.</Text>
      <Box marginTop={1} flexDirection="column">{mcpTools.length ? mcpTools.map((tool, row) => <Text key={tool.name} color={row === mcpToolIndex ? t.color.accent : t.color.text} wrap="truncate-end">{row === mcpToolIndex ? '▸ ' : '  '}{tool.name} <Text color={tool.enabled ? t.color.muted : t.color.warn}>[{tool.enabled ? 'enabled' : 'disabled'} · {tool.agentIds?.join(', ') || 'global'}]</Text></Text>) : <Text color={t.color.muted}>no tools currently visible</Text>}</Box>
      {notice ? <Text color={t.color.accent}>{notice}</Text> : null}
      {error ? <Text color={t.color.error}>error: {error}</Text> : null}
      <OverlayHint t={t}>↑↓ select · Enter enable/disable · Esc/q back</OverlayHint>
    </Box>
  }

  if (view === 'detail' && selectedSkill) {
    return <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>{selectedSkill.name}</Text>
      <Text color={t.color.text}>{selectedSkill.description}</Text>
      <Text color={t.color.muted}>{selectedSkill.enabled ? 'enabled' : 'disabled'} · {selectedSkill.level} · {selectedSkill.source}</Text>
      {selectedSkill.whenToUse ? <Text color={t.color.muted}>when to use: {selectedSkill.whenToUse}</Text> : null}
      <Box marginTop={1}><Text color={t.color.text} wrap="truncate-end">{selectedSkill.content || '(no skill body)'}</Text></Box>
      {notice ? <Text color={t.color.accent}>{notice}</Text> : null}
      {error ? <Text color={t.color.error}>error: {error}</Text> : null}
      <OverlayHint t={t}>Space enable/disable · x delete · Esc/q back</OverlayHint>
    </Box>
  }

  if (view === 'edit-mcp') {
    const inputWidth = Math.max(28, width - 28)
    const values = [name, transport, commandOrUrl, argsOrHeaders, cwdOrEnv, env]
    const setters = [setName, undefined, setCommandOrUrl, setArgsOrHeaders, setCwdOrEnv, setEnv]
    return <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>{selectedServer ? 'Edit MCP server' : 'Add MCP server'}</Text>
      <Text color={t.color.muted}>Changes are saved to {configPath}; the Harness backend immediately reconciles the live connection.</Text>
      {fieldRows.map(([label, value], row) => <Box key={label}>
        <Text bold={field === row} color={field === row ? t.color.accent : t.color.muted}>{field === row ? '▸ ' : '  '}{label}: </Text>
        {field === row && row !== 1 ? <TextInput columns={inputWidth} onChange={setters[row]!} value={values[row]!} /> : <Text color={t.color.text}>{value || '(empty)'}</Text>}
      </Box>)}
      {error ? <Text color={t.color.error}>error: {error}</Text> : null}
      {selectedServer ? <Text color={t.color.error}>x delete this server</Text> : null}
      <OverlayHint t={t}>Tab/↑/↓ field · ←/→ transport · s save · Esc/q back</OverlayHint>
    </Box>
  }

  return <Box flexDirection="column" width={width}>
    <Text bold color={t.color.accent}>Skills & MCP Manager</Text>
    <Text color={t.color.muted}>{tab === 'skills' ? '▸ Skills' : '  Skills'}  {tab === 'mcp' ? '▸ MCP servers' : '  MCP servers'} · ←/→ switch</Text>
    {tab === 'skills'
      ? skills.length ? skills.map((skill, row) => <Text color={row === clampedIndex ? t.color.accent : t.color.text} key={skill.path} wrap="truncate-end">{row === clampedIndex ? '▸ ' : '  '}{skill.name} <Text color={skill.enabled ? t.color.muted : t.color.warn}>[{skill.enabled ? 'enabled' : 'disabled'} · {skill.level}]</Text></Text>) : <Text color={t.color.muted}>no managed Skills found</Text>
      : servers.length ? servers.map((server, row) => {
          const runtime = server.status ?? (server.enabled === false ? 'disabled' : 'connecting')
          const color = runtime === 'connected' ? t.color.muted : runtime === 'failed' ? t.color.error : t.color.warn
          const tools = typeof server.tools === 'number' ? ` · ${server.tools} tool${server.tools === 1 ? '' : 's'}` : ''
          const ownership = server.managed === false ? server.runtimeDisabled ? ' · external runtime-disabled' : ' · externally managed' : ''
          const scopes = server.agentIds?.length ? ` · ${server.agentIds.join(', ')}` : ''
          return <Text color={row === clampedIndex ? t.color.accent : t.color.text} key={server.name} wrap="truncate-end">{row === clampedIndex ? '▸ ' : '  '}{server.name} <Text color={color}>[{runtime} · {server.transport}{tools}{scopes}{ownership}{server.error ? ` · ${server.error}` : ''}]</Text></Text>
        }) : <Text color={t.color.muted}>no MCP tools visible in global or live Agent scopes</Text>}
    {notice ? <Text color={t.color.accent}>{notice}</Text> : null}
    {error ? <Text color={t.color.error}>error: {error}</Text> : null}
    <OverlayHint t={t}>{tab === 'skills' ? '↑↓ select · Enter inspect · Space enable/disable · r refresh · Esc/q close' : '↑↓ select · Enter open menu · Space enable/disable · a add · r refresh status · Esc/q close'}</OverlayHint>
  </Box>
}

interface SkillsMcpManagerOverlayProps {
  gw: GatewayClient
  initialTab: Tab
  onClose: () => void
  t: Theme
}
