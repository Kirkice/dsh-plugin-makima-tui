import { describe, expect, it } from 'vitest'

import { toolVisual } from '../domain/toolVisual.js'

describe('toolVisual', () => {
  it('uses semantic glyphs for common tools', () => {
    expect(toolVisual('Read(src/app.ts)', 'success')).toMatchObject({ glyph: '⌕', label: 'Read', tone: 'ok' })
    expect(toolVisual('Bash(npm test)', 'running')).toMatchObject({ glyph: '$', label: 'Bash', tone: 'accent' })
    expect(toolVisual('Edit(src/theme.ts)', 'error')).toMatchObject({ glyph: '✎', label: 'Edit', tone: 'error' })
    expect(toolVisual('Delegate Task(review)', 'success')).toMatchObject({ glyph: '⛓', tone: 'ok' })
  })

  it('keeps unknown tools visually neutral', () => {
    expect(toolVisual('Mcp Github List Prs(open)', 'pending')).toMatchObject({ glyph: '◇', tone: 'accent' })
  })
})
