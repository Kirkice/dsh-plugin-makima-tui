/** Displays the active turn's current task, elapsed usage, and delegation state. */
import { Box, stringWidth, Text } from '@makima-tui/ink'
import { useStore } from '@nanostores/react'
import { memo, useEffect, useMemo, useState } from 'react'

import { $delegationState } from '../app/delegationStore.js'
import { useTurnSelector } from '../app/turnStore.js'
import { $uiState } from '../app/uiStore.js'
import { VERBS } from '../content/verbs.js'
import { fmtDuration } from '../domain/messages.js'
import { buildSubagentTree, treeTotals } from '../lib/subagentTree.js'
import { fmtK } from '../lib/text.js'
import type { Theme } from '../theme.js'

const SHIMMER_TICK_MS = 200
const SHIMMER_BAND = 3
const MARKER_COLORS = 8
const SHOW_SUFFIX_AFTER_MS = 30_000
const STALL_AFTER_MS = 3_000
// Original useStalledAnimation ERROR_RED — deliberately NOT theme.error.
const STALL_RED = 'rgb(171,43,63)'

/** Verb with a claudeShimmer band sweeping right→left (GlimmerMessage-lite). */
function ShimmerVerb({ stalled, t, tick, verb }: { stalled: boolean; t: Theme; tick: number; verb: string }) {
  if (stalled) {
    return <Text color={STALL_RED}>{verb}</Text>
  }

  const chars = [...verb]
  const period = chars.length + SHIMMER_BAND
  const head = period - 1 - (tick % period) // right→left sweep

  return (
    <Text>
      {chars.map((ch, i) => (
        <Text color={i >= head && i < head + SHIMMER_BAND ? t.color.claudeShimmer : t.color.accent} key={i}>
          {ch}
        </Text>
      ))}
    </Text>
  )
}

/** A fixed-width marker that breathes through foreground colors without terminal background repainting. */
function BreathingMarker({ stalled, t, tick }: { stalled: boolean; t: Theme; tick: number }) {
  if (stalled) {
    return <Text color={STALL_RED}>› </Text>
  }

  const phase = tick % MARKER_COLORS
  const color =
    phase === 0 || phase === MARKER_COLORS - 1 ? t.color.muted : phase === 3 || phase === 4 ? t.color.claudeShimmer : t.color.accent

  return <Text color={color}>› </Text>
}

export const BusyLine = memo(function BusyLine({ t, turnStartedAt }: BusyLineProps) {
  const ui = useStore($uiState)
  const todos = useTurnSelector((state) => state.todos)
  const todoCollapsed = useTurnSelector((state) => state.todoCollapsed)
  const tools = useTurnSelector((state) => state.tools)
  const streamedChars = useTurnSelector((state) => state.streamedChars)
  const lastDeltaAt = useTurnSelector((state) => state.lastDeltaAt)
  const reasoningStreaming = useTurnSelector((state) => state.reasoningStreaming)
  const subagents = useTurnSelector((state) => state.subagents)
  const delegation = useStore($delegationState)

  const [tick, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // One random verb per turn (original sample()-on-mount).
  const fallbackVerb = useMemo(
    () => VERBS[Math.floor(Math.random() * VERBS.length)] ?? 'working',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turnStartedAt]
  )

  useEffect(() => {
    if (!ui.busy) {
      return
    }

    const shimmer = setInterval(() => setTick((n) => n + 1), SHIMMER_TICK_MS)
    const clock = setInterval(() => setNow(Date.now()), 1000)

    return () => {
      clearInterval(shimmer)
      clearInterval(clock)
    }
  }, [ui.busy])

  if (!ui.busy) {
    return null
  }

  const activeTodo = todos.find((todo) => todo.status === 'in_progress')
  const verb = `${activeTodo?.activeForm ?? activeTodo?.content ?? fallbackVerb}…`

  const shimmerTick = tick

  const elapsedMs = turnStartedAt ? now - turnStartedAt : 0
  const stalled = tools.length === 0 && lastDeltaAt !== null && now - lastDeltaAt > STALL_AFTER_MS

  // Suffix parts appear progressively after 30s (SHOW_TOKENS_AFTER_MS parity).
  const parts: string[] = []

  if (elapsedMs > SHOW_SUFFIX_AFTER_MS) {
    parts.push(fmtDuration(elapsedMs))

    const tokens = Math.round(streamedChars / 4)

    if (tokens > 0) {
      parts.push(`↓ ~${fmtK(tokens)} tokens`)
    }
  }

  if (reasoningStreaming) {
    parts.push('thinking…')
  }

  // Delegation segment (right-aligned, dim) only while fanning out.
  const tree = buildSubagentTree(subagents)
  const totals = treeTotals(tree)
  const delegating = totals.descendantCount > 0 || delegation.paused

  const delegationLabel = !delegating
    ? ''
    : totals.descendantCount === 0
      ? '⏸ paused'
      : `${delegation.paused ? '⏸ ' : ''}⛓ ${totals.activeCount > 0 ? `${totals.activeCount} running` : `${totals.descendantCount} spawned`}`

  // The one-line "Next:" hint is the original's expandedView='none' render —
  // it only shows while the full checklist is toggled OFF (ctrl+t). With the
  // list attached right below through the └ connector, it would duplicate
  // the first pending row.
  const nextTodo = todoCollapsed ? todos.find((todo) => todo.status === 'pending') : undefined

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text>
          <BreathingMarker stalled={stalled} t={t} tick={tick} />
          <ShimmerVerb stalled={stalled} t={t} tick={shimmerTick} verb={verb} />
          {parts.length > 0 && (
            <Text color={t.color.muted} dim>
              {' ('}
              {parts.join(' · ')}
              {')'}
            </Text>
          )}
        </Text>
        {delegationLabel ? (
          <Text color={t.color.muted} dim>
            {delegationLabel}
          </Text>
        ) : null}
      </Box>
      {nextTodo && stringWidth(nextTodo.content) > 0 ? (
        <Text color={t.color.muted} dim>
          ↳ next {nextTodo.content}
        </Text>
      ) : null}
    </Box>
  )
})

interface BusyLineProps {
  t: Theme
  turnStartedAt: null | number
}
