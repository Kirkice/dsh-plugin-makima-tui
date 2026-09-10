import { Box, Text, useInput } from '@makima-tui/ink'
import { useEffect, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import type { Theme } from '../theme.js'

import { OverlayHint } from './overlayControls.js'

const PERSONALITIES = [
  { description: 'Use the active Harness deployment persona.', id: 'default', label: 'Default' },
  { description: 'Calm, precise Makima-inspired technical assistant.', id: 'makima', label: 'Makima' }
] as const

export function PersonalityPicker({ gw, onClose, onSelect, t }: PersonalityPickerProps) {
  const [current, setCurrent] = useState('default')
  const [index, setIndex] = useState(0)

  useEffect(() => {
    gw.request<{ value?: string }>('config.get', { key: 'personality' })
      .then((result) => {
        const selected = result?.value ?? 'default'
        const selectedIndex = Math.max(0, PERSONALITIES.findIndex((persona) => persona.id === selected))
        setCurrent(selected)
        setIndex(selectedIndex)
      })
      .catch(() => undefined)
  }, [gw])

  useInput((_input, key) => {
    if (key.escape) return onClose()
    if (key.upArrow || _input === 'k') return setIndex((value) => Math.max(0, value - 1))
    if (key.downArrow || _input === 'j') return setIndex((value) => Math.min(PERSONALITIES.length - 1, value + 1))
    if (key.return) return onSelect(PERSONALITIES[index].id)
  })

  return (
    <Box flexDirection="column">
      <Text bold color={t.color.accent}>
        Choose personality
      </Text>
      <Text color={t.color.muted}>The selection applies now and is saved for future sessions.</Text>
      <Box flexDirection="column" marginTop={1}>
        {PERSONALITIES.map((persona, itemIndex) => {
          const active = itemIndex === index
          return (
            <Box flexDirection="column" key={persona.id}>
              <Text wrap="truncate-end">
                <Text bold={active} color={active ? t.color.accent : t.color.muted}>
                  {active ? '▸ ' : '  '}
                </Text>
                <Text bold={active} color={active ? t.color.highlight : t.color.text} inverse={active}>
                  {persona.label}
                </Text>
                {persona.id === current && <Text color={t.color.muted}> · current</Text>}
              </Text>
              <Text color={t.color.muted} wrap="wrap">
                {'    '}{persona.description}
              </Text>
            </Box>
          )
        })}
      </Box>
      <OverlayHint t={t}>↑/↓ or j/k select · Enter apply · Esc cancel</OverlayHint>
    </Box>
  )
}

interface PersonalityPickerProps {
  gw: GatewayClient
  onClose: () => void
  onSelect: (id: string) => void
  t: Theme
}
