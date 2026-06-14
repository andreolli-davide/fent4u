import type { Config } from './config.js'
import type { Params } from '../bdi/params.js'

export type AgentId = 'liaison' | 'courier'

export interface A2AMessage {
  from: AgentId
  to: AgentId
  type: string
  payload: unknown
}

export type WorkerEnvelope =
  | { kind: 'init'; config: Config; params: Params }
  | { kind: 'a2a'; data: A2AMessage }
  | { kind: 'log'; data: string }
