import { userInfo } from 'os'

import { applyColor, Box, stringWidth, Text, useStdout } from '@makima-tui/ink'
import { useEffect, useState } from 'react'
import unicodeSpinners from 'unicode-animations'

import { artWidth, logo } from '../banner.js'
import { levelForMode } from '../lib/permissionLevels.js'
import { flat } from '../lib/text.js'
import { getWorktreeSession } from '../lib/worktree.js'
import type { Theme } from '../theme.js'
import type { PanelSection, SessionInfo } from '../types.js'

const LOADER_TICK_MS = 120

function InlineLoader({ label, t }: { label: string; t: Theme }) {
  const [tick, setTick] = useState(0)
  const spinner = unicodeSpinners.braille
  const frame = spinner.frames[tick % spinner.frames.length] ?? '⠋'

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), Math.max(LOADER_TICK_MS, spinner.interval))

    return () => clearInterval(id)
  }, [spinner.interval])

  return (
    <Text color={t.color.muted} wrap="truncate">
      <Text color={t.color.accent}>{frame}</Text> {label}
    </Text>
  )
}

export function ArtLines({ lines }: { lines: [string, string][] }) {
  return (
    <Box flexDirection="column" height={lines.length} opaque width={artWidth(lines)}>
      {lines.map(([c, text], i) => (
        <Text color={c} key={i} wrap="truncate-end">
          {text}
        </Text>
      ))}
    </Box>
  )
}

// Makima Agent's CLI banner uses a small pixel portrait rather than a generic
// wordmark. Keep the portrait as explicit background-colored cells so it stays
// recognizable in a terminal without relying on six-row block-letter ASCII art.
const MAKIMA_PIXEL_ART: readonly (readonly (string | null)[])[] = [
  [null, null, null, '#b94d58', '#bc4f5a', '#d05966', '#d15966', '#d15966', '#d05966', '#bc4f5a', '#b94d58', null, null, null],
  [null, null, '#d25864', '#ce5964', '#d15966', '#d25a67', '#d15a67', '#d15a67', '#d25a67', '#d15966', '#ce5964', '#d25864', null, null],
  [
    null,
    '#c1515a',
    '#cf5865',
    '#d15966',
    '#d25b67',
    '#d05966',
    '#d15b67',
    '#d15b67',
    '#d05966',
    '#d25b67',
    '#d15966',
    '#cf5865',
    '#c1515a',
    null
  ],
  [
    null,
    '#c45862',
    '#d05863',
    '#d05964',
    '#d15663',
    '#d15966',
    '#d15a67',
    '#d15a67',
    '#d15966',
    '#d15663',
    '#d05964',
    '#d05863',
    '#c45862',
    null
  ],
  [
    null,
    '#d15965',
    '#d05965',
    '#d05966',
    '#d85f6a',
    '#a13e4a',
    '#d25b68',
    '#d25b68',
    '#a13e4a',
    '#d85f6a',
    '#d05966',
    '#d05965',
    '#d15965',
    null
  ],
  [
    '#ae4350',
    '#d15a66',
    '#a53f4c',
    '#cf5865',
    '#ca4d5d',
    '#a33e4b',
    '#d25a67',
    '#d25a67',
    '#a33e4b',
    '#ca4d5d',
    '#cf5865',
    '#a53f4c',
    '#d15a66',
    '#ae4350'
  ],
  [
    '#b74957',
    '#b14552',
    '#a33d4a',
    '#ae4654',
    '#ab3b48',
    '#e0afa3',
    '#bf4c59',
    '#bf4c59',
    '#e0afa3',
    '#ab3b48',
    '#ae4654',
    '#a33d4a',
    '#b14552',
    '#b74957'
  ],
  [
    '#b64856',
    '#ba4d58',
    '#8f554e',
    '#fcebdd',
    '#fcebdd',
    '#fcecde',
    '#fdebde',
    '#fdebde',
    '#fcecde',
    '#fcebdd',
    '#fcebdd',
    '#8f554e',
    '#ba4d58',
    '#b64856'
  ],
  [
    '#b64956',
    '#b44b56',
    '#4e2a15',
    '#45210e',
    '#42200e',
    '#975d52',
    '#fceadc',
    '#fceadc',
    '#975d52',
    '#42200e',
    '#45210e',
    '#4e2a15',
    '#b44b56',
    '#b64956'
  ],
  [
    '#b74b58',
    '#b54b56',
    '#814d43',
    '#fefbfc',
    '#f8c819',
    '#fdf7f0',
    '#fdeadd',
    '#fdeadd',
    '#fdf7f0',
    '#f8c819',
    '#fefbfc',
    '#814d43',
    '#b54b56',
    '#b74b58'
  ],
  [
    '#b54b56',
    '#b14953',
    '#b74b58',
    '#fceade',
    '#fde9d7',
    '#fceadd',
    '#fceadc',
    '#fceadc',
    '#fceadd',
    '#fde9d7',
    '#fceade',
    '#b74b58',
    '#b14953',
    '#b54b56'
  ],
  [
    null,
    '#a7424f',
    '#a4424e',
    '#fbeadd',
    '#fbebdd',
    '#fdebdd',
    '#af6f6a',
    '#af6f6a',
    '#fdebdd',
    '#fbebdd',
    '#fbeadd',
    '#a4424e',
    '#a7424f',
    null
  ],
  [null, '#a7414d', null, '#834e66', '#f8ded4', '#f9e4d9', '#ecc7ba', '#ecc7ba', '#f9e4d9', '#f8ded4', '#834e66', null, '#a7414d', null],
  [null, '#b34858', null, null, '#bcbab4', '#f6f2e8', '#f7f3eb', '#f7f3eb', '#f6f2e8', '#bcbab4', null, null, '#b34858', null],
  [null, '#9b4d62', null, '#969394', '#f8f3ea', '#bbb9b2', '#3e393b', '#3e393b', '#bbb9b2', '#f8f3ea', '#969394', null, '#9b4d62', null]
]

const PIXEL_LOGO_WIDTH = 28

function MakimaPixelLogo() {
  return (
    <Box flexDirection="column" height={MAKIMA_PIXEL_ART.length} opaque width={PIXEL_LOGO_WIDTH}>
      {MAKIMA_PIXEL_ART.map((row, y) => (
        <Box flexDirection="row" height={1} key={y}>
          {row.map((color, x) => (
            <Text backgroundColor={color ?? undefined} key={x}>
              {'  '}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// Custom Banner: full art → compact rule → text → hidden.
//
// Terminals can't scale glyphs, so "responsive" means picking a layout that
// fits the available columns. Thresholds are picked so each tier reads
// comfortably without forcing wrap or truncation drift on box-drawing edges.
const TAG_FULL = 'Claude Code style TUI for Deepseek-Harness'
const TAG_MID = 'Claude Code style TUI'
const TAG_TINY = 'makima tui'
const HIDE_BELOW = 34
const COMPACT_FROM = 58

const clip = (s: string, w: number) => (w <= 0 ? '' : s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s)

const centerIn = (s: string, w: number) => {
  const f = clip(s, w)
  const slack = Math.max(0, w - f.length)
  const left = slack >> 1

  return `${' '.repeat(left)}${f}${' '.repeat(slack - left)}`
}

const ruleIn = (label: string, w: number) => {
  const f = clip(label, Math.max(1, w - 4))
  const slack = Math.max(0, w - f.length - 2)
  const left = slack >> 1

  return `${'─'.repeat(left)} ${f} ${'─'.repeat(slack - left)}`
}

function CompactBanner({ cols, t }: { cols: number; t: Theme }) {
  // -4 keeps a margin so exact-edge rows don't trip terminal pending-wrap.
  const w = Math.max(28, cols - 4)

  return (
    <Box flexDirection="column" height={3} marginBottom={1} opaque width={w}>
      <Text bold color={t.color.primary}>
        {ruleIn(t.brand.name, w)}
      </Text>
      <Text color={t.color.muted}>{centerIn(TAG_FULL, w)}</Text>
      <Text color={t.color.primary}>{'─'.repeat(w)}</Text>
    </Box>
  )
}

export function Banner({ logoPalette, maxWidth, t }: { logoPalette?: string; maxWidth?: number; t: Theme }) {
  const term = useStdout().stdout?.columns ?? 80
  const cols = Math.max(1, Math.min(term, maxWidth ?? term))

  if (cols < HIDE_BELOW) {
    return null
  }

  // The default portrait belongs to the session card, alongside the session it
  // identifies. Keep this banner for an explicitly configured replacement only.
  if (!t.bannerLogo) {
    return null
  }

  const logoLines = logo(t.color, t.bannerLogo, logoPalette)
  const logoW = artWidth(logoLines)

  if (cols >= logoW + 2) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <ArtLines lines={logoLines} />
        <Text color={t.color.muted} wrap="truncate-end">
          {t.brand.icon} {TAG_FULL}
        </Text>
      </Box>
    )
  }

  if (cols >= COMPACT_FROM) {
    return <CompactBanner cols={cols} t={t} />
  }

  const name = cols >= 52 ? t.brand.name : (t.brand.name.split(' ')[0] ?? t.brand.name)
  const tag = cols >= 64 ? TAG_FULL : cols >= 46 ? TAG_MID : TAG_TINY

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={t.color.primary} wrap="truncate-end">
        {t.brand.icon} {name}
      </Text>
      <Text color={t.color.muted} wrap="truncate-end">
        {t.brand.icon} {tag}
      </Text>
    </Box>
  )
}

// ── Collapsible helpers ──────────────────────────────────────────────

function CollapseToggle({
  count,
  open,
  suffix,
  t,
  title,
  onToggle
}: {
  count?: number
  open: boolean
  suffix?: string
  t: Theme
  title: string
  onToggle: () => void
}) {
  // One <Text> run, not sibling <Text>es in a flex row: as siblings, a toggle
  // wider than its column makes flexbox wrap each span into its own column
  // ("▸Available  (8) in 2" / " Skills      categories") instead of truncating
  // the line. Nesting keeps it a single run that truncates cleanly.
  return (
    <Box onClick={onToggle}>
      <Text wrap="truncate-end">
        <Text color={t.color.accent}>{open ? '▾ ' : '▸ '}</Text>
        <Text bold color={t.color.accent}>
          {title}
        </Text>
        {typeof count === 'number' ? <Text color={t.color.muted}> ({count})</Text> : null}
        {suffix ? <Text color={t.color.muted}> {suffix}</Text> : null}
      </Text>
    </Box>
  )
}

// ── Header layout allocation ─────────────────────────────────────────
//
// Ported from the reference banner's allocation math
// (`calculateOptimalLeftWidth` / `calculateLayoutDimensions` in
// typescript/src/utils/logoV2Utils.ts).
//
// The point is that the left column is sized to *its own content* and the
// remainder is handed to the right column, with the divider and padding booked
// explicitly. The previous code sized the left column as
// `min(mascotWidth + 4, cols * 0.4)`, which never looked at the cwd or model
// lines: at 140 columns that pinned it to 20, truncating the cwd to
// `/Users/ericlee2/wor…` while ~65 columns sat empty to the right.

const MAX_LEFT_WIDTH = 50
/** Floor so a short cwd still leaves the mascot room to breathe. */
const MIN_LEFT_CONTENT = 20
/** The box's own chrome: `borderStyle` (1 each side) + `paddingX={1}`. */
const BORDER_PADDING = 4
/** The divider's `marginX={1}`, both sides. Must track the JSX below. */
const DIVIDER_MARGIN = 2
/** The divider's own border glyph. Must track the JSX below. */
const DIVIDER_WIDTH = 1
/** A space either side of the left column's text so it doesn't touch the rule. */
const LEFT_COLUMN_SLACK = 2
// The reference floors the feed column at 30, but its feed titles are short;
// clawcodex's longest toggle ("▸ Available Skills (8) in 2 categories") is 38.
// Below this the split earns nothing, so the layout stacks instead.
const MIN_RIGHT_WIDTH = 36
/** Below this the columns stack — the divider costs more width than it earns. */
const HORIZONTAL_FROM = 70
const MAX_USERNAME_LENGTH = 20
// Row labels. Kept as constants because the width budgets are measured off them.
const MODEL_LABEL = 'Model '
const PATH_LABEL = 'Path '
const PERMS_LABEL = 'Perms '
/** Names the command that changes it — the row doubles as discoverability. */
const PERMS_HINT = ' · /permissions'
/** Columns between the top-left corner and the title. */
const TITLE_OFFSET = 3

/** Widest title variant that `borderText` can render, or null if none fits.
 *
 *  This guard is not cosmetic. Once the title reaches `cols - 2` ink stops
 *  embedding it and returns `['', text.substring(0, cols), '']`
 *  (render-border.ts:43-44) — corners and rule gone, and the slice is by code unit
 *  across a pre-rendered ANSI string. The result is a box with no top edge at
 *  all. `t.brand.name` is operator-configurable, so a branded install hits this
 *  at ordinary narrow-pane widths, not just tiny ones. Degrade instead:
 *  name + version → name → nothing. */
export function borderTitleParts(cols: number, name: string, version?: string): { name: string; version?: string } | null {
  // Keeps ink's `position` clamp (render-border.ts:59) from moving the title.
  const room = cols - TITLE_OFFSET - 2
  const width = (v?: string) => stringWidth(` ${name}${v ? ` v${v}` : ''} `)

  if (version && width(version) <= room) {
    return { name, version }
  }

  return width() <= room ? { name } : null
}

/** Split into columns only when the terminal clears the coarse threshold AND
 *  both columns fit at usable widths.
 *
 *  The fit check is not redundant with the threshold: the left column is sized
 *  to the cwd, so a deep path can want 50 columns at a terminal width of 72.
 *  Forcing the split there overflows the box, and flexbox resolves the overflow
 *  by shrinking *both* children — which wraps the collapse toggles into
 *  unreadable two-word columns ("▸Available  (8 in 2" / " Skills  categories").
 *  Stacking is the better failure mode. */
export function fitsHorizontal(columns: number, leftWidth: number): boolean {
  const needed = leftWidth + BORDER_PADDING + DIVIDER_MARGIN + DIVIDER_WIDTH + MIN_RIGHT_WIDTH

  return columns >= HORIZONTAL_FROM && needed <= columns
}

/** Left column width: its widest line, floored at the mascot, capped so a deep
 *  cwd can never starve the feed column. */
export function optimalLeftWidth(lines: string[], heroWidth: number): number {
  const content = Math.max(...lines.map(stringWidth), heroWidth, MIN_LEFT_CONTENT)

  return Math.min(content + 4, MAX_LEFT_WIDTH)
}

/** Whatever the left column and chrome don't use goes to the feed column. */
export function rightColumnWidth(columns: number, leftWidth: number): number {
  const used = BORDER_PADDING + DIVIDER_MARGIN + DIVIDER_WIDTH + leftWidth

  return Math.max(MIN_RIGHT_WIDTH, columns - used)
}

/** Grapheme clusters of `s`, longest tail fitting in `maxWidth` *columns*.
 *
 *  Every part of that sentence is load-bearing:
 *
 *  - *columns*, not code units. Slicing by `.length` overshoots on a CJK cwd
 *    ("目" is 1 unit, 2 columns) and returns a string wider than the budget,
 *    which then re-truncates at the far end and elides BOTH sides — destroying
 *    the trailing segment this whole function exists to preserve.
 *  - *grapheme clusters*, not code points. Measuring per code point undercounts
 *    a keycap sequence (`1️⃣` = digit + VS16 + U+20E3 sums to 1, but the cluster
 *    is 2 columns wide), which overflows again; and it splits regional-indicator
 *    flags into reversed letter pairs. `Intl.Segmenter` is what `stringWidth`
 *    itself segments with, so this measures the way the renderer measures.
 *  - Code points at minimum, never code units: an arbitrary code-unit offset
 *    leaves a lone surrogate that renders as U+FFFD but measures as zero. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function clipTailToWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ''
  }

  const clusters = [...GRAPHEMES.segment(s)].map((g) => g.segment)
  let out = ''
  let width = 0

  for (let i = clusters.length - 1; i >= 0; i--) {
    const ch = clusters[i]!
    const chWidth = stringWidth(ch)

    if (width + chWidth > maxWidth) {
      break
    }

    out = ch + out
    width += chWidth
  }

  return out
}

/** Middle-truncate a path so the *current* directory stays readable.
 *
 *  Plain `wrap="truncate-end"` clips the tail, which is the one segment that
 *  matters: `/Users/me/workspace/clawcodex/ui-tui/src/comp…` tells you less
 *  than `…/ui-tui/src/components`. Mirrors the reference's `truncatePath`
 *  (logoV2Utils.ts), keeping as many trailing segments as fit. */
export function truncatePath(path: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ''
  }

  if (stringWidth(path) <= maxWidth) {
    return path
  }

  const parts = path.split('/')
  const last = parts[parts.length - 1] ?? ''

  // Even one segment behind the ellipsis doesn't fit — clip the tail itself.
  if (stringWidth(`…/${last}`) > maxWidth) {
    return `…${clipTailToWidth(last, maxWidth - 1)}`
  }

  // Grow backwards from the tail while whole segments still fit.
  let kept = last

  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${parts[i]}/${kept}`

    if (stringWidth(`…/${next}`) > maxWidth) {
      break
    }

    kept = next
  }

  return `…/${kept}`
}

/** Mirrors the reference's `formatWelcomeMessage`: an absurdly long name is
 *  treated as no name at all rather than blowing out the left column. */
export function welcomeMessage(username: string | null | undefined, brand: string): string {
  return !username || username.length > MAX_USERNAME_LENGTH ? `Welcome to ${brand}` : `Welcome back, ${username}`
}

/** `os.userInfo()` throws when the uid has no passwd entry (some containers). */
function currentUsername(): string | null {
  try {
    return userInfo().username || null
  } catch {
    return null
  }
}

// ── SessionPanel ─────────────────────────────────────────────────────

const SKILLS_MAX = 8
const TOOLSETS_MAX = 8

export function SessionPanel({ info, logoPalette, maxWidth, sid, t }: SessionPanelProps) {
  const term = useStdout().stdout?.columns ?? 100
  const cols = Math.max(20, Math.min(term, maxWidth ?? term))
  // The portrait is the sole session identity artwork. It occupies the left
  // column only when that column fits beside the capability feed; stacked cards
  // keep the session data compact instead of pushing the card below the viewport.
  const portraitWidth = PIXEL_LOGO_WIDTH

  // Left-column lines, built before layout so the column can be sized to them.
  // The cwd is pre-truncated to the column's hard cap: sizing the column to an
  // arbitrarily deep path first and clipping after would let one long path
  // dictate the whole split.
  const welcome = welcomeMessage(currentUsername(), t.brand.name)
  const modelLine = `${info.model.split('/').pop()}${info.profile_name ? ` · ${info.profile_name}` : ''}`
  const rawCwd = info.cwd || process.cwd()
  const cwdLine = truncatePath(rawCwd, MAX_LEFT_WIDTH - LEFT_COLUMN_SLACK - PATH_LABEL.length)

  // Off-ladder modes (plan/dontAsk/auto) have no level, so they render under
  // their raw name rather than being mislabeled as one of the three — but they
  // still render. Omitting them hid the case that matters most: a repository
  // settings file may force `dontAsk`, which DENIES everything that would
  // prompt, and the composer badge (the only other indicator) hides while the
  // user types. A user whose agent silently refuses every action needs
  // something on screen to trace it to.
  const startLevel = levelForMode(info.permission_mode)
  const permsLabel = startLevel?.label ?? info.permission_mode ?? ''
  const permsLine = permsLabel ? `${PERMS_LABEL}${permsLabel}${PERMS_HINT}` : ''

  const identityLines = [welcome, `${MODEL_LABEL}${modelLine}`, `${PATH_LABEL}${cwdLine}`, permsLine]
  const portraitLeftWidth = optimalLeftWidth(identityLines, portraitWidth)
  const showPixelLogo = fitsHorizontal(cols, portraitLeftWidth)
  const leftW = showPixelLogo ? portraitLeftWidth : optimalLeftWidth(identityLines, 0)
  const wide = showPixelLogo
  // Stacked: the column IS the interior (border + paddingX = BORDER_PADDING).
  // Flooring this at MIN_RIGHT_WIDTH would overflow a narrow box — that floor
  // gates whether to split at all, it is not a width to render at.
  const w = wide ? rightColumnWidth(cols, leftW) : Math.max(10, cols - BORDER_PADDING)
  // Stacked layout spans `w`, which can be narrower than the left column's cap.
  const shownCwd = wide ? cwdLine : truncatePath(rawCwd, Math.max(10, w - PATH_LABEL.length))
  const lineBudget = Math.max(12, w - 2)
  const strip = (s: string) => (s.endsWith('_tools') ? s.slice(0, -6) : s)

  // Pre-rendered ANSI: `borderText` writes straight into the border run, so it
  // can't take <Text> children. applyColor is the fork's own colorizer, which
  // keeps the 8-bit downgrade for legacy Apple Terminal that a hand-rolled
  // truecolor escape would bypass.
  //
  // The cast is real, not cosmetic: theme colors are typed `string` but
  // applyColor wants the `Color` union, which the ink entry does not export.
  // Runtime is safe either way — colorize() returns the text unstyled for any
  // format it doesn't recognize, so a bad skin color degrades to plain text.
  const tint = (s: string, color: string) => applyColor(s, color as Parameters<typeof applyColor>[1])
  const titleParts = borderTitleParts(cols, t.brand.name, info.version)

  const borderTitle = titleParts
    ? ` ${tint(titleParts.name, t.color.text)}${titleParts.version ? ` ${tint(`v${titleParts.version}`, t.color.muted)}` : ''} `
    : null

  // ── Local collapse state for each section ──
  // Keep the raw inventory available on demand. The landing view should lead
  // with an operational summary rather than a single, terminal-wide tool list.
  const [toolsOpen, setToolsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [systemOpen, setSystemOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)

  // --worktree session (env-advertised by the launcher) — shown under cwd so
  // parallel sessions are visually distinguishable at a glance.
  const worktree = getWorktreeSession()

  const truncLine = (pfx: string, items: string[]) => {
    let line = ''
    let shown = 0

    for (const item of [...items].sort()) {
      const next = line ? `${line}, ${item}` : item

      if (pfx.length + next.length > lineBudget) {
        return line ? `${line}, …+${items.length - shown}` : `${item}, …`
      }

      line = next
      shown++
    }

    return line
  }

  // ── Collapsible skills section ──
  const skillEntries = Object.entries(info.skills).sort()
  const skillsTotal = flat(info.skills).length
  const skillsCatCount = skillEntries.length

  const skillsBody = () => {
    if (info.lazy && skillEntries.length === 0) {
      return <InlineLoader label="scanning skills" t={t} />
    }

    const shown = skillEntries.slice(0, SKILLS_MAX)
    const overflow = skillEntries.length - SKILLS_MAX

    return (
      <>
        {shown.map(([k, vs]) => (
          <Text key={k} wrap="truncate">
            <Text color={t.color.muted}>{strip(k)}: </Text>
            <Text color={t.color.text}>{truncLine(strip(k) + ': ', vs)}</Text>
          </Text>
        ))}
        {overflow > 0 && <Text color={t.color.muted}>(and {overflow} more categories…)</Text>}
      </>
    )
  }

  // ── Collapsible tools section ──
  const toolEntries = Object.entries(info.tools).sort()
  const toolsTotal = flat(info.tools).length

  // MCP headline counts *connected* servers, not configured-but-disabled ones,
  // so it matches the classic CLI banner (`sum(s.connected)` in
  // clawcodex_cli/banner.py) and the "connected" label on the collapse toggle.
  const mcpServers = info.mcp_servers ?? []
  const mcpConnected = mcpServers.filter((s) => s.connected).length

  const toolsBody = () => {
    const shown = toolEntries.slice(0, TOOLSETS_MAX)
    const overflow = toolEntries.length - TOOLSETS_MAX

    return (
      <>
        {shown.map(([k, vs]) => (
          <Text key={k} wrap="truncate">
            <Text color={t.color.muted}>{strip(k)}: </Text>
            <Text color={t.color.text}>{truncLine(strip(k) + ': ', vs)}</Text>
          </Text>
        ))}
        {overflow > 0 && <Text color={t.color.muted}>(and {overflow} more toolsets…)</Text>}
      </>
    )
  }

  // ── Collapsible MCP section ──
  const mcpBody = () => (
    <>
      {(info.mcp_servers ?? []).map((s) => (
        <Text key={s.name} wrap="truncate">
          <Text color={t.color.muted}>{`  ${s.name} `}</Text>
          <Text color={t.color.muted}>{`[${s.transport}]`}</Text>
          <Text color={t.color.muted}>: </Text>
          {s.connected ? (
            <Text color={t.color.text}>
              {s.tools} tool{s.tools === 1 ? '' : 's'}
            </Text>
          ) : s.disabled || s.status === 'disabled' ? (
            <Text color={t.color.muted}>disabled</Text>
          ) : s.status === 'connecting' ? (
            <Text color={t.color.warn}>connecting</Text>
          ) : s.status === 'configured' ? (
            <Text color={t.color.muted}>configured</Text>
          ) : (
            <Text color={t.color.error}>failed</Text>
          )}
        </Text>
      ))}
    </>
  )

  // ── Session overview ────────────────────────────────────────────────
  // The portrait deliberately gives the left rail presence. Mirror that weight
  // on wide terminals with a compact command-center: useful runtime facts first,
  // then a small operating guide — never decorative filler.
  const permissionState = permsLabel || 'Default'
  const permissionTone = info.permission_mode === 'bypassPermissions' || info.permission_mode === 'dontAsk' ? t.color.error : t.color.accent
  const modelMode = [
    info.reasoning_effort ? `${info.reasoning_effort} reasoning` : 'standard reasoning',
    info.fast ? 'fast lane' : '',
    info.nano ? 'nano' : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const contextPercent = info.usage?.context_percent
  const contextLabel = contextPercent === undefined ? 'fresh context' : `${contextPercent}% context used`
  const connectionLabel = mcpServers.length > 0 ? `${mcpConnected}/${mcpServers.length} MCP connected` : 'local runtime'

  const overview = (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text wrap="truncate-end">
          <Text bold color={t.color.primary}>
            SESSION READY
          </Text>
          <Text color={t.color.muted}> · workspace initialized</Text>
        </Text>
        <Text color={t.color.ok} wrap="truncate-end">
          ● ONLINE
        </Text>
      </Box>
      <Text color={t.color.muted} wrap="truncate-end">
        {modelLine} <Text color={t.color.frame}>│</Text> {modelMode}
      </Text>

      <Box
        borderBottom={false}
        borderColor={t.color.frame}
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderTop
        marginY={1}
      />

      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" flexGrow={1} flexShrink={1} width="50%">
          <Text color={t.color.muted}>RUNTIME</Text>
          <Text wrap="truncate-end">
            <Text bold color={t.color.accent}>
              {toolsTotal}
            </Text>
            <Text color={t.color.muted}> tools · </Text>
            <Text bold color={t.color.accent}>
              {skillsTotal}
            </Text>
            <Text color={t.color.muted}> skills</Text>
          </Text>
          <Text color={t.color.muted} wrap="truncate-end">
            {connectionLabel}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingLeft={2} width="50%">
          <Text color={t.color.muted}>SESSION POSTURE</Text>
          <Text wrap="truncate-end">
            <Text color={permissionTone}>{permissionState}</Text>
            <Text color={t.color.muted}> access</Text>
          </Text>
          <Text color={contextPercent !== undefined && contextPercent >= 80 ? t.color.warn : t.color.muted} wrap="truncate-end">
            {contextLabel}
          </Text>
        </Box>
      </Box>

      <Box
        borderBottom={false}
        borderColor={t.color.frame}
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderTop
        marginY={1}
      />

      <Text wrap="truncate-end">
        <Text bold color={t.color.accent}>
          COMMAND DECK{' '}
        </Text>
        <Text color={t.color.command}>/model</Text>
        <Text color={t.color.muted}> tune model </Text>
        <Text color={t.color.command}>/permissions</Text>
        <Text color={t.color.muted}> access </Text>
        <Text color={t.color.command}>/sessions</Text>
        <Text color={t.color.muted}> switch</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={t.color.ok}>● READY</Text>
        <Text color={t.color.muted}> · paste text, files, or screenshots · </Text>
        <Text color={t.color.command}>/help</Text>
        <Text color={t.color.muted}> for the full command index</Text>
      </Text>
    </Box>
  )

  // ── System prompt body ──
  const sysPromptLen = (info.system_prompt ?? '').length

  const systemBody = () => {
    if (sysPromptLen === 0) {
      return <Text color={t.color.muted}>No system prompt loaded.</Text>
    }

    return <Text color={t.color.muted}>{info.system_prompt}</Text>
  }

  const sections: { key: string; node: React.ReactNode }[] = [
    {
      key: 'tools',
      node: (
        <>
          <CollapseToggle onToggle={() => setToolsOpen((v) => !v)} open={toolsOpen} t={t} title="Available Tools" />
          {toolsOpen && toolsBody()}
        </>
      )
    },
    {
      key: 'skills',
      node: (
        <>
          <CollapseToggle
            count={skillsTotal}
            onToggle={() => setSkillsOpen((v) => !v)}
            open={skillsOpen}
            suffix={skillsCatCount > 0 ? `in ${skillsCatCount} categor${skillsCatCount === 1 ? 'y' : 'ies'}` : undefined}
            t={t}
            title="Available Skills"
          />
          {skillsOpen && skillsBody()}
        </>
      )
    },
    ...(sysPromptLen > 0
      ? [
          {
            key: 'system',
            node: (
              <>
                <CollapseToggle
                  onToggle={() => setSystemOpen((v) => !v)}
                  open={systemOpen}
                  suffix={`— ${sysPromptLen.toLocaleString()} chars`}
                  t={t}
                  title="System Prompt"
                />
                {systemOpen && systemBody()}
              </>
            )
          }
        ]
      : []),
    ...(mcpServers.length > 0
      ? [
          {
            key: 'mcp',
            node: (
              <>
                <CollapseToggle
                  count={mcpConnected}
                  onToggle={() => setMcpOpen((v) => !v)}
                  open={mcpOpen}
                  suffix="connected"
                  t={t}
                  title="MCP Servers"
                />
                {mcpOpen && mcpBody()}
              </>
            )
          }
        ]
      : [])
  ]

  // Keep the portrait and session details in one deliberate vertical unit. The
  // same unit is used in both layouts: narrow cards lose artwork first, never
  // session information or the card's visual rhythm.
  const identityWidth = wide ? leftW : w
  const identity = (
    <Box flexDirection="column" width={identityWidth}>
      {showPixelLogo && (
        <Box alignItems="center" flexDirection="column" marginBottom={1} width="100%">
          <MakimaPixelLogo />
        </Box>
      )}

      <Text bold color={t.color.text} wrap="truncate-end">
        {welcome}
      </Text>

      <Box
        borderBottom
        borderColor={t.color.border}
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderTop={false}
        marginY={1}
      />

      <Text wrap="truncate-end">
        <Text color={t.color.muted}>{MODEL_LABEL}</Text>
        <Text color={t.color.accent}>{modelLine}</Text>
      </Text>

      <Text wrap="truncate-end">
        <Text color={t.color.muted}>{PATH_LABEL}</Text>
        <Text color={t.color.muted}>{shownCwd}</Text>
      </Text>

      {/* Launch-time permission level. Worth a row of its own because full
          access is the default: the composer badge is the LIVE indicator but
          hides while the user types (composerFooter suppressHint), so this
          states it once, unmissably, and names the command that changes it.
          Like Model above, this is a committed transcript row the renderer
          never re-emits — it describes the session's STARTING state and does
          not follow a later /permissions change; the badge is what tracks
          "right now". */}
      {permsLabel && (
        <Text wrap="truncate-end">
          <Text color={t.color.muted}>{PERMS_LABEL}</Text>
          <Text color={info.permission_mode === 'bypassPermissions' || info.permission_mode === 'dontAsk' ? t.color.error : t.color.accent}>
            {permsLabel}
          </Text>
          <Text color={t.color.muted}>{PERMS_HINT}</Text>
        </Text>
      )}

      {worktree && (
        <Text wrap="truncate-end">
          <Text color={t.color.muted}>Tree</Text>
          <Text color={t.color.accent}> {worktree.name}</Text>
          <Text color={t.color.muted}> · {worktree.branch}</Text>
        </Text>
      )}

      {sid && (
        <Text wrap="truncate-end">
          <Text color={t.color.sessionLabel}>Session</Text>
          <Text color={t.color.sessionBorder}> {sid}</Text>
        </Text>
      )}
    </Box>
  )

  return (
    <Box
      borderColor={t.color.border}
      borderStyle="round"
      borderText={borderTitle ? { align: 'start', content: borderTitle, offset: TITLE_OFFSET, position: 'top' } : undefined}
      marginBottom={1}
      paddingX={1}
      paddingY={1}
      // Explicit width, deliberately — do NOT let this box size to its
      // container.
      //
      // On the FIRST paint the transcript's ScrollBox has not settled: it
      // reports its full width, without the scrollbar gutter its steady-state
      // layout reserves. A container-sized box therefore renders two columns
      // wider than the terminal can show and its right border is clipped off
      // screen, staying that way because the intro row is committed to
      // scrollback and never repainted — until a resize forces a relayout, at
      // which point the border appears. That is exactly the "I have to resize
      // to see the border" symptom.
      //
      // `cols` does not have that problem: it comes from `maxWidth`
      // (transcriptPanelWidth) and process.stdout.columns, both correct on the
      // first frame. Measured on a real pty: cols=196 on frame 1 at a 200-col
      // terminal, while the container claimed 198.
      width={cols}
    >
      {wide && (
        <Box flexDirection="column" width={leftW}>
          {identity}
        </Box>
      )}

      {/* Column rule. A left-only border stretches to the taller column, so the
          rule always spans the full content height without being measured. */}
      {wide && (
        <Box
          borderBottom={false}
          borderColor={t.color.border}
          borderLeft
          borderRight={false}
          borderStyle="single"
          borderTop={false}
          marginX={1}
        />
      )}

      {/* flexGrow so the feed column absorbs the container's *actual* remainder
          rather than the `w` we predicted; `w` stays the flex basis and the
          truncation budget. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} width={w}>
        {/* Narrow layout drops the column split; keep the identity block above
            the feed so nothing is lost. */}
        {!wide && (
          <Box flexDirection="column" marginBottom={1}>
            {identity}
          </Box>
        )}

        {overview}

        {/* Built as a list so a hidden section takes its spacing with it — an
            inline `&&` leaves a dangling gap. The first section sits flush with
            the top of the column so both columns start on the same row.
            Sections are spaced, not ruled: the reference draws one rule between
            two multi-line feeds, and clawcodex's mostly-collapsed toggles would
            turn a rule-per-section into four rules of noise. The single rule
            below separates the index from the totals footer. */}
        {sections.map((section, i) => (
          <Box flexDirection="column" key={section.key} marginTop={i > 0 ? 1 : 0}>
            {section.node}
          </Box>
        ))}

        {/* A top-border-only box, not `'─'.repeat(w)`: the column can flex away
            from `w`, and a repeat-count rule would then under- or overshoot its
            own column. A border stretches to whatever width the column got. */}
        <Box
          borderBottom={false}
          borderColor={t.color.border}
          borderLeft={false}
          borderRight={false}
          borderStyle="single"
          borderTop
          marginTop={1}
        />

        <Text color={t.color.text}>
          {toolsTotal} tools{' · '}
          {skillsTotal} skills
          {mcpConnected ? ` · ${mcpConnected} MCP` : ''}
          {' · '}
          <Text color={t.color.muted}>/help for commands</Text>
        </Text>

        {typeof info.update_behind === 'number' && info.update_behind > 0 && (
          <Text bold color={t.color.warn}>
            ! {info.update_behind} {info.update_behind === 1 ? 'commit' : 'commits'} behind
            <Text bold={false} color={t.color.warn} dimColor>
              {' '}
              - run{' '}
            </Text>
            <Text bold color={t.color.warn}>
              {info.update_command || 'git pull && ./install.sh'}
            </Text>
            <Text bold={false} color={t.color.warn} dimColor>
              {' '}
              to update
            </Text>
          </Text>
        )}
      </Box>
    </Box>
  )
}

export function Panel({ sections, t, title }: PanelProps) {
  return (
    <Box borderColor={t.color.border} borderStyle="round" flexDirection="column" paddingX={2} paddingY={1} width="100%">
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={t.color.primary}>
          {title}
        </Text>
      </Box>

      {sections.map((sec, si) => (
        <Box flexDirection="column" key={si} marginTop={si > 0 ? 1 : 0}>
          {sec.title && (
            <Text bold color={t.color.accent}>
              {sec.title}
            </Text>
          )}

          {sec.rows?.map(([k, v], ri) => (
            <Box flexDirection="row" key={ri} width="100%">
              <Text color={t.color.muted} flexShrink={0} wrap="truncate-end" width={20}>
                {k}
              </Text>
              <Text color={t.color.text} flexGrow={1} flexShrink={1} wrap="truncate-end">
                {v}
              </Text>
            </Box>
          ))}

          {sec.items?.map((item, ii) => (
            <Text color={t.color.text} key={ii} width="100%" wrap="truncate-end">
              {item}
            </Text>
          ))}

          {sec.text && <Text color={t.color.muted}>{sec.text}</Text>}
        </Box>
      ))}
    </Box>
  )
}

interface PanelProps {
  sections: PanelSection[]
  t: Theme
  title: string
}

interface SessionPanelProps {
  info: SessionInfo
  logoPalette?: string
  maxWidth?: number
  sid?: string | null
  t: Theme
}
