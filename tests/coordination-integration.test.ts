// tests/coordination-integration.test.ts
// Task 12: two-agent integration test verifying that two BDI loops divide a
// parcel field with no double-chase.  Both replicas run identical deterministic
// runAuction on sorted inputs (DESIGN §9.3).  When ticked in parallel at the
// same epoch, same-epoch conflicts on both parcels are resolved by lower agentId:
// 'courier' < 'liaison' (lexicographic), so courier wins p1 and liaison wins p2.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore, isClaimMsg } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

// ── map & constants ────────────────────────────────────────────────────────────
//   x=0  : delivery  (courier delivery zone)
//   x=1..10: walkable
//   x=11 : delivery  (liaison delivery zone)

const CONSTS: GameConsts = {
  CLOCK: 50,
  MOVEMENT_DURATION: 50,
  OBS_DISTANCE: 20,
  PARCEL_DECAY_TICKS: 100,
  PARCEL_DECAY_RAW: '5s',
  PENALTY: 0,
}

function makeMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 10; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  tiles.push({ pos: { x: 11, y: 0 }, type: 'delivery' })
  return tiles
}

// ── fake client helper ─────────────────────────────────────────────────────────

function fakeClient(
  role: 'courier' | 'liaison',
  map: Tile[],
): { moves: string[]; client: DeliverooClient } {
  const rec = { moves: [] as string[], client: null as unknown as DeliverooClient }
  rec.client = {
    role,
    consts: CONSTS,
    map,
    tick: () => 0,
    onPerception: () => {},
    onConnect: () => {},
    onDisconnect: () => {},
    move: async (dir: string): Promise<Pos | false> => {
      rec.moves.push(dir)
      return { x: 0, y: 0 } as Pos
    },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> =>
      (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {},
    say: async () => 'successful' as const,
    ask: async () => ({}),
    shout: async () => ({}),
    close: () => {},
  }
  return rec
}

// ── noop logger ────────────────────────────────────────────────────────────────

const noopLog = { info: () => {}, debug: () => {}, warn: () => {} }

// ── test ───────────────────────────────────────────────────────────────────────

test(
  'two agents divide the field: no double-chase, each parcel claimed by exactly one agent',
  async () => {
    const map = makeMap()

    const courierRec = fakeClient('courier', map)
    const liaisonRec = fakeClient('liaison', map)

    // Cross-wire: each loop's send() feeds the other's ClaimStore
    const courierClaims = new ClaimStore()
    const liaisonClaims = new ClaimStore()

    const courierLoop = new BdiLoop(
      courierRec.client,
      DEFAULT_PARAMS,
      noopLog,
      courierClaims,
      {
        partner: 'liaison',
        send: (msg: A2AMessage) => {
          if (msg.type === 'claims' && isClaimMsg(msg.payload)) {
            liaisonClaims.applyMsg(msg.payload, 'courier')
          }
        },
      },
    )

    const liaisonLoop = new BdiLoop(
      liaisonRec.client,
      DEFAULT_PARAMS,
      noopLog,
      liaisonClaims,
      {
        partner: 'courier',
        send: (msg: A2AMessage) => {
          if (msg.type === 'claims' && isClaimMsg(msg.payload)) {
            courierClaims.applyMsg(msg.payload, 'liaison')
          }
        },
      },
    )

    // courier at x=1, sees liaison at x=10; two parcels at x=2 and x=9
    const courierSnap = (tick: number): PerceptionSnapshot => ({
      tick,
      self: { id: 'courier', name: 'courier', teamId: 'T', pos: { x: 1, y: 0 }, score: 0 },
      agents: [{ id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 10, y: 0 }, score: 0 }],
      parcels: [
        { id: 'p1', pos: { x: 2, y: 0 }, reward: 10, carriedBy: null },
        { id: 'p2', pos: { x: 9, y: 0 }, reward: 10, carriedBy: null },
      ],
      crates: [],
    })

    // liaison at x=10, sees courier at x=1; same two parcels
    const liaisonSnap = (tick: number): PerceptionSnapshot => ({
      tick,
      self: { id: 'liaison', name: 'liaison', teamId: 'T', pos: { x: 10, y: 0 }, score: 0 },
      agents: [{ id: 'courier', name: 'courier', teamId: 'T', pos: { x: 1, y: 0 }, score: 0 }],
      parcels: [
        { id: 'p1', pos: { x: 2, y: 0 }, reward: 10, carriedBy: null },
        { id: 'p2', pos: { x: 9, y: 0 }, reward: 10, carriedBy: null },
      ],
      crates: [],
    })

    // Tick both loops twice (tick 1, then tick 2)
    await Promise.all([courierLoop.tick(courierSnap(1)), liaisonLoop.tick(liaisonSnap(1))])
    await Promise.all([courierLoop.tick(courierSnap(2)), liaisonLoop.tick(liaisonSnap(2))])

    // After two ticks with cross-wired stores, both stores must converge:
    //   p1 (x=2, near courier at x=1) → courier
    //   p2 (x=9, near liaison at x=10) → liaison
    expect(courierClaims.claimedBy('p1')).toBe('courier')
    expect(courierClaims.claimedBy('p2')).toBe('liaison')
    // Both replicas agree
    expect(liaisonClaims.claimedBy('p1')).toBe('courier')
    expect(liaisonClaims.claimedBy('p2')).toBe('liaison')

    // Movement assertions: courier (x=1) steps right toward p1 (x=2);
    // liaison (x=10) steps left toward p2 (x=9). Both have claimed parcels
    // by tick 2, so movement is guaranteed (not optional).
    expect(courierRec.moves.length).toBeGreaterThan(0)
    expect(courierRec.moves.every((d) => d === 'right')).toBe(true)
    expect(liaisonRec.moves.length).toBeGreaterThan(0)
    expect(liaisonRec.moves.every((d) => d === 'left')).toBe(true)
  },
)
