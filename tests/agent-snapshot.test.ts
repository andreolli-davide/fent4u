import { test, expect } from 'bun:test'
import { forwardApply, beliefSignature, type WorldSnapshot } from '../src/mission/agent/snapshot.js'

const base = (): WorldSnapshot => ({
  t0: 100,
  selfPos: { x: 0, y: 0 },
  carried: [],
  delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 0 }, reward: 30, carriedBy: null }],
  zones: [{ x: 5, y: 0 }],
  partnerPos: null,
  sig: 'x',
})

test('goto moves the simulated self position', () => {
  const s = forwardApply(base(), { op: 'goto', target: { x: 2, y: 0 } })
  expect(s.selfPos).toEqual({ x: 2, y: 0 })
})

test('pickup adds the parcel to carried and marks it carried by self', () => {
  const s = forwardApply(base(), { op: 'pickup', parcelId: 'p1' })
  expect(s.carried).toEqual(['p1'])
  expect(s.parcels.find((p) => p.id === 'p1')?.carriedBy).toBe('self')
})

test('deliver moves carried parcels into delivered at the zone', () => {
  const picked = forwardApply(base(), { op: 'pickup', parcelId: 'p1' })
  const s = forwardApply(picked, { op: 'deliver', zone: { x: 5, y: 0 } })
  expect(s.carried).toEqual([])
  expect(s.delivered).toEqual([{ id: 'p1', zone: { x: 5, y: 0 } }])
})

test('wait does not change position or carried', () => {
  const s = forwardApply(base(), { op: 'wait', n: 3 })
  expect(s.selfPos).toEqual({ x: 0, y: 0 })
  expect(s.carried).toEqual([])
})

test('forwardApply does not mutate the input snapshot', () => {
  const b = base()
  forwardApply(b, { op: 'goto', target: { x: 9, y: 9 } })
  expect(b.selfPos).toEqual({ x: 0, y: 0 })
})

test('beliefSignature changes when a parcel position changes', () => {
  const a = beliefSignature(base().parcels, base().selfPos)
  const moved = [{ id: 'p1', pos: { x: 3, y: 0 }, reward: 30, carriedBy: null }]
  expect(beliefSignature(moved, base().selfPos)).not.toBe(a)
})
