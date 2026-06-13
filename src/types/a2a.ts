import type { Config } from './config.js'

export type AgentId = 'liaison' | 'courier'

export interface A2AMessage {
  from: AgentId
  to: AgentId
  type: string
  payload: unknown
}

export type WorkerEnvelope =
  | { kind: 'init'; config: Config }
  | { kind: 'a2a'; data: A2AMessage }
  | { kind: 'log'; data: string }
