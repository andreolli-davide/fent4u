// tests/beliefs-helpers.test.ts
import { test, expect } from 'bun:test'
import { inRange, classifyRel, mergeByLastSeen, crateCandidates } from '../src/blackboard/beliefs.js'
import type { SelfBelief } from '../src/blackboard/beliefs.js'
import type { Tile, AgentObs } from '../src/types/perception.js'

const self: SelfBelief = { id: 'me', name: 'me', teamId: 'A', pos: { x: 5, y: 5 }, score: 0, carrying: [] }

test('inRange uses Manhattan distance, inclusive of obs', () => {
  expect(inRange({ x: 0, y: 0 }, { x: 3, y: 2 }, 5)).toBe(true) // 5 <= 5
  expect(inRange({ x: 0, y: 0 }, { x: 3, y: 3 }, 5)).toBe(false) // 6 > 5
  expect(inRange({ x: 0, y: 0 }, { x: 0, y: 0 }, 0)).toBe(true) // 0 <= 0
})

test('classifyRel: same teamId is partner, different is enemy', () => {
  const partner: AgentObs = { id: 'p', name: 'p', teamId: 'A', pos: { x: 1, y: 1 }, score: 0 }
  const enemy: AgentObs = { id: 'e', name: 'e', teamId: 'B', pos: { x: 2, y: 2 }, score: 0 }
  expect(classifyRel(self, partner)).toBe('partner')
  expect(classifyRel(self, enemy)).toBe('enemy')
})

test('mergeByLastSeen: higher tick wins, equal prefers incoming, undefined takes incoming', () => {
  const a = { lastSeen: 5, v: 'old' }
  const b = { lastSeen: 7, v: 'new' }
  expect(mergeByLastSeen(a, b)).toBe(b) // 7 > 5
  expect(mergeByLastSeen(b, a)).toBe(b) // 5 < 7 keeps existing
  const eq = { lastSeen: 7, v: 'incoming' }
  expect(mergeByLastSeen(b, eq)).toBe(eq) // equal -> incoming
  expect(mergeByLastSeen(undefined, a)).toBe(a)
})

test('crateCandidates returns adjacent slide/crateSpawner tiles only', () => {
  const tiles: Tile[] = [
    { pos: { x: 4, y: 5 }, type: 'slide' }, // left  -> candidate
    { pos: { x: 6, y: 5 }, type: 'crateSpawner' }, // right -> candidate
    { pos: { x: 5, y: 4 }, type: 'walkable' }, // up    -> no
    { pos: { x: 5, y: 6 }, type: 'wall' }, // down  -> no
  ]
  const index = new Map(tiles.map((t) => [`${t.pos.x},${t.pos.y}`, t]))
  const out = crateCandidates(index, { x: 5, y: 5 })
  expect(out).toEqual([{ x: 6, y: 5 }, { x: 4, y: 5 }])
})
