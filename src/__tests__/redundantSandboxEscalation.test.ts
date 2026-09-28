import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  effectiveSandboxMode,
  normalizeRedundantFullAccessEscalation,
  SANDBOX_ESCALATION_TOOL_NAMES,
  wrapSandboxEscalationTool
} from '../harness/redundantSandboxEscalation.js'

describe('redundant Full Access sandbox escalation compatibility', () => {
  it.each([
    ['pwsh', { command: 'Write-Output hello' }],
    ['write', { content: 'hello', file_path: 'notes.txt' }],
    ['edit', { file_path: 'notes.txt', new_string: 'new', old_string: 'old' }]
  ])('removes the complete redundant escalation pair for %s arguments', (_toolName, operation) => {
    const args = { ...operation, justification: 'The session already has full access.', sandbox_permissions: 'danger-full-access' }

    expect(normalizeRedundantFullAccessEscalation(args, 'danger-full-access')).toEqual(operation)
  })

  it('keeps a genuine lower-to-higher escalation intact for upstream approval', () => {
    const args = { command: 'Remove-Item important.txt', justification: 'Needs full access.', sandbox_permissions: 'danger-full-access' }

    expect(normalizeRedundantFullAccessEscalation(args, 'workspace-write')).toBe(args)
  })

  it('keeps malformed escalation fields intact for upstream validation', () => {
    const args = { command: 'Write-Output hello', justification: 'missing permission field' }

    expect(normalizeRedundantFullAccessEscalation(args, 'danger-full-access')).toBe(args)
  })

  it('derives the active mode from the latest durable sandbox event', () => {
    expect(
      effectiveSandboxMode({
        session: {
          events: [
            { data: { mode: 'workspace-write' }, type: 'sandbox/mode' },
            { data: { mode: 'danger-full-access' }, type: 'sandbox/mode' }
          ]
        }
      })
    ).toBe('danger-full-access')
  })

  it('delegates a normalized PowerShell call without changing the upstream presentation contract', async () => {
    const execute = vi.fn().mockResolvedValue({ kind: 'process' })
    const presentCall = vi.fn()
    const definition: ToolDefinition = {
      description: 'PowerShell',
      execute,
      name: 'pwsh',
      output: { render: () => [], schema: { type: 'object' } },
      parameters: { command: { type: 'string' } },
      presentCall
    }
    const wrapped = wrapSandboxEscalationTool(definition)
    const args = { command: 'Write-Output hello', justification: 'Already full.', sandbox_permissions: 'danger-full-access' }
    const exec = { agent: { session: { events: [{ data: { mode: 'danger-full-access' }, type: 'sandbox/mode' }] } } }

    await wrapped.execute(args, exec as never)

    expect(execute).toHaveBeenCalledWith({ command: 'Write-Output hello' }, exec)
    expect(wrapped.presentCall).toBe(presentCall)
    expect(wrapped.output).toBe(definition.output)
  })

  it('covers every built-in mutation tool that accepts escalation fields', () => {
    expect(SANDBOX_ESCALATION_TOOL_NAMES).toEqual(['bash', 'pwsh', 'write', 'edit'])
  })
})
