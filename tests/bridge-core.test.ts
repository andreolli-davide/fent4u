// tests/bridge-core.test.ts
import { test, expect } from 'bun:test'
import { selectHandoffParcel, bindRoles } from '../src/coordination/bridge.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

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
