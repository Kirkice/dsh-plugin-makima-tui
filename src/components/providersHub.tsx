import { Box, Link, Text, useInput, useStdout } from '@makima-tui/ink'
import { useEffect, useMemo, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import type { ProviderManagerItem, ProvidersListResponse } from '../gatewayTypes.js'
import { rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint } from './overlayControls.js'
import { TextInput } from './textInput.js'

type View = 'confirm-remove' | 'edit' | 'list' | 'oauth'

type OAuthStatus = {
  authenticated?: boolean
  authorization_url?: string
  device_code?: { user_code?: string; verification_uri?: string }
  device_code_available?: boolean
  login_error?: string
  login_pending?: boolean
}

const WIDTH_MIN = 52
const WIDTH_MAX = 96

const clean = (value: string) => value.trim()
const modelIds = (value: string) => [...new Set(value.split(',').map(clean).filter(Boolean))]

export function ProvidersHub({ gw, onClose, t }: ProvidersHubProps) {
  const { stdout } = useStdout()
  const width = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, (stdout?.columns ?? 80) - 6))
  const [items, setItems] = useState<ProviderManagerItem[]>([])
  const [protocols, setProtocols] = useState<string[]>(['openai-completions'])
  const [index, setIndex] = useState(0)
  const [view, setView] = useState<View>('list')
  const [selected, setSelected] = useState<ProviderManagerItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('')
  const [imageModels, setImageModels] = useState('')
  const [protocolIndex, setProtocolIndex] = useState(0)
  const [field, setField] = useState(0)
  const [oauth, setOauth] = useState<OAuthStatus>({})
  const [confirmRemove, setConfirmRemove] = useState(false)

  const protocol = protocols[protocolIndex] ?? 'openai-completions'
  const clampedIndex = Math.min(index, Math.max(0, items.length - 1))

  const load = () => {
    setLoading(true)
    gw.request<ProvidersListResponse>('providers.list', {})
      .then(result => {
        setItems(Array.isArray(result.items) ? result.items : [])
        setProtocols(result.protocols?.length ? result.protocols : ['openai-completions'])
        setIndex(current => Math.min(current, Math.max(0, (result.items?.length ?? 1) - 1)))
        setError('')
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setLoading(false))
  }

  const pollOAuth = () => {
    gw.request<OAuthStatus>('llm.openAiCodex.status', {})
      .then(status => setOauth(status ?? {}))
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
  }

  useEffect(() => { load() }, [gw])
  useEffect(() => {
    if (view !== 'oauth') return
    pollOAuth()
    const timer = setInterval(pollOAuth, 1000)
    return () => clearInterval(timer)
  }, [view])

  const formRows = useMemo(() => [
    ['Provider name', name],
    ['Base URL', baseUrl],
    ['API key', apiKey ? '••••••••' : selected?.credential_configured ? '(stored; leave blank to keep)' : ''],
    ['Models (comma-separated)', models],
    ['Image-capable models', imageModels],
    ['Protocol', protocol]
  ], [apiKey, baseUrl, imageModels, models, name, protocol, selected?.credential_configured])

  const beginAdd = () => {
    setSelected(null)
    setName('')
    setBaseUrl('')
    setApiKey('')
    setModels('')
    setImageModels('')
    setProtocolIndex(0)
    setField(0)
    setError('')
    setNotice('')
    setView('edit')
  }

  const beginEdit = (item: ProviderManagerItem) => {
    setSelected(item)
    setName(item.display_name)
    setBaseUrl(item.base_url ?? '')
    setApiKey('')
    setModels((item.models ?? []).join(', '))
    setImageModels((item.image_models ?? []).join(', '))
    setProtocolIndex(Math.max(0, protocols.indexOf(item.api ?? 'openai-completions')))
    setField(0)
    setError('')
    setNotice('')
    setView('edit')
  }

  const save = () => {
    if (saving) return
    setSaving(true)
    setError('')
    gw.request<{ id: string }>('providers.saveOpenAiCompatible', {
      ...(selected ? { id: selected.id } : {}),
      api: protocol,
      api_key: apiKey,
      base_url: baseUrl,
      display_name: name,
      image_models: modelIds(imageModels),
      models: modelIds(models)
    })
      .then(result => {
        setNotice(`${result.id} saved`)
        setView('list')
        load()
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setSaving(false))
  }

  const remove = () => {
    if (!selected || saving) return
    setSaving(true)
    setError('')
    gw.request<{ id: string }>('providers.remove', { id: selected.id })
      .then(result => {
        setNotice(`${result.id} removed`)
        setSelected(null)
        setView('list')
        load()
      })
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
      .finally(() => setSaving(false))
  }

  const login = (method: 'browser' | 'device_code') => {
    setError('')
    gw.request<OAuthStatus>('llm.openAiCodex.login', { method })
      .then(status => setOauth(status ?? {}))
      .catch((cause: unknown) => setError(rpcErrorMessage(cause)))
  }

  const back = () => {
    if (saving) return
    if (view === 'list') return onClose()
    if (view === 'confirm-remove') return setView('edit')
    setView('list')
  }

  useInput((ch, key) => {
    if (key.escape || ch.toLowerCase() === 'q') return back()
    if (saving || loading) return

    if (view === 'list') {
      if (ch.toLowerCase() === 'r') return load()
      if (ch.toLowerCase() === 'a') return beginAdd()
      if (ch.toLowerCase() === 'o') return setView('oauth')
      if (key.upArrow && clampedIndex > 0) return setIndex(clampedIndex - 1)
      if (key.downArrow && clampedIndex < items.length - 1) return setIndex(clampedIndex + 1)
      if (key.return) {
        const item = items[clampedIndex]
        if (item?.type === 'oauth') return setView('oauth')
        if (item?.type === 'api_key') return beginEdit(item)
      }
      return
    }

    if (view === 'confirm-remove') {
      if (key.leftArrow || key.upArrow) return setConfirmRemove(false)
      if (key.rightArrow || key.downArrow) return setConfirmRemove(true)
      if (key.return) return confirmRemove ? remove() : setView('edit')
      return
    }

    if (view === 'oauth') {
      if (ch.toLowerCase() === 'b') return login('browser')
      if (ch.toLowerCase() === 'd' && oauth.device_code_available) return login('device_code')
      if (ch.toLowerCase() === 'c' && oauth.login_pending) return void gw.request('llm.openAiCodex.cancelLogin', {}).then(pollOAuth)
      if (ch.toLowerCase() === 'l' && oauth.authenticated) return void gw.request('llm.openAiCodex.logout', {}).then(pollOAuth)
      return
    }

    // TextInput owns arrow keys for caret movement. Tab deliberately moves
    // between form fields so navigation remains available while editing.
    if (key.tab) return setField(current => Math.min(formRows.length - 1, Math.max(0, current + (key.shift ? -1 : 1))))
    if (key.upArrow) return setField(current => Math.max(0, current - 1))
    if (key.downArrow) return setField(current => Math.min(formRows.length - 1, current + 1))
    if (field === 5 && (key.leftArrow || key.rightArrow)) {
      return setProtocolIndex(current => (current + (key.rightArrow ? 1 : -1) + protocols.length) % protocols.length)
    }
    if (key.return && field === 5) return save()
    if (ch.toLowerCase() === 's') return save()
    if (ch.toLowerCase() === 'x' && selected?.removable) return setView('confirm-remove')
  })

  if (loading && view === 'list') return <Text color={t.color.muted}>loading providers…</Text>

  if (view === 'oauth') {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent}>ChatGPT / Codex</Text>
        <Text color={oauth.authenticated ? t.color.accent : t.color.warn}>{oauth.authenticated ? 'Signed in and ready' : 'Not signed in'}</Text>
        {oauth.authorization_url ? <Link url={oauth.authorization_url}>Open ChatGPT authorization page</Link> : null}
        {oauth.device_code?.verification_uri ? <Text color={t.color.text}>Visit {oauth.device_code.verification_uri} · code: {oauth.device_code.user_code}</Text> : null}
        {oauth.login_pending ? <Text color={t.color.muted}>Waiting for authorization…</Text> : null}
        {oauth.login_error || error ? <Text color={t.color.error}>error: {oauth.login_error || error}</Text> : null}
        <OverlayHint t={t}>{oauth.authenticated ? 'l log out · Esc/q back' : `b browser login${oauth.device_code_available ? ' · d device code' : ''}${oauth.login_pending ? ' · c cancel' : ''} · Esc/q back`}</OverlayHint>
      </Box>
    )
  }

  if (view === 'confirm-remove' && selected) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.warn}>Remove provider?</Text>
        <Text color={t.color.text}>{selected.display_name} ({selected.id})</Text>
        <Text color={t.color.muted} wrap="wrap">Its Makima-managed profile and stored API key will be deleted. This cannot remove built-in or composition providers.</Text>
        <Text bold color={confirmRemove ? t.color.error : t.color.accent} inverse={confirmRemove}>▸ {confirmRemove ? 'Remove provider' : 'Cancel'}</Text>
        <OverlayHint t={t}>←/→ select · Enter confirm · Esc/q back</OverlayHint>
      </Box>
    )
  }

  if (view === 'edit') {
    const inputWidth = Math.max(24, width - 22)
    const labels = ['name', 'base URL', 'API key', 'models', 'image-capable models']
    const setters = [setName, setBaseUrl, setApiKey, setModels, setImageModels]
    const values = [name, baseUrl, apiKey, models, imageModels]
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.accent}>{selected ? 'Edit OpenAI-compatible provider' : 'Add OpenAI-compatible provider'}</Text>
        <Text color={t.color.muted}>List image-capable models explicitly; this enables screenshot attachments only for those models.</Text>
        <Text color={t.color.muted}>Tab/↑/↓ select fields; Enter on protocol or s saves.</Text>
        {formRows.map(([label, value], row) => (
          <Box key={label}>
            <Text bold={field === row} color={field === row ? t.color.accent : t.color.muted}>{field === row ? '▸ ' : '  '}{label}: </Text>
            {row < 5 && field === row ? (
              <TextInput columns={inputWidth} mask={row === 2 ? '*' : undefined} onChange={setters[row]!} value={values[row]!} />
            ) : <Text color={t.color.text}>{value || (row === 2 ? '(required for new provider)' : '(empty)')}</Text>}
          </Box>
        ))}
        {error ? <Text color={t.color.error}>error: {error}</Text> : null}
        {selected?.removable ? <Text color={t.color.error}>x remove this provider</Text> : null}
        <OverlayHint t={t}>Tab/↑/↓ field · ←/→ protocol · s save · Esc/q back</OverlayHint>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>Providers</Text>
      <Text color={t.color.muted}>/provider switches quickly · /model chooses a model</Text>
      {items.length ? items.map((item, row) => (
        <Text bold={row === clampedIndex} color={item.current ? t.color.accent : row === clampedIndex ? t.color.accent : t.color.text} key={item.id} wrap="truncate-end">
          {row === clampedIndex ? '▸ ' : '  '}{item.display_name} <Text color={t.color.muted}>[{item.type}{item.current ? ' · active' : ''}{item.credential_configured ? ' · key set' : ''}]</Text>
        </Text>
      )) : <Text color={t.color.muted}>no providers are currently available</Text>}
      {notice ? <Text color={t.color.accent}>{notice}</Text> : null}
      {error ? <Text color={t.color.error}>error: {error}</Text> : null}
      <OverlayHint t={t}>a add API-key provider · o ChatGPT/Codex · Enter edit · r refresh · Esc/q close</OverlayHint>
    </Box>
  )
}

interface ProvidersHubProps {
  gw: GatewayClient
  onClose: () => void
  t: Theme
}
