import { describe, expect, it, vi } from 'vitest'

import { handleMouseEvent } from './components/App.js'
import { createSelectionState, hasSelection, startSelection, updateSelection } from './selection.js'

const makeApp = () => {
  const selection = createSelectionState()

  return {
    clickCount: 1,
    lastHoverCol: -1,
    lastHoverRow: -1,
    mouseCaptureTarget: undefined,
    props: {
      getSelectedText: vi.fn(() => 'selected text'),
      onCopySelectionNoClear: vi.fn(async () => 'selected text'),
      onHoverAt: vi.fn(),
      onMouseDownAt: vi.fn(),
      onMouseDragAt: vi.fn(),
      onMouseUpAt: vi.fn(),
      onSelectionChange: vi.fn(),
      selection
    }
  } as any
}

describe('handleMouseEvent right-click selection behavior', () => {
  it('copies an active selection instead of dispatching right-click paste handlers', async () => {
    const app = makeApp()

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)

    handleMouseEvent(app, { action: 'press', button: 2, col: 3, kind: 'mouse', row: 1 })
    await Promise.resolve()

    expect(app.props.onCopySelectionNoClear).toHaveBeenCalledOnce()
    expect(app.props.onMouseDownAt).not.toHaveBeenCalled()
    expect(app.clickCount).toBe(0)
  })

  it('clears the highlight after a successful right-click copy', async () => {
    const app = makeApp()

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)
    expect(hasSelection(app.props.selection)).toBe(true)

    handleMouseEvent(app, { action: 'press', button: 2, col: 3, kind: 'mouse', row: 1, sequence: '' })
    await Promise.resolve()
    await Promise.resolve()

    // Deliberate copy clears the selection (visual confirmation + a follow-up
    // right-click on empty space pastes rather than re-copying a stale range).
    expect(hasSelection(app.props.selection)).toBe(false)
    expect(app.props.onSelectionChange).toHaveBeenCalled()
  })

  it('keeps the highlight when right-click copy fails (no clipboard path)', async () => {
    const app = makeApp()
    app.props.onCopySelectionNoClear.mockResolvedValue('')

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)

    handleMouseEvent(app, { action: 'press', button: 2, col: 3, kind: 'mouse', row: 1, sequence: '' })
    await Promise.resolve()
    await Promise.resolve()

    // Copy didn't land, so the highlight must survive (and we fall back to the
    // right-click paste handler instead).
    expect(hasSelection(app.props.selection)).toBe(true)
  })

  it('falls back to right-click handlers when selection copy has no clipboard path', async () => {
    const app = makeApp()
    app.props.onCopySelectionNoClear.mockResolvedValue('')

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)

    handleMouseEvent(app, { action: 'press', button: 2, col: 3, kind: 'mouse', row: 1 })
    await Promise.resolve()

    expect(app.props.onCopySelectionNoClear).toHaveBeenCalledOnce()
    expect(app.props.onMouseDownAt).toHaveBeenCalledWith(2, 0, 2)
  })

  it('does not paste when highlighted selection text is empty', async () => {
    const app = makeApp()
    app.props.getSelectedText.mockReturnValue('')

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)

    handleMouseEvent(app, { action: 'press', button: 2, col: 3, kind: 'mouse', row: 1 })
    await Promise.resolve()

    expect(app.props.onCopySelectionNoClear).not.toHaveBeenCalled()
    expect(app.props.onMouseDownAt).not.toHaveBeenCalled()
  })

  it('does not repeatedly copy or paste during right-button motion events over a selection', () => {
    const app = makeApp()

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)

    handleMouseEvent(app, { action: 'press', button: 0x20 | 2, col: 3, kind: 'mouse', row: 1 })

    expect(app.props.onCopySelectionNoClear).not.toHaveBeenCalled()
    expect(app.props.onMouseDownAt).not.toHaveBeenCalled()
  })

  it('still dispatches right-click handlers when no text is selected', () => {
    const app = makeApp()

    handleMouseEvent(app, { action: 'press', button: 2, col: 3, kind: 'mouse', row: 1 })

    expect(app.props.onCopySelectionNoClear).not.toHaveBeenCalled()
    expect(app.props.onMouseDownAt).toHaveBeenCalledWith(2, 0, 2)
  })
})

describe('handleMouseEvent left-click selection repaint behavior', () => {
  it('does not notify selection subscribers for a bare click without drag motion', () => {
    const app = makeApp()
    app.props.onClickAt = vi.fn(() => false)
    app.props.getHyperlinkAt = vi.fn()

    handleMouseEvent(app, { action: 'press', button: 0, col: 3, kind: 'mouse', row: 1, sequence: '' })
    handleMouseEvent(app, { action: 'release', button: 0, col: 3, kind: 'mouse', row: 1, sequence: '' })

    expect(hasSelection(app.props.selection)).toBe(false)
    expect(app.props.onClickAt).toHaveBeenCalledWith(2, 0)
    expect(app.props.onSelectionChange).not.toHaveBeenCalled()
  })

  it('repaints immediately when a fresh press replaces a visible selection', () => {
    const app = makeApp()

    startSelection(app.props.selection, 0, 0)
    updateSelection(app.props.selection, 4, 0)
    expect(hasSelection(app.props.selection)).toBe(true)

    handleMouseEvent(app, { action: 'press', button: 0, col: 8, kind: 'mouse', row: 2, sequence: '' })

    expect(hasSelection(app.props.selection)).toBe(false)
    expect(app.props.onSelectionChange).toHaveBeenCalledOnce()
  })

  it('still notifies when a real drag selection is released', () => {
    const app = makeApp()

    handleMouseEvent(app, { action: 'press', button: 0, col: 1, kind: 'mouse', row: 1, sequence: '' })
    updateSelection(app.props.selection, 4, 0)
    handleMouseEvent(app, { action: 'release', button: 0, col: 4, kind: 'mouse', row: 1, sequence: '' })

    expect(hasSelection(app.props.selection)).toBe(true)
    expect(app.props.onSelectionChange).toHaveBeenCalledOnce()
  })
})
