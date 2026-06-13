import { describe, it, expect } from 'bun:test'
import { relay, type WorkerLike } from '../src/relay.js'
import type { WorkerEnvelope } from '../src/types/a2a.js'

function makeWorkers(): {
  liaison: WorkerLike & { received: WorkerEnvelope[] }
  courier: WorkerLike & { received: WorkerEnvelope[] }
} {
  const make = () => {
    const received: WorkerEnvelope[] = []
    return { received, postMessage: (m: WorkerEnvelope) => received.push(m) }
  }
  return { liaison: make(), courier: make() }
}

describe('relay', () => {
  it('writes log envelopes to logWriter and does not forward them', () => {
    const workers = makeWorkers()
    const logLines: string[] = []
    const envelope: WorkerEnvelope = { kind: 'log', data: '{"level":30,"msg":"hi"}' }

    relay(envelope, 'liaison', workers, (line) => logLines.push(line))

    expect(logLines).toEqual(['{"level":30,"msg":"hi"}'])
    expect(workers.liaison.received).toHaveLength(0)
    expect(workers.courier.received).toHaveLength(0)
  })

  it('forwards a2a envelopes to the destination worker', () => {
    const workers = makeWorkers()
    const envelope: WorkerEnvelope = {
      kind: 'a2a',
      data: { from: 'liaison', to: 'courier', type: 'delta', payload: { x: 1 } },
    }

    relay(envelope, 'liaison', workers, () => {})

    expect(workers.courier.received).toHaveLength(1)
    expect(workers.courier.received[0]).toEqual(envelope)
    expect(workers.liaison.received).toHaveLength(0)
  })

  it('does not echo a2a messages back to sender even if to === from', () => {
    const workers = makeWorkers()
    const envelope: WorkerEnvelope = {
      kind: 'a2a',
      data: { from: 'liaison', to: 'liaison', type: 'self', payload: null },
    }

    relay(envelope, 'liaison', workers, () => {})

    expect(workers.liaison.received).toHaveLength(0)
  })

  it('ignores init envelopes (they are never relayed)', () => {
    const workers = makeWorkers()
    const envelope: WorkerEnvelope = {
      kind: 'init',
      config: {} as never,
    }

    relay(envelope, 'liaison', workers, () => {})

    expect(workers.liaison.received).toHaveLength(0)
    expect(workers.courier.received).toHaveLength(0)
  })
})
