import type { AgentId, WorkerEnvelope } from './types/a2a.js'

export interface WorkerLike {
  postMessage(msg: WorkerEnvelope): void
}

export function relay(
  envelope: WorkerEnvelope,
  from: AgentId,
  workers: Record<AgentId, WorkerLike>,
  logWriter: (line: string) => void
): void {
  if (envelope.kind === 'log') {
    logWriter(envelope.data)
    return
  }

  if (envelope.kind === 'init') return

  const target = envelope.data.to
  if (target !== from && target in workers) {
    workers[target].postMessage(envelope)
  }
}
