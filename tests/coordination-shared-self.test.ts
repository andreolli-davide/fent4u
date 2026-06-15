// tests/coordination-shared-self.test.ts
// Lever A (§9.7): the coordination commit must use the SHARED self position —
// the value last shipped to the partner (== last tick's self) — not the live
// self, so both replicas auction over identical inputs. Observable proxy: a
// claim's originD is measured from the shared self pos, not the live one.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 20, PARCEL_DECAY_TICKS: 100, PARCEL_DECAY_RAW: '5s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 11; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

function fakeClient(role: 'courier' | 'liaison', map: Tile[]): DeliverooClient {
  return {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (): Promise<Pos | false> => ({ x: 0, y: 0 } as Pos),
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {}, say: async () => 'successful' as const, ask: async () => ({}), shout: async () => ({}), close: () => {},
  } as DeliverooClient
}

const noopLog = { info: () => {}, debug: () => {}, warn: () => {} }

test('coordination commit uses shared (last-tick) self pos for originD, not live self', async () => {
  const map = rowMap()
  const claims = new ClaimStore()
  const loop = new BdiLoop(fakeClient('courier', map), DEFAULT_PARAMS, noopLog, claims, {
    partner: 'liaison',
    send: (_msg: A2AMessage) => {}, // partner store not needed for this assertion
  })

  // Tick 1: self at x=5, partner far at x=11, parcel A at x=2 (courier wins it).
  // After tick 1, prevSelf := x=5.
  const snap1: PerceptionSnapshot = {
    tick: 1,
    self: { id: 'courier', name: 'courier', teamId: 'T', pos: { x: 5, y: 0 }, score: 0 },
    agents: [{ id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 11, y: 0 }, score: 0 }],
    parcels: [{ id: 'A', pos: { x: 2, y: 0 }, reward: 10, carriedBy: null }],
    crates: [],
  }
  await loop.tick(snap1)

  // Tick 2: agent has "moved" to x=9 (live), but the SHARED self pos is still x=5
  // (last tick). New parcel B at x=6. dist(sharedSelf x5, B x6) = 1; dist(live x9, B x6) = 3.
  const snap2: PerceptionSnapshot = {
    tick: 2,
    self: { id: 'courier', name: 'courier', teamId: 'T', pos: { x: 9, y: 0 }, score: 0 },
    agents: [{ id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 11, y: 0 }, score: 0 }],
    parcels: [
      { id: 'A', pos: { x: 2, y: 0 }, reward: 10, carriedBy: null },
      { id: 'B', pos: { x: 6, y: 0 }, reward: 10, carriedBy: null },
    ],
    crates: [],
  }
  await loop.tick(snap2)

  // Tick 1 had no prevSelf, so the `?? self` fallback measured A's originD from
  // the live tick-1 pos x=5 → dist(x5, x2) = 3.
  const claimA = claims.ownClaims('courier').find((c) => c.parcelId === 'A')
  expect(claimA?.originD).toBe(3)

  // Tick 2 used the SHARED self (prevSelf = x5), not live x=9, for B's originD:
  // dist(x5, x6) = 1, not dist(x9, x6) = 3.
  const claimB = claims.ownClaims('courier').find((c) => c.parcelId === 'B')
  expect(claimB?.originD).toBe(1)
})
