import { test, expect } from 'bun:test'
import { ClaimStore, type Claim } from '../src/coordination/claims.js'

const claim = (parcelId: string, agentId: 'liaison' | 'courier', over: Partial<Claim> = {}): Claim => ({
  parcelId, agentId, origin: 'AUCTION', epoch: 1, commitTick: 0, originD: 5, lastD: 5, lastProgressTick: 0, ...over,
})

test('add / claimedBy / ownClaims / partnerClaimed', () => {
  const s = new ClaimStore()
  s.add(claim('p1', 'courier'))
  s.add(claim('p2', 'liaison'))
  expect(s.claimedBy('p1')).toBe('courier')
  expect(s.claimedBy('p3')).toBeNull()
  expect(s.ownClaims('courier').map((c) => c.parcelId)).toEqual(['p1'])
  expect([...s.partnerClaimed('courier')].sort()).toEqual(['p2'])
})

test('expire drops claims with no progress for CLAIM_TTL ticks', () => {
  const s = new ClaimStore()
  s.add(claim('stuck', 'courier', { lastD: 5, lastProgressTick: 0 }))
  // tnow=10, still 5 away (no progress since tick 0), CLAIM_TTL=10 → expires
  const dropped = s.expire(10, () => 5, 10)
  expect(dropped.map((c) => c.parcelId)).toEqual(['stuck'])
  expect(s.claimedBy('stuck')).toBeNull()
})

test('expire keeps a claim that is still making progress', () => {
  const s = new ClaimStore()
  s.add(claim('moving', 'courier', { lastD: 5, lastProgressTick: 0 }))
  s.expire(3, () => 4, 10) // got closer (5→4) at tick 3 → progress, resets timer
  const dropped = s.expire(12, () => 4, 10) // 9 ticks since last progress < 10 → kept
  expect(dropped).toEqual([])
  expect(s.claimedBy('moving')).toBe('courier')
})

test('expire keeps MISSION claims regardless of TTL', () => {
  const s = new ClaimStore()
  s.add(claim('locked', 'courier', { origin: 'MISSION', lastD: 5, lastProgressTick: 0 }))
  const dropped = s.expire(100, () => 5, 10)
  expect(dropped).toEqual([])
  expect(s.claimedBy('locked')).toBe('courier')
})

test('ownClaims returns sorted by parcelId', () => {
  const s = new ClaimStore()
  s.add(claim('z-parcel', 'courier'))
  s.add(claim('a-parcel', 'courier'))
  s.add(claim('m-parcel', 'courier'))
  expect(s.ownClaims('courier').map((c) => c.parcelId)).toEqual(['a-parcel', 'm-parcel', 'z-parcel'])
})

test('remove deletes a claim', () => {
  const s = new ClaimStore()
  s.add(claim('p1', 'courier'))
  s.remove('p1')
  expect(s.claimedBy('p1')).toBeNull()
})
