// tests/coordination-partner-liveness.test.ts
// Regression (flapping "partner lost — reclaimed soft claims"): the §9.7/§11
// degradation check resolves the partner in `beliefs.agents`. That map is keyed by
// the SERVER agent id (a UUID from perception / the self-broadcast), but the loop
// looked it up by `coord.partner`, which is the ROLE label ('liaison' | 'courier').
// The lookup therefore ALWAYS missed → partner === null → partnerLive always false →
// every tick the partner held a soft AUCTION claim it was reclaimed, re-broadcast by
// the next auction, and reclaimed again — a continuous flap, with coordination silently
// running solo. The fix resolves the partner by its belief `rel === 'partner'` (the
// unique teammate), independent of the id/role namespace split.
//
// NOTE: the partner here carries a SERVER id ('srv-courier') distinct from its role
// ('courier'). The earlier version of this test used id:'courier', accidentally making
// the role-keyed lookup hit — so it passed while production was broken. Keep them split.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore, type Claim } from '../src/coordination/claims.js'
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

test('partner resolved by rel (server-id keyed) is not declared lost — soft claim survives', async () => {
  const claims = new ClaimStore()
  // Partner ('courier') owns a soft AUCTION claim on an UNPERCEIVED parcel 'Z'.
  // Nothing but the §9.7 reclaim path can drop it (it is never in the pool).
  const seeded: Claim = {
    parcelId: 'Z', agentId: 'courier', origin: 'AUCTION',
    epoch: 1, commitTick: 1, originD: 3, lastD: 3, lastProgressTick: 1,
  }
  claims.add(seeded)

  const loop = new BdiLoop(fakeClient('liaison', rowMap()), DEFAULT_PARAMS, noopLog, claims, {
    partner: 'courier',
    send: (_m: A2AMessage) => {},
  })

  // The partner is perceived with its SERVER id ('srv-courier'), same teamId ⇒ rel=partner —
  // exactly how the real game materializes it. Crucially the server id is NOT the role label.
  const snap = (tick: number): PerceptionSnapshot => ({
    tick,
    self: { id: 'srv-liaison', name: 'liaison', teamId: 'T', pos: { x: 5, y: 0 }, score: 0 },
    agents: [{ id: 'srv-courier', name: 'courier', teamId: 'T', pos: { x: 2, y: 0 }, score: 0 }],
    parcels: [],
    crates: [],
  })

  // Channel alive throughout (partnerAlive=true); run well past partner_lost_ticks (25).
  for (let t = 1; t <= 40; t++) await loop.tick(snap(t), true)

  // The partner's soft claim must NOT be reclaimed/orphaned while it is present & alive.
  expect(claims.claimedBy('Z')).not.toBeNull()
})
