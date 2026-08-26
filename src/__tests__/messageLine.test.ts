import { describe, expect, it } from 'vitest'

import { responseDivider, shouldShowResponseSeparator } from '../components/messageLine.js'

describe('shouldShowResponseSeparator', () => {
  it('marks every non-empty assistant answer', () => {
    expect(shouldShowResponseSeparator({ role: 'assistant', text: 'final', thinking: 'plan' }, true)).toBe(true)
    expect(shouldShowResponseSeparator({ role: 'assistant', text: 'final' }, false)).toBe(true)
  })

  it('does not add an answer marker without body text', () => {
    expect(shouldShowResponseSeparator({ role: 'assistant', text: '   ', thinking: 'plan' }, true)).toBe(false)
  })

  it('does not add response separators to non-assistant transcript rows', () => {
    expect(shouldShowResponseSeparator({ role: 'user', text: 'prompt' }, true)).toBe(false)
    expect(shouldShowResponseSeparator({ role: 'system', text: 'note' }, true)).toBe(false)
  })
  it('fills the available transcript width with a labeled response divider', () => {
    const divider = responseDivider(80, 3)

    expect(divider.left).toHaveLength(8)
    expect(divider.left.length + divider.right.length).toBe(56)
  })

  it('retains a visible divider in narrow terminals', () => {
    const divider = responseDivider(20, 3)

    expect(divider.left.length).toBeGreaterThanOrEqual(3)
    expect(divider.right.length).toBeGreaterThanOrEqual(1)
  })
})
