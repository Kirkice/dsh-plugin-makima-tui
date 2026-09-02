import { describe, expect, it } from 'vitest'

import { OpenAiCodexAdapter, readSse, serializeRequest, translateResponseEvents } from '../harness/openAiCodexAdapter.js'

type GenerateOptions = Parameters<typeof serializeRequest>[0]

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('OpenAI Codex Responses adapter', () => {
  it('lists the ChatGPT/Codex catalog, including GPT-5.6 Sol, Terra, and Luna', async () => {
    const adapter = new OpenAiCodexAdapter({} as never)
    const models = await adapter.listModels('openai-codex')

    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
    expect(models.find((model) => model.id === 'gpt-5.3-codex-spark')?.inputModalities).toEqual(['text'])
    expect(models.find((model) => model.id === 'gpt-5.6-terra')?.inputModalities).toEqual(['text', 'image'])
  })

  it('resolves model input modalities and GPT-5.6 reasoning capabilities', async () => {
    const adapter = new OpenAiCodexAdapter({} as never)

    await expect(adapter.resolveModel('openai-codex', 'gpt-5.3-codex-spark')).resolves.toMatchObject({
      inputModalities: ['text']
    })
    await expect(adapter.resolveModel('openai-codex', 'gpt-5.6-terra')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
      reasoning: {
        defaultEffort: 'medium',
        efforts: [
          { id: 'none', name: 'None' },
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
          { id: 'xhigh', name: 'Extra high' }
        ]
      }
    })
    await expect(adapter.resolveModel('openai-codex', 'gpt-5.6-luna')).resolves.toMatchObject({
      reasoning: { defaultEffort: 'medium' }
    })
    await expect(adapter.resolveModel('openai-codex', 'future-model')).resolves.not.toHaveProperty('inputModalities')
  })

  it('serializes messages, tools, and generation settings for Responses', async () => {
    const request = await serializeRequest({
      maxTokens: 123,
      messages: [
        { content: [{ text: 'hello', type: 'text' }], role: 'user' },
        {
          content: [
            { text: 'private chain of thought', type: 'reasoning' },
            { arguments: '{"path":"a.ts"}', id: 'call-1', name: 'read_file', type: 'tool-call' }
          ],
          role: 'assistant'
        },
        { content: [{ content: [{ text: 'source', type: 'text' }], toolCallId: 'call-1', type: 'tool-result' }], role: 'user' }
      ],
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      signal: new AbortController().signal,
      system: 'be concise',
      temperature: 0.2,
      tools: [{ description: 'Read a file', name: 'read_file', parameters: { type: 'object' } }]
    } as unknown as GenerateOptions)

    expect(request).toMatchObject({
      max_output_tokens: 123,
      model: 'gpt-5-codex',
      reasoning: { effort: 'high', summary: 'auto' },
      store: false,
      stream: true,
      temperature: 0.2,
      tools: [{ name: 'read_file', type: 'function' }]
    })
    expect(request.input).toEqual(
      expect.arrayContaining([
        { content: [{ text: 'be concise', type: 'input_text' }], role: 'system' },
        { content: [{ text: 'hello', type: 'input_text' }], role: 'user' },
        { content: [{ arguments: '{"path":"a.ts"}', call_id: 'call-1', name: 'read_file', type: 'function_call' }], role: 'assistant' },
        { call_id: 'call-1', output: 'source', type: 'function_call_output' }
      ])
    )
    expect(JSON.stringify(request.input)).not.toContain('private chain of thought')
    expect(JSON.stringify(request.input)).not.toContain('"reasoning"')
  })

  it('uses the Codex backend path and sends its required routing headers', async () => {
    const requests: Array<{ headers?: HeadersInit; url: string }> = []
    const auth = {
      accessToken: async () => 'access-token',
      config: { apiBaseUrl: 'https://chatgpt.com/backend-api/codex', originator: 'makima-tui' },
      store: { load: async () => ({ accountId: 'account-id' }) }
    }
    const adapter = new OpenAiCodexAdapter(auth as never, async (url, init) => {
      requests.push({ headers: init?.headers, url: String(url) })
      return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    })

    await collect(adapter.stream({
      messages: [],
      model: 'gpt-5.6-luna',
      provider: 'openai-codex',
      sessionId: 'session-id',
      signal: new AbortController().signal
    } as unknown as GenerateOptions))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(new Headers(requests[0]?.headers)).toMatchObject({
      authorization: 'Bearer access-token',
      'chatgpt-account-id': 'account-id',
      originator: 'makima-tui',
      session_id: 'session-id'
    })
  })

  it('resolves durable image attachments into Responses input_image blocks', async () => {
    const request = await serializeRequest(
      {
        messages: [
          {
            content: [
              { text: '[Image #1] describe this', type: 'text' },
              {
                attachment: { attachmentId: 'image-1', bytes: 3, height: 1, mediaType: 'image/png', name: 'shot.png', width: 1 },
                type: 'image'
              }
            ],
            role: 'user'
          }
        ],
        model: 'gpt-5.6-terra',
        signal: new AbortController().signal
      } as unknown as GenerateOptions,
      async (ref) => ({ data: new Uint8Array([1, 2, 3]), ref })
    )

    expect(request.input).toEqual([
      {
        content: [
          { text: '[Image #1] describe this', type: 'input_text' },
          { image_url: 'data:image/png;base64,AQID', type: 'input_image' }
        ],
        role: 'user'
      }
    ])
  })

  it('parses split SSE frames and ignores the DONE sentinel', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta",'))
        controller.enqueue(new TextEncoder().encode('"delta":"hi"}\n\ndata: [DONE]\n\n'))
        controller.close()
      }
    })

    await expect(collect(readSse(stream))).resolves.toEqual([{ delta: 'hi', type: 'response.output_text.delta' }])
  })

  it('translates text, reasoning, a zero-argument tool call, usage, and completion', async () => {
    async function* events() {
      yield { delta: 'think', type: 'response.reasoning.delta' }
      yield { delta: 'answer', type: 'response.output_text.delta' }
      yield { item: { arguments: '', call_id: 'call-1', name: 'ping', type: 'function_call' }, type: 'response.output_item.added' }
      yield {
        response: { usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } },
        type: 'response.completed'
      }
    }

    const chunks = await collect(translateResponseEvents(events()))

    expect(chunks).toEqual(
      expect.arrayContaining([
        { blockType: 'reasoning', index: 0, type: 'block-start' },
        { index: 0, text: 'think', type: 'reasoning-delta' },
        { blockType: 'text', index: 1, type: 'block-start' },
        { index: 1, text: 'answer', type: 'text-delta' },
        { blockType: 'tool-call', index: 2, type: 'block-start' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 } },
        { reason: { kind: 'stop' }, type: 'finish' }
      ])
    )
    expect(chunks).toContainEqual({
      block: { arguments: '', id: 'call-1', name: 'ping', type: 'tool-call' },
      index: 2,
      type: 'block-end'
    })
  })
})
