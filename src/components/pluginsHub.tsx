import { Box, Text, useInput, useStdout } from '@makima-tui/ink'
import { useEffect, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import { rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint, useOverlayKeys, windowItems } from './overlayControls.js'

const VISIBLE = 12
const MIN_WIDTH = 44
const MAX_WIDTH = 96

type HubView = 'confirm-remove' | 'details' | 'list'
type Scope = 'all' | 'user'

interface PluginRow {
  builtIn: boolean
  bundle: boolean
  dependency: boolean
  packageName: string
  specifier: string
}

interface PluginsListResponse {
  entries?: unknown
  profile?: unknown
}

interface PluginRemoveResponse {
  packageName?: unknown
  profile?: unknown
  restartRequired?: unknown
}

const parseRows = (value: unknown): PluginRow[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []

    const row = entry as Record<string, unknown>
    if (typeof row.packageName !== 'string' || typeof row.specifier !== 'string') return []

    return [{
      builtIn: row.builtIn === true,
      bundle: row.bundle === true,
      dependency: row.dependency === true,
      packageName: row.packageName,
      specifier: row.specifier
    }]
  })
}

const roleLabel = (row: PluginRow): string =>
  [row.builtIn ? 'built-in' : '', row.bundle ? 'bundle' : '', row.dependency ? 'dependency' : '']
    .filter(Boolean)
    .join(', ')

export function PluginsHub({ gw, onClose, t }: PluginsHubProps) {
  const [rows, setRows] = useState<PluginRow[]>([])
  const [profile, setProfile] = useState('active profile')
  const [idx, setIdx] = useState(0)
  const [scope, setScope] = useState<Scope>('user')
  const [view, setView] = useState<HubView>('list')
  const [selected, setSelected] = useState<PluginRow | null>(null)
  const [confirmIdx, setConfirmIdx] = useState(0)
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState(false)

  const { stdout } = useStdout()
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (stdout?.columns ?? 80) - 6))

  const load = () => {
    setLoading(true)
    gw.request<PluginsListResponse>('plugins.list', {})
      .then(r => {
        setRows(parseRows(r?.entries))
        setProfile(typeof r?.profile === 'string' && r.profile.trim() ? r.profile.trim() : 'active profile')
        setIdx(0)
        setErr('')
      })
      .catch((e: unknown) => {
        setRows([])
        setErr(rpcErrorMessage(e))
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [gw])

  // Default to dependency plugins; fall back to all when the profile only has
  // bundled entries so the overlay is never empty.
  const visibleRows = scope === 'user' ? rows.filter(r => r.dependency) : rows
  const effectiveRows = scope === 'user' && !visibleRows.length && rows.length ? rows : visibleRows
  const effectiveScope: Scope = effectiveRows === visibleRows ? scope : 'all'
  const clampedIdx = Math.min(idx, Math.max(0, effectiveRows.length - 1))

  const back = () => {
    if (removing) return
    if (view === 'confirm-remove') return setView('details')
    if (view === 'details') return setView('list')
    onClose()
  }

  useOverlayKeys({ disabled: removing, onBack: back, onClose: view === 'list' ? onClose : back })

  const openDetails = () => {
    const row = effectiveRows[clampedIdx]
    if (!row) return
    setSelected(row)
    setErr('')
    setSuccess('')
    setView('details')
  }

  const removeSelected = () => {
    if (!selected || selected.builtIn || removing) return

    setRemoving(true)
    setErr('')
    gw.request<PluginRemoveResponse>('plugins.remove', { package_name: selected.packageName })
      .then(r => {
        const removedName = typeof r?.packageName === 'string' && r.packageName.trim() ? r.packageName : selected.packageName
        const removedProfile = typeof r?.profile === 'string' && r.profile.trim() ? r.profile : profile
        setSuccess(`${removedName} was removed from ${removedProfile}. Restart DSH to apply the change.`)
        setSelected(null)
        setView('list')
        load()
      })
      .catch((e: unknown) => {
        setErr(rpcErrorMessage(e))
        setView('details')
      })
      .finally(() => setRemoving(false))
  }

  useInput((ch, key) => {
    if (removing || loading) return

    if (view === 'confirm-remove') {
      if (key.upArrow || key.leftArrow) return setConfirmIdx(0)
      if (key.downArrow || key.rightArrow) return setConfirmIdx(1)
      if (ch.toLowerCase() === 'c') return setView('details')
      if (key.return) return confirmIdx === 1 ? removeSelected() : setView('details')
      return
    }

    if (view === 'details') {
      if (!selected) return setView('list')
      if (!selected.builtIn && (key.return || ch.toLowerCase() === 'u')) {
        setConfirmIdx(0)
        setErr('')
        setView('confirm-remove')
      }
      return
    }

    if (ch === 'r') {
      setSuccess('')
      load()
      return
    }

    const count = effectiveRows.length
    if (key.upArrow && clampedIdx > 0) return setIdx(clampedIdx - 1)
    if (key.downArrow && clampedIdx < count - 1) return setIdx(clampedIdx + 1)
    if (key.tab) {
      setScope(s => (s === 'user' ? 'all' : 'user'))
      setIdx(0)
      return
    }
    if (key.return || key.rightArrow || ch.toLowerCase() === 'l') openDetails()
  })

  if (loading && view === 'list') {
    return <Text color={t.color.muted}>loading plugins…</Text>
  }

  if (err && !rows.length && view === 'list') {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={t.color.label}>error: {err}</Text>
        <OverlayHint t={t}>r retry · Esc/q close</OverlayHint>
      </Box>
    )
  }

  if (view === 'confirm-remove' && selected) {
    const choices = ['Cancel', `Uninstall ${selected.packageName}`]
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.warn}>Confirm uninstall</Text>
        <Text color={t.color.text} wrap="wrap">Remove {selected.packageName} from profile {profile}?</Text>
        <Text color={t.color.muted} wrap="wrap">This edits the persisted profile. A DSH restart is required before the plugin is unloaded.</Text>
        {choices.map((choice, choiceIdx) => (
          <Text bold={confirmIdx === choiceIdx} color={choiceIdx === 1 ? t.color.error : t.color.accent} inverse={confirmIdx === choiceIdx} key={choice}>
            {confirmIdx === choiceIdx ? '▸ ' : '  '}{choice}
          </Text>
        ))}
        <OverlayHint t={t}>↑/↓ select · Enter confirm · Esc/c back</OverlayHint>
      </Box>
    )
  }

  if (view === 'details' && selected) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent}>Plugin details</Text>
        <Text color={t.color.text} wrap="wrap">{selected.packageName}</Text>
        <Text color={t.color.muted} wrap="wrap">specifier: {selected.specifier || '(none)'}</Text>
        <Text color={t.color.muted}>roles: {roleLabel(selected) || 'none'}</Text>
        {selected.builtIn ? (
          <Text color={t.color.warn} wrap="wrap">Built-in bundles are protected by DSH and cannot be uninstalled.</Text>
        ) : (
          <>
            <Text color={t.color.error} inverse>▸ Uninstall plugin</Text>
            <Text color={t.color.muted}>This changes {profile}; restart required.</Text>
          </>
        )}
        {err ? <Text color={t.color.error} wrap="wrap">error: {err}</Text> : null}
        <OverlayHint t={t}>{selected.builtIn ? 'Esc/q back' : 'Enter/u uninstall · Esc/q back'}</OverlayHint>
      </Box>
    )
  }

  if (!rows.length) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent}>Plugins Hub</Text>
        <Text color={t.color.muted}>no plugins installed in {profile}</Text>
        <OverlayHint t={t}>r refresh · Esc/q close</OverlayHint>
      </Box>
    )
  }

  const labels = effectiveRows.map(row =>
    `✓ ${row.packageName}${row.specifier ? ` — ${row.specifier}` : ''}${roleLabel(row) ? ` [${roleLabel(row)}]` : ''}`
  )
  const { items, offset } = windowItems(labels, clampedIdx, VISIBLE)
  const scopeLabel = effectiveScope === 'user' ? `${effectiveRows.length} profile dependency plugin(s) · Tab all` : `all ${rows.length} profile plugins`

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>Plugins Hub</Text>
      <Text color={t.color.muted}>{scopeLabel}</Text>
      {offset > 0 && <Text color={t.color.muted}> ↑ {offset} more</Text>}
      {items.map((row, itemIdx) => {
        const lineIdx = offset + itemIdx
        const active = clampedIdx === lineIdx
        return (
          <Text bold={active} color={active ? t.color.accent : t.color.muted} inverse={active} key={effectiveRows[lineIdx]?.packageName ?? row} wrap="truncate-end">
            {active ? '▸ ' : '  '}{itemIdx + 1}. {row}
          </Text>
        )
      })}
      {offset + VISIBLE < labels.length && <Text color={t.color.muted}> ↓ {labels.length - offset - VISIBLE} more</Text>}
      {success ? <Text color={t.color.accent} wrap="wrap">{success}</Text> : null}
      {err ? <Text color={t.color.error} wrap="wrap">error: {err}</Text> : null}
      <OverlayHint t={t}>↑/↓ select · Enter details · Tab dependencies/all · r refresh · Esc/q close</OverlayHint>
    </Box>
  )
}

interface PluginsHubProps {
  gw: GatewayClient
  onClose: () => void
  t: Theme
}
