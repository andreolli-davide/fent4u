import { test, expect } from 'bun:test'
import { select, matches, chooseExplore, type Intention, type Candidate } from '../src/bdi/intentions.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { Pos } from '../src/types/perception.js'

const idle: Intention = { kind: 'idle' }
const routeA: Intention = { kind: 'route', route: { pickups: [{ id: 'p1', pos: { x: 1, y: 0 }, rewardSeen: 10, carriedBy: null, lastSeen: 0 }], zone: { x: 0, y: 0 }, delivered: [], L: 2 } }
const explore: Intention = { kind: 'explore', target: { tile: { x: 9, y: 9 }, score: 1 } }

test('argmax picks the highest utility', () => {
  const cands: Candidate[] = [
    { intention: routeA, u: 5 },
    { intention: explore, u: 1 },
    { intention: idle, u: 0.001 },
  ]
  expect(select(cands, null, DEFAULT_PARAMS.h_commit).kind).toBe('route')
})

test('h_commit bonus flips a near-tie toward the committed intention', () => {
  const cands: Candidate[] = [
    { intention: routeA, u: 1.0 },
    { intention: explore, u: 1.1 }, // explore is nominally higher
  ]
  // not committed: explore wins
  expect(select(cands, null, 0.15).kind).toBe('explore')
  // committed to route: 1.0*1.15=1.15 > 1.1 => route wins
  expect(select(cands, routeA, 0.15).kind).toBe('route')
})

test('U<=0 candidates are dropped; idle floor survives', () => {
  const cands: Candidate[] = [
    { intention: routeA, u: -1 },
    { intention: idle, u: 0.001 },
  ]
  expect(select(cands, null, 0.15).kind).toBe('idle')
})

test('matches: same route head pickup is the same commitment', () => {
  const routeA2: Intention = { kind: 'route', route: { ...((routeA as { route: { pickups: unknown } }).route as never), L: 3 } as never }
  expect(matches(routeA, routeA2)).toBe(true)
})

test('chooseExplore picks the stalest reachable spawner', () => {
  const spawners: Pos[] = [{ x: 2, y: 0 }, { x: 8, y: 0 }]
  const seenAt = new Map<string, number>([['2,0', 100]]) // (2,0) seen recently; (8,0) never
  const dist = (a: Pos, b: Pos): number => Math.abs(a.x - b.x)
  const t = chooseExplore(spawners, seenAt, { x: 0, y: 0 }, 100, dist, DEFAULT_PARAMS)
  expect(t?.intention.target.tile).toEqual({ x: 8, y: 0 })
})
