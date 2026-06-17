// tests/contract-runtime.test.ts
import { test, expect } from 'bun:test'
import { ContractRuntime, type Contract } from '../src/coordination/contract.js'

function rdv(): Contract {
  return {
    id: 'c1', type: 'RENDEZVOUS',
    steps: [{ kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] }],
    posted: {}, payoff: 500, deadline: 9999, status: 'PROPOSED',
  }
}

test('propose stores the contract PROPOSED and is not yet active()', () => {
  const rt = new ContractRuntime()
  const msg = rt.propose(rdv())
  expect(msg).toEqual({ kind: 'propose', contract: rt.current()! })
  expect(rt.current()!.status).toBe('PROPOSED')
  expect(rt.active()).toBeNull()
})

test('Courier applying a propose goes ACTIVE and replies accept', () => {
  const courier = new ContractRuntime()
  const reply = courier.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  expect(reply).toEqual({ kind: 'accept', id: 'c1' })
  expect(courier.active()!.id).toBe('c1')
})

test('Liaison applying the accept flips PROPOSED → ACTIVE', () => {
  const liaison = new ContractRuntime()
  liaison.propose(rdv())
  expect(liaison.active()).toBeNull()
  const reply = liaison.applyMsg({ kind: 'accept', id: 'c1' }, 'liaison')
  expect(reply).toBeNull()
  expect(liaison.active()!.id).toBe('c1')
})

test('post replicates a milestone onto the local contract', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier') // now ACTIVE
  rt.applyMsg({ kind: 'post', id: 'c1', milestone: 'liaison_ready' }, 'courier')
  expect(rt.current()!.posted.liaison_ready).toBe(true)
})

test('own post() flips the flag locally AND returns the broadcast msg', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  const msg = rt.post('courier_ready')
  expect(msg).toEqual({ kind: 'post', id: 'c1', milestone: 'courier_ready' })
  expect(rt.current()!.posted.courier_ready).toBe(true)
})

test('complete() marks SATISFIED, clears the slot, returns a teardown msg', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  const msg = rt.complete()
  expect(msg).toEqual({ kind: 'teardown', id: 'c1', status: 'SATISFIED' })
  expect(rt.current()).toBeNull()
  expect(rt.active()).toBeNull()
})

test('teardown from the partner clears the local slot', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  rt.applyMsg({ kind: 'teardown', id: 'c1', status: 'SATISFIED' }, 'courier')
  expect(rt.current()).toBeNull()
})

test('messages for a different contract id are ignored', () => {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: rdv() }, 'courier')
  rt.applyMsg({ kind: 'post', id: 'OTHER', milestone: 'liaison_ready' }, 'courier')
  rt.applyMsg({ kind: 'teardown', id: 'OTHER', status: 'FAILED' }, 'courier')
  expect(rt.current()!.id).toBe('c1')
  expect(rt.current()!.posted.liaison_ready).toBeUndefined()
})

import { rendezvousContract, advance } from '../src/coordination/contract.js'

test('rendezvousContract builds the two-LOCAL + barrier template', () => {
  const c = rendezvousContract('r1', { x: 5, y: 5 }, 3, 500, 1000)
  expect(c.id).toBe('r1')
  expect(c.type).toBe('RENDEZVOUS')
  expect(c.status).toBe('PROPOSED')
  expect(c.payoff).toBe(500)
  expect(c.deadline).toBe(1000)
  expect(c.posted).toEqual({})
  expect(c.steps).toEqual([
    { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'liaison_ready' },
    { kind: 'LOCAL', agent: 'courier', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'courier_ready' },
    { kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] },
  ])
})

// A hand-built ACTIVE handoff-shaped contract for the advance() walk-through (no map / builder
// needed — Task 1 must go green before handoffContract exists). The shape matches what Task 2's
// handoffContract() will produce, exercised there.
function handoffSteps(): Contract {
  return {
    id: 'h1', type: 'HANDOFF', payoff: 200, deadline: 9999, status: 'ACTIVE', posted: {},
    lockOwner: 'liaison', lockParcels: ['p1'],
    steps: [
      { kind: 'ACTION', agent: 'liaison', primitive: 'pickUp', ids: ['p1'], at: { x: 2, y: 1 }, post: 'picked' },
      { kind: 'ACTION', agent: 'liaison', primitive: 'putDown', ids: ['p1'], at: { x: 1, y: 0 }, post: 'dropped', onDelivery: false },
      { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'AT_TILE', tile: { x: 1, y: 1 } }, post: 'H_clear' },
      { kind: 'LOCAL', agent: 'courier', goal: { kind: 'AT_TILE', tile: { x: 2, y: 0 } }, post: 'b_ready' },
      { kind: 'BARRIER', needs: ['H_clear', 'b_ready'] },
      { kind: 'ACTION', agent: 'courier', primitive: 'pickUp', ids: ['p1'], at: { x: 1, y: 0 }, post: 'b_picked' },
      { kind: 'ACTION', agent: 'courier', primitive: 'putDown', ids: ['p1'], at: { x: 0, y: 0 }, post: 'delivered', onDelivery: true },
    ],
  }
}

test('advance: picker picks up at the parcel tile, then drops at the drop tile', () => {
  const c = handoffSteps()
  // picker (liaison) standing on the parcel tile → pickUp with explicit ids
  expect(advance(c, 'liaison', { x: 2, y: 1 })).toEqual({ kind: 'pickup', ids: ['p1'], post: 'picked' })
  c.posted.picked = true
  // not yet at the drop tile → navigate to it
  expect(advance(c, 'liaison', { x: 2, y: 1 })).toEqual({ kind: 'navigate', to: { x: 1, y: 0 } })
  // on the drop tile → putDown (non-scoring ground drop)
  expect(advance(c, 'liaison', { x: 1, y: 0 })).toEqual({ kind: 'putdown', ids: ['p1'], post: 'dropped', onDelivery: false })
})

test('advance: picker blocks at the barrier after vacating until the deliverer is ready', () => {
  const c = handoffSteps()
  c.posted.picked = true
  c.posted.dropped = true
  // picker on the vacate tile → posts H_clear
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'post', milestone: 'H_clear' })
  c.posted.H_clear = true
  // H_clear posted but b_ready not → picker hits the barrier and blocks
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'block' })
})

test('advance: contract is done only after the deliverer posts delivered (not when the picker runs out of steps)', () => {
  const c = handoffSteps()
  c.posted.picked = true
  c.posted.dropped = true
  c.posted.H_clear = true
  c.posted.b_ready = true   // barrier released
  // picker has no steps after the barrier, but the deliverer has not delivered → block, NOT done
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'block' })
  // deliverer finishes
  c.posted.b_picked = true
  c.posted.delivered = true
  // now every non-barrier milestone is posted → done for both
  expect(advance(c, 'liaison', { x: 1, y: 1 })).toEqual({ kind: 'done' })
  expect(advance(c, 'courier', { x: 0, y: 0 })).toEqual({ kind: 'done' })
})

test('advance: deliverer scoring putDown carries onDelivery:true', () => {
  const c = handoffSteps()
  c.posted.picked = true; c.posted.dropped = true; c.posted.H_clear = true
  c.posted.b_ready = true; c.posted.b_picked = true
  // deliverer on the delivery tile → scoring putDown
  expect(advance(c, 'courier', { x: 0, y: 0 })).toEqual({ kind: 'putdown', ids: ['p1'], post: 'delivered', onDelivery: true })
})

import { handoffContract, type HandoffTiles } from '../src/coordination/contract.js'

test('handoffContract builds the §8.3 step list with lock fields', () => {
  const tiles: HandoffTiles = {
    parcel: { x: 2, y: 1 }, drop: { x: 1, y: 0 }, vacate: { x: 1, y: 1 },
    approach: { x: 2, y: 0 }, delivery: { x: 0, y: 0 },
  }
  const c = handoffContract('h1', 'p1', 'liaison', 'courier', tiles, 200, 9999)
  expect(c.type).toBe('HANDOFF')
  expect(c.status).toBe('PROPOSED')
  expect(c.lockOwner).toBe('liaison')
  expect(c.lockParcels).toEqual(['p1'])
  expect(c.steps).toEqual([
    { kind: 'ACTION', agent: 'liaison', primitive: 'pickUp', ids: ['p1'], at: { x: 2, y: 1 }, post: 'picked' },
    { kind: 'ACTION', agent: 'liaison', primitive: 'putDown', ids: ['p1'], at: { x: 1, y: 0 }, post: 'dropped', onDelivery: false },
    { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'AT_TILE', tile: { x: 1, y: 1 } }, post: 'H_clear' },
    { kind: 'LOCAL', agent: 'courier', goal: { kind: 'AT_TILE', tile: { x: 2, y: 0 } }, post: 'b_ready' },
    { kind: 'BARRIER', needs: ['H_clear', 'b_ready'] },
    { kind: 'ACTION', agent: 'courier', primitive: 'pickUp', ids: ['p1'], at: { x: 1, y: 0 }, post: 'b_picked' },
    { kind: 'ACTION', agent: 'courier', primitive: 'putDown', ids: ['p1'], at: { x: 0, y: 0 }, post: 'delivered', onDelivery: true },
  ])
})
