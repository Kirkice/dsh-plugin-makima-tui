import { describe, expect, it } from 'vitest'

import { collectDetailTargets, visibleItemIndexes } from '../domain/detailTargets.js'
import type { Msg } from '../types.js'

describe('collectDetailTargets', () => {
  it('lists newest expandable blocks first and ignores tools without verbose output', () => {
    const messages: Msg[] = [
      { role: 'user', text: 'first' },
      {
        kind: 'trail',
        role: 'system',
        text: '',
        thinking: 'reasoning one',
        tools: ['Read(a.ts) :: Read 4 lines ✓', 'Bash(seq 6) :: 1\n2\n… +4 lines ✓'],
        toolsVerbose: ['', 'Bash(seq 6) :: Result:\n1\n2\n3\n4\n5\n6 ✓']
      },
      { role: 'user', text: 'second' },
      {
        kind: 'trail',
        role: 'system',
        text: '',
        thinking: 'reasoning two',
        tools: ['Grep(foo) :: Found 2 lines ✓'],
        toolsVerbose: ['Grep(foo) :: Result:\na.ts:1\na.ts:2 ✓']
      }
    ]
    const ids = new Map(messages.map((message, index) => [message, `m${index}`]))
    const expanded = { 'm3:tool:0': true }

    expect(collectDetailTargets(messages, (message) => ids.get(message)!, expanded)).toEqual([
      { expanded: false, key: 'm3:thinking', label: 'Turn 2 · Reasoning' },
      { expanded: true, key: 'm3:tool:0', label: 'Turn 2 · Grep(foo)' },
      { expanded: false, key: 'm1:thinking', label: 'Turn 1 · Reasoning' },
      { expanded: false, key: 'm1:tool:1', label: 'Turn 1 · Bash(seq 6)' }
    ])
  })
})

describe('visibleItemIndexes', () => {
  it('includes rows that partially intersect either viewport edge', () => {
    expect(visibleItemIndexes([0, 3, 7, 10], 2, 5, 3)).toEqual([0, 1])
  })

  it('excludes rows that only touch the viewport boundary', () => {
    expect(visibleItemIndexes([0, 3, 7, 10, 14], 3, 7, 4)).toEqual([1, 2])
  })

  it('accounts for a pending scroll target and empty viewports', () => {
    expect(visibleItemIndexes([0, 4, 8, 12], 8, 4, 3)).toEqual([2])
    expect(visibleItemIndexes([0, 4], 0, 0, 1)).toEqual([])
    expect(visibleItemIndexes([0], 0, 10, 0)).toEqual([])
  })
})
