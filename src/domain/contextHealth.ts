import type { Usage } from '../types.js'

export type ContextHealthLevel = 'healthy' | 'watch' | 'critical' | 'unknown'

export interface ContextHealth {
  compressions: number
  level: ContextHealthLevel
  percent: null | number
  summary: string
  used: null | number
  window: null | number
}

const boundedPercent = (value: number): number => Math.max(0, Math.min(100, Math.round(value)))

/**
 * Converts the gateway's optional context telemetry into a stable UX state.
 * A missing window is intentionally `unknown`: guessing a model's context
 * capacity would make the transparency surface less trustworthy.
 */
export const contextHealth = (usage: Partial<Usage> | null | undefined): ContextHealth => {
  const rawPercent = usage?.context_percent
  const used = usage?.context_used
  const window = usage?.context_max
  const derived = typeof used === 'number' && typeof window === 'number' && window > 0 ? (used / window) * 100 : null
  const percent = typeof rawPercent === 'number' ? boundedPercent(rawPercent) : derived === null ? null : boundedPercent(derived)
  const compressions = Math.max(0, Math.floor(usage?.compressions ?? 0))

  if (percent === null) {
    return { compressions, level: 'unknown', percent: null, summary: 'Context capacity unavailable', used: null, window: null }
  }

  const level: ContextHealthLevel = percent >= 85 ? 'critical' : percent >= 65 ? 'watch' : 'healthy'
  const capacity = typeof used === 'number' && typeof window === 'number' ? `${used.toLocaleString()} / ${window.toLocaleString()} tokens` : `${percent}% of context`
  const compressionNote = compressions ? ` · ${compressions} compression${compressions === 1 ? '' : 's'}` : ''
  const prefix = level === 'critical' ? 'Context nearly full' : level === 'watch' ? 'Context filling' : 'Context healthy'

  return { compressions, level, percent, summary: `${prefix} · ${capacity}${compressionNote}`, used: used ?? null, window: window ?? null }
}
