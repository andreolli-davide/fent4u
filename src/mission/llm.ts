// Minimal typed wrapper over litellm `completion` for legacy function calling.
// litellm's TS types omit `functions`-on-call result, `name`-on-message, and `function_call`,
// but its OpenAI handler spreads all params into openai.chat.completions.create, so these
// fields reach the backend at runtime. We declare the wire shape locally (CLAUDE.md: minimal stubs).

import { completion } from 'litellm'
import type { Config } from '../types/config.js'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'function'
  content: string | null
  name?: string                                  // required on role:'function' results
  function_call?: { name: string; arguments: string } // echoed on the assistant turn that called
}

export interface FunctionDef { name: string; description: string; parameters: Record<string, unknown> }
export interface FunctionCall { name: string; arguments: string }

// One turn: either the model called a function, or it returned plain content.
export type ChatTurn = { call: FunctionCall } | { content: string }
export type ChatFn = (msgs: ChatMsg[], fns: readonly FunctionDef[]) => Promise<ChatTurn>

const OPENAI_MODEL = /^(gpt-|openai\/)/

export function assertOpenAiModel(model: string): void {
  if (!OPENAI_MODEL.test(model)) {
    throw new Error(
      `LITELLM_MODEL="${model}" cannot do function calling: litellm routes only gpt-*/openai/* ` +
      `to the OpenAI handler; other handlers flatten messages and drop functions. ` +
      `Use an OpenAI-compatible model id and set LITELLM_BASE_URL.`,
    )
  }
}

export function makeChat(cfg: Config): ChatFn {
  assertOpenAiModel(cfg.LITELLM_MODEL)
  return async (msgs, fns) => {
    // litellm's HandlerParams type does not list `functions`/`function_call` on messages,
    // but the OpenAI handler forwards them — cast at this single boundary.
    const res = await completion({
      model: cfg.LITELLM_MODEL,
      apiKey: cfg.LITELLM_API_KEY,
      baseUrl: cfg.LITELLM_BASE_URL || undefined,
      temperature: 0,
      messages: msgs as unknown as never,
      functions: fns as unknown as never,
      function_call: 'auto' as unknown as never,
      stream: false,
    })
    const msg = 'choices' in res ? res.choices[0]?.message : undefined
    const fc = msg?.function_call
    if (fc && typeof fc.name === 'string' && typeof fc.arguments === 'string') {
      return { call: { name: fc.name, arguments: fc.arguments } }
    }
    return { content: msg?.content ?? '' }
  }
}
