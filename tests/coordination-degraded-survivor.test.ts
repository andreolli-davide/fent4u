// tests/coordination-degraded-survivor.test.ts
// Regression (final-review finding): Lever B must NOT materialize the phantom
// partner's auction wins as claims in degraded mode (partner lost → partnerSnap
// is a clone at the survivor's own pos). Otherwise the lost partner "owns"
// contested parcels, which are then excluded from the survivor's pool and
// stranded forever. The lone survivor must never leave a parcel owned by the
// absent partner.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 20, PARCEL_DECAY_TICKS: 100, PARCEL_DECAY_RAW: '5s', PENALTY: 0 }

function rowMap(): Tile[] {
  const t: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 11; x++) t.push({ pos: { x, y: 0 }, type: 'walkable' })
  return t
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

test('degraded survivor never strands a parcel on the absent partner', async () => {
  const claims = new ClaimStore()
  // liaison alone; courier (LOWER id, would win equal-position tiebreaks) never perceived.
  const loop = new BdiLoop(fakeClient('liaison', rowMap()), DEFAULT_PARAMS, noopLog, claims, {
    partner: 'courier',
    send: (_m: A2AMessage) => {},
  })
  const snap = (tick: number): PerceptionSnapshot => ({
    tick,
    self: { id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 5, y: 0 }, score: 0 },
    agents: [], // partner never seen → degraded
    parcels: [
      { id: 'A', pos: { x: 3, y: 0 }, reward: 10, carriedBy: null },
      { id: 'B', pos: { x: 7, y: 0 }, reward: 10, carriedBy: null },
    ],
    crates: [],
  })
  for (let t = 1; t <= 5; t++) await loop.tick(snap(t))

  // No parcel may be owned by the absent partner.
  expect(claims.claimedBy('A')).not.toBe('courier')
  expect(claims.claimedBy('B')).not.toBe('courier')
})
