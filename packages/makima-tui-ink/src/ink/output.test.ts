import { describe, expect, it } from 'vitest'

import Output from './output.js'
import { cellAt, CellWidth, CharPool, createScreen, HyperlinkPool, setCellAt, StylePool } from './screen.js'

const WIDTH = 12
const HEIGHT = 4

const paint = (screen: ReturnType<typeof createScreen>, x: number, y: number, text: string) => {
  for (let offset = 0; offset < text.length; offset++) {
    setCellAt(screen, x + offset, y, {
      char: text[offset]!,
      hyperlink: undefined,
      styleId: screen.emptyStyleId,
      width: CellWidth.Narrow
    })
  }
}

describe('Output styled control-character handling', () => {
  it('preserves a tab background while expanding it into indentation cells', () => {
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const screen = createScreen(WIDTH, HEIGHT, styles, chars, links)
    const output = new Output({ height: HEIGHT, screen, stylePool: styles, width: WIDTH })

    output.write(0, 0, '\u001b[48;2;24;67;82m+\tcode\u001b[49m')

    const rendered = output.get()
    const backgroundStyle = cellAt(rendered, 0, 0)!.styleId

    // The tab begins after '+', so it expands through column 7. Every generated
    // space must keep the same diff background rather than exposing the terminal.
    for (let x = 1; x < 8; x++) {
      expect(cellAt(rendered, x, 0)).toMatchObject({ char: ' ', styleId: backgroundStyle })
    }
    expect(cellAt(rendered, 8, 0)).toMatchObject({ char: 'c', styleId: backgroundStyle })
  })
})

describe('Output stale-region handling', () => {
  it('does not let a later clean-subtree blit restore a cleared old border region', () => {
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const previous = createScreen(WIDTH, HEIGHT, styles, chars, links)
    const next = createScreen(WIDTH, HEIGHT, styles, chars, links)

    // Model an earlier, wider rounded box. The current box has already
    // shrunk, so its old right and bottom edges need to remain empty.
    paint(previous, 1, 0, '╭────────╮')
    paint(previous, 1, 1, '│ content │')
    paint(previous, 1, 2, '╰────────╯')

    const output = new Output({ height: HEIGHT, screen: next, stylePool: styles, width: WIDTH })
    output.clear({ height: 3, width: 10, x: 1, y: 0 }, false, true)
    output.blit(previous, 0, 0, WIDTH, HEIGHT)

    const screen = output.get()

    expect(cellAt(screen, 1, 0)?.char).toBe(' ')
    expect(cellAt(screen, 10, 0)?.char).toBe(' ')
    expect(cellAt(screen, 10, 1)?.char).toBe(' ')
    expect(cellAt(screen, 10, 2)?.char).toBe(' ')
    expect(cellAt(screen, 1, 2)?.char).toBe(' ')
  })

  it('still blits cells outside the cleared old bounds', () => {
    const styles = new StylePool()
    const chars = new CharPool()
    const links = new HyperlinkPool()
    const previous = createScreen(WIDTH, HEIGHT, styles, chars, links)
    const next = createScreen(WIDTH, HEIGHT, styles, chars, links)

    paint(previous, 0, 3, 'unchanged')

    const output = new Output({ height: HEIGHT, screen: next, stylePool: styles, width: WIDTH })
    output.clear({ height: 2, width: 4, x: 2, y: 0 })
    output.blit(previous, 0, 0, WIDTH, HEIGHT)

    expect(cellAt(output.get(), 0, 3)?.char).toBe('u')
  })
})
