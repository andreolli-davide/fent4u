// tests/bdi-loop-agent-plan.test.ts
// §17.7 step-list executor: 4 TDD scenarios for BdiLoop.actAgentPlan.
// Harness mirrors bdi-loop-mission.test.ts (fakeClient / rowMap / log).

import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

interface Recorder { moves: string[]; putdowns: string[][]; picks: number; client: DeliverooClient }
function fakeClient(map: Tile[]): Recorder {
  const rec: Recorder = { moves: [], putdowns: [], picks: 0, client: null as never }
  rec.client = {
    role: 'liaison', consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => { rec.picks++; return [{ id: 'p1' }] },
    putdown: async (ids?: string[]): Promise<PickResult[]> => { rec.putdowns.push(ids ?? []); return (ids ?? []).map((id) => ({ id })) },
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}
const log = { info: () => {}, debug: () => {}, warn: () => {} }

// Base snap: NO parcels — mission always wins the argmax (no route candidate).
const snap = (selfX = 1): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: selfX, y: 0 }, score: 0 },
  parcels: [], agents: [], crates: [],
})

// Snap with p1 at reward=0: pAvail>0 but uRoute=0, so mission still wins; p1 is present
// for pickup-step validation in test 2 (revalidateStep sees it as 'ok').
const snapWithParcel = (selfX = 1): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: selfX, y: 0 }, score: 0 },
  parcels: [{ id: 'p1', pos: { x: 3, y: 0 }, reward: 0, carriedBy: null }],
  agents: [], crates: [],
})

// Default AGENT_PLAN: self(1,0) → goto(3,0) → pickup(p1) → goto(0,0) → deliver(0,0).
const makePlan = (): Mission => ({
  kind: 'AGENT_PLAN', payoff: 100, abstractIntent: 'fetch p1 to zone', params: {},
  id: 'ap-1', rawText: 'fetch the parcel and deliver', status: 'CLASSIFIED',
  plan: {
    steps: [
      { op: 'goto', target: { x: 3, y: 0 } },
      { op: 'pickup', parcelId: 'p1' },
      { op: 'goto', target: { x: 0, y: 0 } },
      { op: 'deliver', zone: { x: 0, y: 0 } },
    ],
    L: 6, vPlan: 20,
  },
})

test('AGENT_PLAN executor moves toward the first goto target', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView(); view.set(makePlan())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  await loop.tick(snap(1)) // self (1,0), target (3,0) → step right
  expect(rec.moves).toEqual(['right'])
})

test('on the pickup step at the parcel tile the executor picks up', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView(); view.set(makePlan())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  // p1 visible (reward=0 keeps route u=0, mission wins). Self (3,0): goto target reached →
  // ptr advances to pickup; same tick is fine to just arrive.
  await loop.tick(snapWithParcel(3))
  // second tick still at (3,0): now on the pickup step → pickup fires.
  await loop.tick(snapWithParcel(3))
  expect(rec.picks).toBeGreaterThanOrEqual(1)
})

test('an invalid pickup step (parcel gone) requests a re-plan with rawText', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  // plan whose current step pickups a parcel that is absent from perception
  const m = makePlan(); m.plan!.steps = [{ op: 'pickup', parcelId: 'ghost' }]
  view.set(m)
  const calls: Array<{ raw: string; mask?: Pos[] }> = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, {
    view, pursue: true, requestReplan: (raw, mask) => calls.push({ raw, mask }),
  })
  // snap() has parcels:[] so 'ghost' is absent; mission wins (no route candidate).
  await loop.tick(snap(1))
  expect(calls).toHaveLength(1)
  expect(calls[0]!.raw).toBe('fetch the parcel and deliver')
})

test('completing the last step fires onSatisfied', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  const m = makePlan(); m.plan!.steps = [{ op: 'deliver', zone: { x: 0, y: 0 } }]
  view.set(m)
  let satisfied = 0
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, {
    view, pursue: true, onSatisfied: () => { satisfied++ },
  })
  // self at (0,0) == delivery zone; snap() has no parcels (mission wins); ptr reaches end → onSatisfied.
  await loop.tick(snap(0))
  expect(satisfied).toBe(1)
})

// ─────────────────────────────────────────────────────────────────────────────
// §I1 born-stale debounce tests.
// Harness note: born-stale fires when a NON-target parcel appears/vanishes in
// perception (this changes worldSignature, which excludes plan pickup targets).
// p1 at (3,0) is the plan's pickup target → excluded from worldSignature.
// p2 at (4,0) with reward=0 is a non-target → included in worldSignature.
// reward=0 keeps uRoute=0 so the AGENT_PLAN mission always wins the argmax.
// ─────────────────────────────────────────────────────────────────────────────

// Build a PerceptionSnapshot at an explicit tick with an arbitrary parcel list.
const snapAt = (tick: number, selfX = 1, parcels: Array<{ id: string; pos: Pos; reward?: number; carriedBy?: string | null }> = []): PerceptionSnapshot => ({
  tick,
  self: { id: 'me', name: 'me', teamId: 'A', pos: { x: selfX, y: 0 }, score: 0 },
  parcels: parcels.map((p) => ({ id: p.id, pos: p.pos, reward: p.reward ?? 0, carriedBy: p.carriedBy ?? null })),
  agents: [],
  crates: [],
})

const P1 = { id: 'p1', pos: { x: 3, y: 0 } } // plan's pickup target — excluded from worldSignature
const P2 = { id: 'p2', pos: { x: 4, y: 0 } } // non-target parcel  — included  in worldSignature

test('born-stale re-plans at most once per debounce window', async () => {
  // Discriminator: with replan_debounce_ticks removed (=0) the count equals the
  // number of born-stale ticks (3 replans); with debounce=10 only the first fires.
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  view.set(makePlan())
  const calls: Array<{ raw: string; mask?: Pos[] }> = []
  const params = { ...DEFAULT_PARAMS, replan_debounce_ticks: 10 }
  const loop = new BdiLoop(rec.client, params, log, undefined, undefined, {
    view, pursue: true, requestReplan: (raw, mask) => calls.push({ raw, mask }),
  })

  // tick 0: land cursor, no non-target parcel → sigAtLanding = ""
  await loop.tick(snapAt(0, 1, []))

  // tick 1: p2 appears → sigNow ≠ "" → born-stale → tnow-(-∞)≥10 → REPLAN (call 1); cursor=null, lastReplanTick=1
  await loop.tick(snapAt(1, 1, [P2]))

  // tick 2: p2 gone → new cursor lands with sigAtLanding="" → no stale; executor moves
  await loop.tick(snapAt(2, 1, []))

  // ticks 3-5: p2 churn inside the debounce window (3-1=2 / 4-1=3 / 5-1=4, all <10) → absorb only
  await loop.tick(snapAt(3, 1, [P2]))
  await loop.tick(snapAt(4, 1, []))
  await loop.tick(snapAt(5, 1, [P2]))

  // Exactly ONE replan across the sustained churn window — not one per stale tick.
  expect(calls).toHaveLength(1)
})

test('the executor keeps moving during the debounce window', async () => {
  // Discriminator: a naive "return without acting when debounced" would produce no
  // moves during the absorb ticks; the correct absorb re-baselines sigAtLanding and
  // falls through to the step dispatch so the agent keeps navigating.
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  view.set(makePlan())
  const params = { ...DEFAULT_PARAMS, replan_debounce_ticks: 10 }
  const loop = new BdiLoop(rec.client, params, log, undefined, undefined, { view, pursue: true })

  await loop.tick(snapAt(0, 1, []))             // cursor lands (move right toward (3,0))
  await loop.tick(snapAt(1, 1, [P2]))            // born-stale → replan; no move this tick

  const movesBeforeWindow = rec.moves.length     // snapshot after first replan

  await loop.tick(snapAt(2, 1, []))             // cursor reset, no stale → move
  const movesAfterReset = rec.moves.length

  await loop.tick(snapAt(3, 1, [P2]))            // stale → absorb → should STILL move
  const movesAfterAbsorb1 = rec.moves.length

  await loop.tick(snapAt(4, 1, []))              // stale → absorb → should STILL move
  const movesAfterAbsorb2 = rec.moves.length

  // The agent must have moved on BOTH absorb ticks (not frozen by a premature return).
  expect(movesAfterAbsorb1).toBeGreaterThan(movesAfterReset)
  expect(movesAfterAbsorb2).toBeGreaterThan(movesAfterAbsorb1)
  // And after the reset tick (tick 2) we also moved — belt+suspenders.
  expect(movesAfterReset).toBeGreaterThan(movesBeforeWindow)
})

test('an invalid step re-plans immediately even inside the debounce window', async () => {
  // Discriminator: if the invalid check were gated by the debounce (e.g., both
  // checks merged under a single debounce guard), the invalid replan at tick 3
  // would be absorbed and calls would remain at 1.  With the correct ordering
  // (invalid FIRST, then born-stale rate-limited), calls reaches 2.
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  // Simplified plan: first step is pickup(p1) so it immediately invalidates when p1 vanishes.
  const m = makePlan()
  m.plan!.steps = [{ op: 'pickup', parcelId: 'p1' }, { op: 'deliver', zone: { x: 0, y: 0 } }]
  view.set(m)
  const calls: Array<{ raw: string; mask?: Pos[] }> = []
  const params = { ...DEFAULT_PARAMS, replan_debounce_ticks: 10 }
  const loop = new BdiLoop(rec.client, params, log, undefined, undefined, {
    view, pursue: true, requestReplan: (raw, mask) => calls.push({ raw, mask }),
  })

  // tick 0: p1 present (step valid), no p2 → cursor lands with sigAtLanding=""
  await loop.tick(snapAt(0, 1, [P1]))

  // tick 1: p1 present (step still valid), p2 appears → born-stale → REPLAN (call 1); lastReplanTick=1
  await loop.tick(snapAt(1, 1, [P1, P2]))

  // tick 2: p1 present, p2 still present → cursor reset (sigAtLanding="p2:4,0:"), no stale → moves
  await loop.tick(snapAt(2, 1, [P1, P2]))

  // tick 3 (3-1=2 < 10, inside window): p1 ABSENT → invalid step; ALSO sigNow≠sigAtLanding (p2 gone).
  // Correct: invalid check fires FIRST → REPLAN (call 2) despite being inside the debounce window.
  // Wrong (both checks gated): born-stale debounce absorbs, invalid check never runs → stays at 1.
  await loop.tick(snapAt(3, 1, []))

  expect(calls).toHaveLength(2)
})
