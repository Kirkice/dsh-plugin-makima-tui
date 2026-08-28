import { describe, expect, it } from 'vitest'

import { contextHealth } from '../domain/contextHealth.js'

describe('contextHealth', () => {
  it('does not invent a capacity when telemetry is absent', () => {
    expect(contextHealth({})).toMatchObject({ level: 'unknown', percent: null, summary: 'Context capacity unavailable' })
  })

  it('derives a healthy percentage from used and maximum tokens', () => {
    expect(contextHealth({ context_max: 200_000, context_used: 40_000 })).toMatchObject({ level: 'healthy', percent: 20 })
  })

  it('uses gateway percentage and surfaces compression pressure', () => {
    const health = contextHealth({ compressions: 2, context_percent: 72, context_used: 144_000, context_max: 200_000 })
    expect(health).toMatchObject({ compressions: 2, level: 'watch', percent: 72 })
    expect(health.summary).toContain('2 compressions')
  })

  it('marks near-full context as critical', () => {
    expect(contextHealth({ context_percent: 85 })).toMatchObject({ level: 'critical', percent: 85 })
  })
})
