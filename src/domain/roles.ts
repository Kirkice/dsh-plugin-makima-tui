import type { Theme } from '../theme.js'
import type { Role } from '../types.js'

// Transcript glyphs/colors: use text symbols rather than emoji-prone glyphs so
// Windows terminals cannot substitute colored emoji for tool status markers.
// Assistant prose stays neutral and high-contrast; user-authored text uses the
// warm command tone so alternating turns remain legible in dense transcripts.
export const ROLE: Record<Role, (t: Theme) => { body: string; glyph: string; prefix: string }> = {
  assistant: t => ({ body: t.color.text, glyph: '›', prefix: t.color.highlight }),
  system: t => ({ body: '', glyph: '·', prefix: t.color.muted }),
  tool: t => ({ body: t.color.muted, glyph: '›', prefix: t.color.ok }),
  user: t => ({ body: t.color.user, glyph: '❯', prefix: t.color.user })
}
