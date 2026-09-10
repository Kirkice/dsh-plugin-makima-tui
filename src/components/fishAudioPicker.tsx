import { Box, Text, useInput } from '@makima-tui/ink'
import { useEffect, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import type { Theme } from '../theme.js'

import { OverlayHint } from './overlayControls.js'
import { TextInput } from './textInput.js'

interface VoiceProfile {
  id: string
  name: string
  referenceId: string
}

type Screen = 'list' | 'profile' | 'settings' | 'add'

export function FishAudioPicker({ gw, onClose, t, text }: FishAudioPickerProps) {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([])
  const [activeId, setActiveId] = useState('none')
  const [selected, setSelected] = useState(0)
  const [screen, setScreen] = useState<Screen>('list')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [field, setField] = useState(0)
  const [editingId, setEditingId] = useState<string | undefined>()

  const load = () => {
    gw.request<{ active_id?: string; profiles?: VoiceProfile[] }>('tts.profiles')
      .then((result) => { setProfiles(result?.profiles ?? []); setActiveId(result?.active_id ?? 'none') })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
  }

  useEffect(load, [gw])

  const speak = (profileId?: string) => {
    if (!text.trim()) {
      setNotice('No assistant reply is available yet; voice configuration was not played.')
      return
    }

    setNotice('Synthesizing and playing…')
    gw.request<{ chars?: number; error?: string; ok?: boolean }>('tts.speak', { ...(profileId ? { profile_id: profileId } : {}), text })
      .then((result) => setNotice(result?.ok ? `Played ${result.chars ?? 0} characters.` : result?.error || 'Playback failed.'))
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
  }

  const isNone = selected === 0
  const selectedProfile = profiles[selected - 1]

  useInput((input, key) => {
    if (screen === 'add') {
      if (key.escape) setScreen('settings')
      if (key.tab) setField((value) => (value + 1) % 3)
      return
    }
    if (key.escape) return screen === 'list' ? onClose() : setScreen('list')
    if (key.upArrow || input === 'k') return setSelected((value) => Math.max(0, value - 1))
    // Rows: None (0), every saved profile (1..N), Settings (N + 1).
    if (key.downArrow || input === 'j') return setSelected((value) => Math.min(profiles.length + 1, value + 1))

    if (screen === 'list') {
      // First S enters the selected voice's action page; a second S there
      // previews it. This deliberately mirrors the requested double-S flow.
      if (input.toLowerCase() === 's') return selectedProfile ? setScreen('profile') : undefined
      if (key.return && isNone) return void gw.request('tts.profile.select', { id: 'none' }).then(() => { setActiveId('none'); setNotice('Voice playback disabled.') })
      if (key.return) return selected === profiles.length + 1 ? setScreen('settings') : selectedProfile ? setScreen('profile') : undefined
      return
    }
    if (screen === 'profile') {
      if (input.toLowerCase() === 's') return speak(selectedProfile?.id)
      if (input.toLowerCase() === 'e' && selectedProfile) {
        setEditingId(selectedProfile.id)
        setName(selectedProfile.name)
        setReferenceId(selectedProfile.referenceId)
        setApiKey('')
        setField(0)
        return setScreen('add')
      }
      if (input.toLowerCase() === 'd' && selectedProfile) {
        return void gw.request('tts.profile.delete', { id: selectedProfile.id }).then(() => { setNotice(`Deleted ${selectedProfile.name}.`); setSelected(0); setScreen('list'); load() })
      }
      if (key.return && selectedProfile) return void gw.request('tts.profile.select', { id: selectedProfile.id }).then(() => { setActiveId(selectedProfile.id); speak(selectedProfile.id) })
      return
    }
    if (screen === 'settings' && key.return) {
      setEditingId(undefined)
      setName(''); setApiKey(''); setReferenceId(''); setField(0)
      setScreen('add')
    }
  })

  const save = () => {
    gw.request<{ error?: string; ok?: boolean }>('tts.profile.save', {
      ...(editingId ? { id: editingId } : {}),
      api_key: apiKey,
      name,
      reference_id: referenceId
    })
      .then((result) => {
        if (!result?.ok) return setNotice(result?.error || 'Unable to save voice profile.')
        setEditingId(undefined); setName(''); setApiKey(''); setReferenceId(''); setNotice('Voice profile saved.'); setScreen('list'); load()
      })
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))
  }

  if (screen === 'add') {
    const fields = [
      ['Profile name', name, setName, false],
      ['Fish Audio API key', apiKey, setApiKey, true],
      ['Voice reference ID', referenceId, setReferenceId, false]
    ] as const
    return <Box flexDirection="column" width={70}>
      <Text bold color={t.color.accent}>{editingId ? 'Edit Fish Audio voice' : 'Add Fish Audio voice'}</Text>
      <Text color={t.color.muted}>Tab switches fields · Enter saves from the last field · leave API key blank to retain it when editing</Text>
      {fields.map(([label, value, change, mask], index) => <Box key={label} marginTop={1}>
        <Text color={field === index ? t.color.accent : t.color.label}>{label}: </Text>
        {field === index ? <TextInput columns={42} mask={mask ? '*' : undefined} onChange={change} onSubmit={() => index === 2 ? save() : setField(index + 1)} value={value} /> : <Text wrap="truncate-end">{mask && value ? '••••••••' : value || '—'}</Text>}
      </Box>)}
      {notice && <Text color={t.color.warn} marginTop={1}>{notice}</Text>}
      <OverlayHint t={t}>Tab next field · Enter save · Esc back</OverlayHint>
    </Box>
  }

  if (screen === 'settings') return <Box flexDirection="column" width={70}>
    <Text bold color={t.color.accent}>Fish Audio settings</Text>
    <Text marginTop={1}>▸ Add a new voice configuration</Text>
    <Text color={t.color.muted}>Save a name, Fish Audio API key, and voice reference ID.</Text>
    {notice && <Text color={t.color.warn} marginTop={1}>{notice}</Text>}
    <OverlayHint t={t}>Enter add configuration · Esc back</OverlayHint>
  </Box>

  if (screen === 'profile' && selectedProfile) return <Box flexDirection="column" width={70}>
    <Text bold color={t.color.accent}>{selectedProfile.name}</Text>
    <Text color={t.color.muted}>Voice ID: {selectedProfile.referenceId}</Text>
    <Text marginTop={1}>Enter / S: use and play latest reply</Text>
    <Text>E: edit this configuration</Text>
    <Text>D: delete this configuration</Text>
    {notice && <Text color={t.color.warn} marginTop={1}>{notice}</Text>}
    <OverlayHint t={t}>Enter use · S play · E edit · D delete · Esc back</OverlayHint>
  </Box>

  return <Box flexDirection="column" width={70}>
    <Text bold color={t.color.accent}>Fish Audio voices</Text>
    <Text color={t.color.muted}>Select None to disable voice playback. Press S twice on a voice to preview.</Text>
    <Box flexDirection="column" marginTop={1}>
      <Text><Text color={selected === 0 ? t.color.accent : t.color.muted}>{selected === 0 ? '▸ ' : '  '}</Text><Text>None</Text><Text color={t.color.muted}>{activeId === 'none' ? ' · active · voice playback off' : ' · disable voice playback'}</Text></Text>
      {profiles.map((profile, index) => <Text key={profile.id}>
        <Text color={index + 1 === selected ? t.color.accent : t.color.muted}>{index + 1 === selected ? '▸ ' : '  '}</Text>
        <Text bold={index + 1 === selected}>{profile.name}</Text><Text color={t.color.muted}> · {profile.referenceId}{activeId === profile.id ? ' · active' : ''}</Text>
      </Text>)}
      <Text><Text color={selected === profiles.length + 1 ? t.color.accent : t.color.muted}>{selected === profiles.length + 1 ? '▸ ' : '  '}</Text><Text>Settings</Text></Text>
    </Box>
    {notice && <Text color={t.color.warn} marginTop={1}>{notice}</Text>}
    <OverlayHint t={t}>↑/↓ select · Enter details/settings · S actions · Esc close</OverlayHint>
  </Box>
}

interface FishAudioPickerProps { gw: GatewayClient; onClose: () => void; t: Theme; text: string }
