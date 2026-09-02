import { briefToolName } from './toolBrief.js'

export type ToolVisualStatus = 'error' | 'pending' | 'running' | 'success'

export interface ToolVisual {
  glyph: string
  label: string
  tone: 'accent' | 'error' | 'muted' | 'ok' | 'text' | 'warn'
}

/** Stable visual vocabulary for tool rows. Kept independent of the wire
 * protocol so new backends can reuse the same transcript language. */
export function toolVisual(call: string, status: ToolVisualStatus): ToolVisual {
  const name = briefToolName(call)
  const normalized = name.toLowerCase().replace(/[^a-z]/g, '')
  const glyph =
    normalized.includes('bash') || normalized.includes('shell') || normalized === 'exec'
      ? '$'
      : normalized.includes('edit') || normalized.includes('write') || normalized.includes('notebook')
        ? '✎'
        : normalized.includes('read') || normalized.includes('glob')
          ? '⌕'
          : normalized.includes('grep') || normalized.includes('search') || normalized.includes('fetch')
            ? '◎'
            : normalized.includes('agent') ||
                normalized.includes('task') ||
                normalized.includes('subagent') ||
                normalized.includes('delegate')
              ? '⛓'
              : normalized.includes('question') || normalized.includes('clarify')
                ? '?'
                : '◇'

  const tone = status === 'error' ? 'error' : status === 'running' || status === 'pending' ? 'accent' : status === 'success' ? 'ok' : 'text'

  return { glyph, label: name || 'Tool', tone }
}
