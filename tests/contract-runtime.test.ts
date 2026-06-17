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
