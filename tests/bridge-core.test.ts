// tests/bridge-core.test.ts
import { test, expect } from 'bun:test'
import { selectHandoffParcel, bindRoles, rendezvousTarget } from '../src/coordination/bridge.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'
import type { Mission } from '../src/mission/kinds.js'
import type { Grid } from '../src/planning/astar.js'

function p(id: string, x: number, y: number, rewardSeen: number, carriedBy: string | null = null): ParcelBelief {
  return { id, pos: { x, y }, rewardSeen, carriedBy, lastSeen: 0 }
}

test('selectHandoffParcel picks the highest-reward free, unclaimed parcel', () => {
  const parcels = [p('a', 1, 1, 30), p('b', 2, 2, 90), p('c', 3, 3, 50)]
  expect(selectHandoffParcel(parcels, () => false)!.id).toBe('b')
})

test('selectHandoffParcel skips carried, claimed and zero-reward parcels', () => {
  const parcels = [p('carried', 1, 1, 99, 'someone'), p('claimed', 2, 2, 80), p('zero', 3, 3, 0), p('ok', 4, 4, 40)]
  expect(selectHandoffParcel(parcels, (id) => id === 'claimed')!.id).toBe('ok')
})

test('selectHandoffParcel returns null when nothing is eligible', () => {
  expect(selectHandoffParcel([], () => false)).toBeNull()
  expect(selectHandoffParcel([p('z', 1, 1, 0)], () => false)).toBeNull()
})

test('selectHandoffParcel breaks reward ties by id order', () => {
  const parcels = [p('y', 1, 1, 50), p('x', 2, 2, 50)]
  expect(selectHandoffParcel(parcels, () => false)!.id).toBe('x')
})

test('bindRoles makes the agent closer to the parcel the picker', () => {
  const r = bindRoles({ x: 0, y: 0 }, { id: 'liaison', pos: { x: 1, y: 0 } }, { id: 'courier', pos: { x: 9, y: 0 } })
  expect(r).toEqual({ picker: 'liaison', deliverer: 'courier' })
})

test('bindRoles breaks distance ties by the lower agent id (courier < liaison)', () => {
  const r = bindRoles({ x: 5, y: 0 }, { id: 'liaison', pos: { x: 4, y: 0 } }, { id: 'courier', pos: { x: 6, y: 0 } })
  expect(r.picker).toBe('courier')
})

function gridWith(zones: Array<{ x: number; y: number }>, w = 10, h = 10): Grid {
  return { w, h, tiles: new Map(), deliveryZones: zones }
}
function coordMission(params: Mission['params']): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 500, abstractIntent: 'meet', params, rawText: 'meet', status: 'CLASSIFIED' }
}

test('rendezvousTarget uses a TEXT_BOUND tile verbatim', () => {
  const m = coordMission({ contractType: 'RENDEZVOUS', targetTile: { tag: 'TEXT_BOUND', x: 7, y: 3 } })
  expect(rendezvousTarget(m, gridWith([{ x: 0, y: 0 }]))).toEqual({ x: 7, y: 3 })
})

test('rendezvousTarget falls back to the delivery zone nearest the map centre', () => {
  // centre of a 10x10 grid is (5,5); (4,6) is nearer than (0,0).
  const m = coordMission({ contractType: 'RENDEZVOUS' })
  expect(rendezvousTarget(m, gridWith([{ x: 0, y: 0 }, { x: 4, y: 6 }]))).toEqual({ x: 4, y: 6 })
})

test('rendezvousTarget returns null with no TEXT_BOUND and no delivery zones', () => {
  const m = coordMission({ contractType: 'RENDEZVOUS' })
  expect(rendezvousTarget(m, gridWith([]))).toBeNull()
})
