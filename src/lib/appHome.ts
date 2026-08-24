/**
 * The application's own data directory.
 *
 * The ported sources kept clawcodex's `~/.clawcodex` home, which made this TUI
 * read *and write* another product's data: prompt history, lifecycle logs, and
 * the `/logo` preference all landed there, and a clawcodex `logoColor` silently
 * overrode this app's default banner palette. makima tui owns `~/.makima-tui`
 * instead; clawcodex's directory is left untouched (no migration — inheriting
 * another app's UI preferences is the bug, not the feature).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_DIR_NAME = '.makima-tui'

/** Absolute path of the app data directory; `MAKIMA_TUI_HOME` overrides it. */
export const appHome = (): string => process.env.MAKIMA_TUI_HOME?.trim() || join(homedir(), APP_DIR_NAME)

/** A path inside the app data directory. */
export const appHomePath = (...parts: string[]): string => join(appHome(), ...parts)
