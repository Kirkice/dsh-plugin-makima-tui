import { describe, expect, it } from 'vitest'

import { SLASHES } from '../gatewayClient.js'
import { highlightLine, isHighlightable } from '../lib/syntax.js'
import { DEFAULT_THEME } from '../theme.js'

const t = DEFAULT_THEME

describe('syntax highlighter', () => {
  it('recognizes supported langs and aliases', () => {
    expect(isHighlightable('ts')).toBe(true)
    expect(isHighlightable('cpp')).toBe(true)
    expect(isHighlightable('c++')).toBe(true)
    expect(isHighlightable('cxx')).toBe(true)
    expect(isHighlightable('js')).toBe(true)
    expect(isHighlightable('python')).toBe(true)
    expect(isHighlightable('rs')).toBe(true)
    expect(isHighlightable('bash')).toBe(true)
    expect(isHighlightable('whatever')).toBe(false)
    expect(isHighlightable('')).toBe(false)
  })

  it('paints a whole-line comment with the local syntax palette', () => {
    const tokens = highlightLine('// hello', 'ts', t)

    expect(tokens).toEqual([['#676E98', '// hello']])
  })

  it('paints keywords, strings, and numbers with the local syntax palette', () => {
    const tokens = highlightLine(`const x = 'hi' + 42`, 'ts', t)
    const colors = tokens.map(tok => tok[0])

    expect(colors).toContain('#C792EA') // const
    expect(colors).toContain('#C3E88D') // 'hi'
    expect(colors).toContain('#F78C6C') // 42
  })

  it('paints C++ keywords and types', () => {
    const tokens = highlightLine('class Widget { int count = 42; };', 'cpp', t)
    const colors = tokens.map(tok => tok[0])

    expect(colors).toContain('#FFCB6B') // class
    expect(colors).toContain('#C792EA') // int
    expect(colors).toContain('#F78C6C') // 42
  })

  it('falls through unchanged for unknown langs', () => {
    const tokens = highlightLine(`const x = 1`, 'zzz', t)

    expect(tokens).toEqual([['', 'const x = 1']])
  })

  it('treats `#` as a python comment, not a selector', () => {
    const tokens = highlightLine('# comment', 'py', t)

    expect(tokens).toEqual([['#676E98', '# comment']])
  })
})

describe('plugin slash commands', () => {
  it('advertises /plugins and its singular alias as an interactive manager with runtime status mode', () => {
    const byName = new Map(SLASHES.map(command => [command.name, command]))

    expect([...byName.keys()]).toEqual(expect.arrayContaining(['/plugin', '/plugins']))
    expect(byName.get('/plugins')?.hint).toBe('[runtime]')
    expect(byName.get('/plugin')?.hint).toBe('[runtime]')
  })
})
