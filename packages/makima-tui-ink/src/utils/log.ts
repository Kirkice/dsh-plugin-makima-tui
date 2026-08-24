export function logError(error: unknown): void {
  if (!process.env.MAKIMA_TUI_INK_DEBUG_ERRORS) {
    return
  }

  console.error(error)
}
