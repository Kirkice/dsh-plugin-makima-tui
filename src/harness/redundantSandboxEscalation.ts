import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * Tool names whose upstream implementations understand sandbox escalation
 * arguments. Read-only tools deliberately do not participate.
 */
export const SANDBOX_ESCALATION_TOOL_NAMES = ['bash', 'pwsh', 'write', 'edit'] as const

type SandboxEscalationToolName = (typeof SANDBOX_ESCALATION_TOOL_NAMES)[number]
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

type SandboxSession = {
  events?: readonly unknown[]
}

type SandboxAgent = {
  session?: SandboxSession
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Resolve the durable session policy rather than trusting the TUI display mode.
 * This also handles sessions opened while the host itself defaults to Full
 * Access, before that session has emitted an explicit `sandbox/mode` event.
 */
export const effectiveSandboxMode = (agent: SandboxAgent | undefined): SandboxMode => {
  const events = agent?.session?.events ?? []

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]

    if (!isRecord(event) || event.type !== 'sandbox/mode' || !isRecord(event.data)) continue

    const mode = event.data.mode

    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return mode
  }

  return process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'
}

/**
 * Full Access is already the widest policy, so an identical model-supplied
 * escalation is not an escalation at all. Upstream tools intentionally reject
 * it because their generic validator only accepts strict widening. Remove the
 * complete escalation pair before delegating, while leaving genuine upgrades
 * and malformed requests untouched for the upstream validator to handle.
 */
export const normalizeRedundantFullAccessEscalation = (args: unknown, mode: SandboxMode): unknown => {
  if (!isRecord(args) || mode !== 'danger-full-access' || args.sandbox_permissions !== 'danger-full-access') return args

  const { justification: _justification, sandbox_permissions: _sandboxPermissions, ...normalized } = args

  return normalized
}

export type SandboxModeResolver = (exec: ToolRunContext) => SandboxMode

/** Preserve an upstream tool's schema, output and presentation contract while
 * changing only the arguments supplied to its execution body. */
export const wrapSandboxEscalationTool = (definition: ToolDefinition, resolveMode: SandboxModeResolver = (exec) => effectiveSandboxMode(exec.agent)): ToolDefinition => ({
  ...definition,
  execute: (args: unknown, exec: ToolRunContext) => definition.execute(normalizeRedundantFullAccessEscalation(args, resolveMode(exec)), exec)
})

export const isSandboxEscalationToolName = (name: string): name is SandboxEscalationToolName =>
  (SANDBOX_ESCALATION_TOOL_NAMES as readonly string[]).includes(name)
