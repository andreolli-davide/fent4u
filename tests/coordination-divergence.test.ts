// tests/coordination-divergence.test.ts
// Phase-3 reproduction (systematic-debugging): the §9.3 auction is "leaderless
// deterministic" ONLY when both replicas auction over byte-identical inputs.
// In the live game each agent feeds runAuction its OWN live position but the
// partner's LAST-REPLICATED (stale) position (loop.ts:96). When the two agents
// converge on one parcel from opposite sides, each one's stale view shows the
// OTHER as closer → each assigns the parcel to the partner → each "commits only
// own wins" → NEITHER commits → the parcel is orphaned (claimed by nobody) and
// both walk over it. This test reproduces that orphan.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore, isClaimMsg } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 20, PARCEL_DECAY_TICKS: 100, PARCEL_DECAY_RAW: '5s', PENALTY: 0 }

function makeMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 11; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  tiles.push({ pos: { x: 12, y: 0 }, type: 'delivery' })
  return tiles
}

function fakeClient(role: 'courier' | 'liaison', map: Tile[]): { moves: string[]; client: DeliverooClient } {
  const rec = { moves: [] as string[], client: null as unknown as DeliverooClient }
  rec.client = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir: string): Promise<Pos | false> => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {}, say: async () => 'successful' as const, ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}

const noopLog = { info: () => {}, debug: () => {}, warn: () => {} }

test('stale partner positions orphan a contested parcel (each assigns it to the other)', async () => {
  const map = makeMap()
  const courierRec = fakeClient('courier', map)
  const liaisonRec = fakeClient('liaison', map)
  const courierClaims = new ClaimStore()
  const liaisonClaims = new ClaimStore()

  const courierLoop = new BdiLoop(courierRec.client, DEFAULT_PARAMS, noopLog, courierClaims, {
    partner: 'liaison',
    send: (msg: A2AMessage) => { if (msg.type === 'claims' && isClaimMsg(msg.payload)) liaisonClaims.applyMsg(msg.payload, 'courier') },
  })
  const liaisonLoop = new BdiLoop(liaisonRec.client, DEFAULT_PARAMS, noopLog, liaisonClaims, {
    partner: 'courier',
    send: (msg: A2AMessage) => { if (msg.type === 'claims' && isClaimMsg(msg.payload)) courierClaims.applyMsg(msg.payload, 'liaison') },
  })

  // ONE parcel at x=6. Real positions: courier x=5, liaison x=7 (symmetric, d=1 each).
  // But each agent's REPLICATED view of the partner lags: it last saw the partner AT
  // the parcel (x=6, d=0). So each agent believes the partner is strictly closer.
  const courierSnap: PerceptionSnapshot = {
    tick: 1,
    self: { id: 'courier', name: 'courier', teamId: 'T', pos: { x: 5, y: 0 }, score: 0 },
    agents: [{ id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 6, y: 0 }, score: 0 }], // stale
    parcels: [{ id: 'p', pos: { x: 6, y: 0 }, reward: 10, carriedBy: null }],
    crates: [],
  }
  const liaisonSnap: PerceptionSnapshot = {
    tick: 1,
    self: { id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 7, y: 0 }, score: 0 },
    agents: [{ id: 'courier', name: 'courier', teamId: 'T', pos: { x: 6, y: 0 }, score: 0 }], // stale
    parcels: [{ id: 'p', pos: { x: 6, y: 0 }, reward: 10, carriedBy: null }],
    crates: [],
  }

  await Promise.all([courierLoop.tick(courierSnap), liaisonLoop.tick(liaisonSnap)])

  // §9.3 promises exactly one agent owns each reachable parcel. With stale positions
  // the parcel is orphaned: neither store claims it.
  expect(courierClaims.claimedBy('p')).not.toBeNull()
  expect(liaisonClaims.claimedBy('p')).not.toBeNull()
})
