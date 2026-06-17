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
