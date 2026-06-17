// tests/contract-syncgate.test.ts
import { test, expect } from 'bun:test'
import { syncGateContract, advance, type Contract } from '../src/coordination/contract.js'

test('syncGateContract builds two staging LOCALs + a barrier (no parcels/roles)', () => {
  const c = syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999)
  expect(c.type).toBe('SYNC_GATE')
  expect(c.status).toBe('PROPOSED')
  expect(c.lockParcels).toBeUndefined()
  expect(c.steps).toEqual([
    { kind: 'LOCAL', agent: 'liaison', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'l_staged' },
    { kind: 'LOCAL', agent: 'courier', goal: { kind: 'IN_ZONE', center: { x: 5, y: 5 }, radius: 3 }, post: 'c_staged' },
    { kind: 'BARRIER', needs: ['l_staged', 'c_staged'] },
  ])
})

test('advance returns "gated" once a SYNC_GATE barrier is released (not "done")', () => {
  const c: Contract = { ...syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999), status: 'ACTIVE', posted: { l_staged: true, c_staged: true } }
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'gated' })
})

test('advance still stages a SYNC_GATE normally before the barrier', () => {
  const c: Contract = { ...syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999), status: 'ACTIVE', posted: {} }
  expect(advance(c, 'liaison', { x: 0, y: 0 })).toEqual({ kind: 'navigate', to: { x: 5, y: 5 } })
  expect(advance(c, 'liaison', { x: 5, y: 5 })).toEqual({ kind: 'post', milestone: 'l_staged' })
})

import { ContractRuntime, isGateMsg, GATE_STALE_TTL } from '../src/coordination/contract.js'

function activeGate(): ContractRuntime {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: syncGateContract('g1', { x: 5, y: 5 }, 3, 700, 9999) }, 'courier')
  return rt
}

test('gate defaults OPEN and is fresh at the heartbeat tick', () => {
  const rt = activeGate()
  expect(rt.gateOpen(0)).toBe(true)
})

test('setGate flips the flag locally and returns the broadcast msg', () => {
  const rt = activeGate()
  const msg = rt.setGate('CLOSED', 10)
  expect(msg).toEqual({ id: 'g1', state: 'CLOSED', tick: 10 })
  expect(rt.gateOpen(10)).toBe(false)
})

test('a stale OPEN gate reads CLOSED past GATE_STALE_TTL (§8.5 fail-safe)', () => {
  const rt = activeGate()
  rt.setGate('OPEN', 10)
  expect(rt.gateOpen(10 + GATE_STALE_TTL)).toBe(true)
  expect(rt.gateOpen(10 + GATE_STALE_TTL + 1)).toBe(false)
})

test('applyGate replicates a newer gate state but ignores an older tick', () => {
  const rt = activeGate()
  rt.applyGate({ id: 'g1', state: 'CLOSED', tick: 20 })
  expect(rt.gateOpen(20)).toBe(false)
  rt.applyGate({ id: 'g1', state: 'OPEN', tick: 5 }) // stale → ignored
  expect(rt.gateOpen(20)).toBe(false)
})

test('applyGate ignores a different contract id', () => {
  const rt = activeGate()
  rt.applyGate({ id: 'OTHER', state: 'CLOSED', tick: 99 })
  expect(rt.gateOpen(99)).toBe(true)
})

test('fail() marks FAILED, clears the slot, and resets the gate OPEN', () => {
  const rt = activeGate()
  rt.setGate('CLOSED', 10)
  const msg = rt.fail()
  expect(msg).toEqual({ kind: 'teardown', id: 'g1', status: 'FAILED' })
  expect(rt.current()).toBeNull()
  expect(rt.gateOpen(10)).toBe(true) // gate disarmed back to OPEN on teardown
})

test('isGateMsg accepts well-formed and rejects malformed payloads', () => {
  expect(isGateMsg({ id: 'g1', state: 'OPEN', tick: 1 })).toBe(true)
  expect(isGateMsg({ id: 'g1', state: 'CLOSED', tick: 1 })).toBe(true)
  expect(isGateMsg(null)).toBe(false)
  expect(isGateMsg({ id: 'g1', state: 'green', tick: 1 })).toBe(false)
  expect(isGateMsg({ id: 'g1', state: 'OPEN' })).toBe(false)
})
