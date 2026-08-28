import { parseToolTrailResultLine } from '../lib/text.js'
import type { DetailTarget, Msg } from '../types.js'

const compactToolLabel = (line: string, index: number): string => {
  const parsed = parseToolTrailResultLine(line)

  if (parsed?.call) {
    return parsed.call
  }

  const first = (line.split('\n')[0] ?? '').trim()

  return first || `Tool call ${index + 1}`
}

/** Returns item indexes whose measured/estimated row interval intersects the viewport. */
export const visibleItemIndexes = (
  offsets: ArrayLike<number>,
  scrollTop: number,
  viewportHeight: number,
  itemCount: number
): number[] => {
  if (viewportHeight <= 0 || itemCount <= 0) {
    return []
  }

  const top = Math.max(0, scrollTop)
  const bottom = top + viewportHeight
  const visible: number[] = []

  for (let index = 0; index < itemCount; index++) {
    const rowTop = offsets[index] ?? 0
    const rowBottom = offsets[index + 1] ?? rowTop

    if (rowBottom > top && rowTop < bottom) {
      visible.push(index)
    } else if (rowTop >= bottom) {
      break
    }
  }

  return visible
}

/** Builds independently expandable targets from settled transcript content, newest first. */
export const collectDetailTargets = (
  messages: readonly Msg[],
  keyOf: (msg: Msg) => string,
  expanded: Readonly<Record<string, boolean>>
): DetailTarget[] => {
  const targets: DetailTarget[] = []
  let turn = 0
  const turns = new Map<Msg, number>()

  for (const msg of messages) {
    if (msg.role === 'user') {
      turn++
    }

    turns.set(msg, Math.max(1, turn))
  }

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const msg = messages[messageIndex]!
    const scope = keyOf(msg)
    const turnLabel = `Turn ${turns.get(msg) ?? 1}`

    if (/\S/.test(msg.thinking ?? '')) {
      const key = `${scope}:thinking`
      targets.push({ expanded: expanded[key] ?? false, key, label: `${turnLabel} · Reasoning` })
    }

    for (let toolIndex = (msg.tools?.length ?? 0) - 1; toolIndex >= 0; toolIndex--) {
      if (!msg.toolsVerbose?.[toolIndex]) {
        continue
      }

      const key = `${scope}:tool:${toolIndex}`
      targets.push({
        expanded: expanded[key] ?? false,
        key,
        label: `${turnLabel} · ${compactToolLabel(msg.tools![toolIndex]!, toolIndex)}`
      })
    }
  }

  return targets
}
