import { describe, expect, it } from 'vitest'

import { qualityGateStatusLabel, qualityGateSummary } from '../domain/qualityGate.js'

describe('qualityGateSummary', () => {
  it('fails closed when any reported verification fails', () => {
    const result = qualityGateSummary([
      { command: 'npm run typecheck', name: 'Typecheck', status: 'passed' },
      { command: 'npm test', name: 'Tests', status: 'failed' }
    ])

    expect(result).toMatchObject({ failed: 1, passed: 1, status: 'failed', total: 2 })
    expect(qualityGateStatusLabel(result.status)).toBe('FAILED')
  })

  it('reports a running gate before all checks finish', () => {
    expect(qualityGateSummary([{ command: 'npm test', name: 'Tests', status: 'running' }]).status).toBe('running')
  })

  it('does not claim a passing gate when no checks are available', () => {
    expect(qualityGateSummary([]).status).toBe('skipped')
    expect(qualityGateStatusLabel('skipped')).toBe('NO CHECKS')
  })
})
