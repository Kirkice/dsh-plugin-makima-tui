import { CallId, LlmAdapter, LlmError, type FinishReason, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk, attributionHeaders } from '@deepseek-ai/dsh-llm'

import { OPENAI_CODEX_PROVIDER, type OpenAiCodexAuthManager } from './openAiCodexAuth.js'

const MODELS = [
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: 272_000 },
  { id: 'gpt-5', name: 'GPT-5', contextWindow: 272_000 }
] as const

type OutputBlock =
  | { index: number; kind: 'reasoning'; text: string }
  | { index: number; kind: 'text'; text: string }
  | { callId: string; index: number; kind: 'tool'; name: string; opened: boolean; text: string }

export class OpenAiCodexAdapter extends LlmAdapter {
  constructor(
    private readonly auth: OpenAiCodexAuthManager,
    private readonly fetcher: typeof fetch = fetch
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI ChatGPT / Codex' }
  }

  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return MODELS.map(model => ({ id: model.id, name: model.name, provider }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = MODELS.find(entry => entry.id === model)
    return { context: { contextWindow: known?.contextWindow ?? 272_000 }, id: model, name: known?.name ?? model, provider }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const accessToken = await this.auth.accessToken()
    const credential = await this.auth.store.load()
    const url = `${this.auth.config.apiBaseUrl}/responses`
    const response = await this.fetcher(url, {
      body: JSON.stringify(serializeRequest(options)),
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...attributionHeaders({ product: 'makima-tui', url: 'https://github.com/agentforce314/dsh-makimaTUI', version: '0.1.0' }),
        originator: this.auth.config.originator,
        ...(credential?.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {})
      },
      method: 'POST',
      signal: options.signal
    })

    if (!response.ok || !response.body) {
      const detail = (await response.text()).slice(0, 500)
      throw new LlmError(`OpenAI Codex request failed (${response.status})${detail ? `: ${detail}` : ''}`, httpErrorCode(response.status), { status: response.status })
    }

    yield* translateResponseEvents(readSse(response.body))
  }
}

export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const input: unknown[] = []
  if (options.system) input.push({ content: [{ text: options.system, type: 'input_text' }], role: 'system' })

  for (const message of options.messages) {
    if (message.role === 'assistant') {
      const content: unknown[] = []
      for (const block of message.content) {
        if (block.type === 'text') content.push({ text: block.text, type: 'output_text' })
        else if (block.type === 'reasoning') content.push({ text: block.text, type: 'reasoning' })
        else if (block.type === 'tool-call') content.push({ arguments: block.arguments, call_id: block.id, name: block.name, type: 'function_call' })
      }
      if (content.length) input.push({ content, role: 'assistant' })
      continue
    }

    const text: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'tool-result') input.push({ call_id: block.toolCallId, output: flattenText(block.content) || '(no output)', type: 'function_call_output' })
    }
    if (text.length) input.push({ content: [{ text: text.join(''), type: 'input_text' }], role: 'user' })
  }

  return {
    input,
    model: options.model,
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort, summary: 'auto' } } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ description: tool.description, name: tool.name, parameters: tool.parameters, type: 'function' })) } : {}),
    store: false,
    stream: true
  }
}

function flattenText(content: readonly { type: string }[]): string {
  return content.flatMap(block => block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('')
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const events = pending.split(/\r?\n\r?\n/)
    pending = events.pop() ?? ''
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') continue
      try { yield JSON.parse(data) } catch { throw new LlmError('OpenAI Codex returned malformed SSE data', 'MALFORMED_RESPONSE') }
    }
  }
  if (pending.trim()) {
    const data = pending.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data && data !== '[DONE]') {
      try { yield JSON.parse(data) } catch { throw new LlmError('OpenAI Codex returned malformed SSE data', 'MALFORMED_RESPONSE') }
    }
  }
}

export async function* translateResponseEvents(events: AsyncIterable<unknown>): AsyncIterable<StreamChunk> {
  let nextIndex = 0
  let finish: FinishReason = { kind: 'stop' }
  let usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number } | undefined
  const blocks = new Map<string, OutputBlock>()
  const blockFor = (kind: OutputBlock['kind'], id: string, name = ''): OutputBlock => {
    const existing = blocks.get(id)
    if (existing) return existing
    const created: OutputBlock = kind === 'tool'
      ? { callId: id, index: nextIndex++, kind, name, opened: false, text: '' }
      : { index: nextIndex++, kind, text: '' }
    blocks.set(id, created)
    return created
  }

  for await (const raw of events) {
    const event = raw as Record<string, any>
    const type = event.type
    if (type === 'response.output_text.delta' || type === 'response.text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) continue
      const block = blockFor('text', 'text')
      if (!block.text) yield { blockType: 'text', index: block.index, type: 'block-start' }
      block.text += delta
      yield { index: block.index, text: delta, type: 'text-delta' }
    } else if (type === 'response.reasoning.delta' || type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary.delta' || type === 'response.reasoning_summary_text.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta) continue
      const block = blockFor('reasoning', 'reasoning')
      if (!block.text) yield { blockType: 'reasoning', index: block.index, type: 'block-start' }
      block.text += delta
      yield { index: block.index, text: delta, type: 'reasoning-delta' }
    } else if (type === 'response.function_call_arguments.delta') {
      const callId = String(event.call_id ?? event.item_id ?? '')
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!callId || !delta) continue
      const block = blockFor('tool', callId, typeof event.name === 'string' ? event.name : '') as Extract<OutputBlock, { kind: 'tool' }>
      if (!block.opened) {
        block.opened = true
        yield { blockType: 'tool-call', index: block.index, type: 'block-start' }
      }
      block.text += delta
      yield { argumentsDelta: delta, id: CallId(block.callId), index: block.index, ...(block.name ? { name: block.name } : {}), type: 'tool-call-delta' }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        const callId = String(item.call_id ?? item.id ?? '')
        if (!callId) continue
        const name = typeof item.name === 'string' ? item.name : ''
        const argumentsText = typeof item.arguments === 'string' ? item.arguments : ''
        const block = blockFor('tool', callId, name) as Extract<OutputBlock, { kind: 'tool' }>
        if (!block.name && name) block.name = name
        if (!block.opened) {
          block.opened = true
          yield { blockType: 'tool-call', index: block.index, type: 'block-start' }
        }
        if (!block.text && argumentsText) {
          block.text = argumentsText
          yield { argumentsDelta: argumentsText, id: CallId(block.callId), index: block.index, name: block.name, type: 'tool-call-delta' }
        }
      }
    } else if (type === 'response.completed') {
      const wireUsage = event.response?.usage ?? event.usage
      usage = usageFrom(wireUsage)
    } else if (type === 'response.failed' || type === 'response.incomplete') {
      finish = { failure: { code: 'PROVIDER_RESPONSE_FAILED', message: String(event.response?.error?.message ?? 'OpenAI Codex response failed') }, kind: 'error' }
    }
  }

  for (const block of blocks.values()) {
    if (block.kind === 'text') yield { block: { text: block.text, type: 'text' }, index: block.index, type: 'block-end' }
    else if (block.kind === 'reasoning') yield { block: { text: block.text, type: 'reasoning' }, index: block.index, type: 'block-end' }
    else yield { block: { arguments: block.text, id: CallId(block.callId), name: block.name, type: 'tool-call' }, index: block.index, type: 'block-end' }
  }
  if (usage) yield { type: 'usage', usage }
  yield { reason: finish, type: 'finish' }
}

function usageFrom(raw: unknown): { inputTokens: number; outputTokens: number; reasoningTokens?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const input = typeof value.input_tokens === 'number' ? value.input_tokens : typeof value.prompt_tokens === 'number' ? value.prompt_tokens : undefined
  const output = typeof value.output_tokens === 'number' ? value.output_tokens : typeof value.completion_tokens === 'number' ? value.completion_tokens : undefined
  if (input === undefined || output === undefined) return undefined
  const details = value.output_tokens_details as Record<string, unknown> | undefined
  return { inputTokens: input, outputTokens: output, ...(typeof details?.reasoning_tokens === 'number' ? { reasoningTokens: details.reasoning_tokens } : {}) }
}

function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return 'PROVIDER_REQUEST_FAILED'
}

export { OPENAI_CODEX_PROVIDER }
