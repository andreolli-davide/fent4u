// Minimal typed wrapper over the OpenAI SDK `chat.completions.create` using the modern
// `tools`/`tool_choice` function-calling API (OpenRouter rejects the deprecated `functions`).
// OpenRouter (and any OpenAI-compatible proxy) is reached via baseUrl; the model string is
// forwarded verbatim, so provider-prefixed ids like "deepseek/deepseek-v4-flash" pass through.

import OpenAI from 'openai'
import type { Config } from '../types/config.js'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string  // required on role:'tool' results — links back to the assistant call
}

export interface FunctionDef { name: string; description: string; parameters: Record<string, unknown> }
// `id` carries the model-assigned tool_call id so the caller can echo a matching tool result.
export interface FunctionCall { name: string; arguments: string; id?: string }

// One turn: either the model called one-or-more functions (parallel tool calls), or it
// returned plain content. Multiple calls must ALL be answered before the next turn,
// otherwise the model never receives the dropped results and re-issues them forever.
export type ChatTurn = { calls: FunctionCall[] } | { content: string }
export type ChatFn = (msgs: ChatMsg[], fns: readonly FunctionDef[]) => Promise<ChatTurn>

interface LlmLogger {
  debug: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

// A hung or slow endpoint must not wedge the single-flight mission intake. The SDK's
// default timeout is 10 minutes — far too long for an interactive game lane.
const REQUEST_TIMEOUT_MS = 20_000
// SDK retries 429 / 5xx / connection errors with exponential backoff. Keep it to one
// extra attempt so worst-case wall time stays bounded (~2 × timeout).
const MAX_RETRIES = 1
// Cap total prompt size to bound token cost and refuse oversized / adversarial input.
const MAX_INPUT_CHARS = 8_000

// Thrown for any LLM failure. Carries a sanitized message only — never the raw SDK
// error, whose text can include request URLs or auth headers. `cause` keeps the
// original for local debugging but is not surfaced by `String(err)`.
export class LlmError extends Error {
  readonly status?: number
  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'LlmError'
    this.status = opts?.status
  }
}

export function makeChat(cfg: Config, logger?: LlmLogger): ChatFn {
  if (!cfg.OPENAI_MODEL.trim()) throw new Error('OPENAI_MODEL is empty')

  const client = new OpenAI({
    apiKey: cfg.OPENAI_API_KEY,
    baseURL: cfg.OPENAI_BASE_URL || undefined,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  })

  return async (msgs, fns) => {
    const inputChars = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0)
    if (inputChars > MAX_INPUT_CHARS) {
      throw new LlmError(`prompt too large: ${inputChars} > ${MAX_INPUT_CHARS} chars`)
    }

    const tools: OpenAI.Chat.ChatCompletionTool[] = fns.map((fn) => ({
      type: 'function',
      function: { name: fn.name, description: fn.description, parameters: fn.parameters },
    }))
    logger?.debug(
      { module: 'mission', model: cfg.OPENAI_MODEL, turns: msgs.length, tools: fns.map((f) => f.name) },
      'llm call',
    )

    let res: OpenAI.Chat.ChatCompletion
    try {
      res = await client.chat.completions.create({
        model: cfg.OPENAI_MODEL,
        temperature: 0,
        // ChatMsg is a structural subset of the SDK param union; this boundary cast is
        // the one unavoidable bridge between our simplified type and the SDK's.
        messages: msgs as OpenAI.Chat.ChatCompletionMessageParam[],
        tools,
        tool_choice: 'auto',
        stream: false,
      })
    } catch (err) {
      // OpenAI errors (incl. timeout) carry a numeric `status`; surface it but nothing else.
      const status = typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : undefined
      throw new LlmError(
        status !== undefined ? `llm request failed (status ${status})` : 'llm request failed',
        { status, cause: err },
      )
    }

    const choice = res.choices[0]
    const msg = choice?.message
    if (!msg) {
      // No choices is a protocol-level anomaly (some non-OpenAI endpoints do this on error).
      logger?.warn({ module: 'mission', finish_reason: choice?.finish_reason }, 'llm returned no message')
      throw new LlmError('llm returned no choices')
    }

    // ALL *function* tool calls (the model may issue several in parallel) — ignore
    // custom-tool calls we never registered. Guard against providers that send a
    // tool_call with non-string fields.
    const calls: FunctionCall[] = (msg.tool_calls ?? [])
      .filter((c) => c.type === 'function')
      .filter((c) => typeof c.function.name === 'string' && typeof c.function.arguments === 'string')
      .map((c) => ({ name: c.function.name, arguments: c.function.arguments, id: c.id }))

    logger?.debug(
      {
        module: 'mission',
        model: cfg.OPENAI_MODEL,
        finish_reason: choice.finish_reason,
        tools: calls.map((c) => c.name),
        prompt_tokens: res.usage?.prompt_tokens,
        completion_tokens: res.usage?.completion_tokens,
      },
      'llm response',
    )

    if (calls.length > 0) return { calls }

    if (!msg.content) {
      logger?.warn({ module: 'mission', finish_reason: choice.finish_reason }, 'llm returned empty response')
    }
    return { content: msg.content ?? '' }
  }
}
