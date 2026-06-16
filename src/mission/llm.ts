// Minimal typed wrapper over the OpenAI SDK `chat.completions.create` using the modern
// `tools`/`tool_choice` function-calling API (OpenRouter rejects the deprecated `functions`).
// OpenRouter (and any OpenAI-compatible proxy) is reached via baseUrl; the model string is
// forwarded verbatim, so provider-prefixed ids like "deepseek/deepseek-v4-flash" pass through.

import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { Config } from '../types/config.js'

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string      // required on role:'tool' results — links back to the assistant call
  tool_calls?: ToolCall[]    // present on the assistant turn that invoked a tool
}

export interface FunctionDef { name: string; description: string; parameters: Record<string, unknown> }
// `id` carries the model-assigned tool_call id so the caller can echo a matching tool result.
export interface FunctionCall { id?: string; name: string; arguments: string }

// One turn: either the model called a function, or it returned plain content.
export type ChatTurn = { call: FunctionCall } | { content: string }
export type ChatFn = (msgs: ChatMsg[], fns: readonly FunctionDef[]) => Promise<ChatTurn>

export function makeChat(cfg: Config): ChatFn {
  const client = new OpenAI({
    apiKey: cfg.OPENAI_API_KEY,
    baseURL: cfg.OPENAI_BASE_URL || undefined,
  })

  return async (msgs, fns) => {
    const res = await client.chat.completions.create({
      model: cfg.OPENAI_MODEL,
      temperature: 0,
      // ChatMsg mirrors the tool message-param shape; cast once at the boundary rather than
      // reshaping every push site in compiler.ts.
      messages: msgs as ChatCompletionMessageParam[],
      tools: fns.map((f) => ({ type: 'function' as const, function: f })),
      tool_choice: 'auto',
      stream: false,
    })
    const msg = res.choices[0]?.message
    const tc = msg?.tool_calls?.[0]
    if (tc && tc.type === 'function') {
      return { call: { id: tc.id, name: tc.function.name, arguments: tc.function.arguments } }
    }
    return { content: msg?.content ?? '' }
  }
}
