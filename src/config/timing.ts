// Keep live text below terminal refresh frequency. A 32ms window caps expensive
// React/Yoga/markdown work at roughly 30 FPS while remaining visually immediate.
export const STREAM_BATCH_MS = 32
export const STREAM_IDLE_BATCH_MS = 32
export const STREAM_SCROLL_BATCH_MS = 96
export const STREAM_TYPING_BATCH_MS = 80
export const TYPING_IDLE_MS = 250
export const REASONING_PULSE_MS = 700
