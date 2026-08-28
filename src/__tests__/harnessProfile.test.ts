import { describe, expect, it } from 'vitest'

import { resolveManagedProfile } from '../harness/profile.js'

describe('resolveManagedProfile', () => {
  it('prefers an explicitly configured managed profile', () => {
    expect(resolveManagedProfile({ argv: ['node', 'dsh', '--profile', 'makima-tui'], configured: 'custom' })).toBe('custom')
  })

  it('uses the profile passed to dsh through separate or equals syntax', () => {
    expect(resolveManagedProfile({ argv: ['node', 'dsh', '--profile', 'makima-tui'], env: {} })).toBe('makima-tui')
    expect(resolveManagedProfile({ argv: ['node', 'dsh', '--profile=makima-tui'], env: {} })).toBe('makima-tui')
  })

  it('falls back to the legacy environment override and final default', () => {
    expect(resolveManagedProfile({ argv: ['node', 'dsh'], env: { MAKIMA_TUI_PROFILE: 'from-env' } })).toBe('from-env')
    expect(resolveManagedProfile({ argv: ['node', 'dsh'], env: {}, fallback: 'fallback-profile' })).toBe('fallback-profile')
  })

  it('ignores blank profile values', () => {
    expect(resolveManagedProfile({ argv: ['node', 'dsh', '--profile', '  '], env: { MAKIMA_TUI_PROFILE: '  ' } })).toBe('makima')
  })
})
