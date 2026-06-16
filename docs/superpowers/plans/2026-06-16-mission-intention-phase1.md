# Mission Intention — Phase 1: U_mission core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a parked `CANDIDATE_INTENTION` coordinate mission compete in the BDI intention selector via `U_mission` (DESIGN §5.5), so the Liaison diverts to a +payoff target tile exactly when it beats route/explore/idle.

**Architecture:** A new `U_mission` candidate (Liaison only) reads the active mission from a local `TeamMissionView` fed by the `MissionSlot`'s new `onChange` hook. `uMission` implements the §5.5 formula for a coordinate target (`V_plan=0`, binary `P_feasible`, `P_FEASIBLE_MIN` floor, deadline urgency, rate ceiling). A per-agent `DeliveryRateTracker` supplies `ρ_ref` for the ceiling. No replication, no shapers, no A* changes — those are Phases 2 and 3.

**Tech Stack:** Bun + `bun:test`, TypeScript `strict`, ESM with `.js` import extensions, Pino logging. Spec: `docs/superpowers/specs/2026-06-16-mission-intention-design.md` (§3, §5).

---

## Key facts the engineer must know before starting

- **Tests live in `tests/`** (not colocated), run with `bun test`. Import source with `.js` extensions. Style: `import { test, expect } from 'bun:test'` (see `tests/bdi-loop.test.ts`, `tests/bdi-params.test.ts`).
- **`Mission` type** is `src/mission/kinds.ts`: `{ kind, payoff, abstractIntent, params, sub?, theta?, deadline?, ..., id, rawText, status }`. `params.targetTile` is a `TileSlot = { tag:'TEXT_BOUND'; x; y } | { tag:'RUNTIME_BOUND'; rule }`.
- **`Candidate`/`Intention`** are `src/bdi/intentions.ts`. `select(cands, committed, hCommit)` skips any candidate with `u <= 0` and applies `(1+hCommit)` to the committed-matching one.
- **`BdiLoop`** (`src/bdi/loop.ts`) constructor today: `(client, params, log, claims=new ClaimStore(), coord?)`. Its `dist(a,b)` is a per-tick memoised push-aware A* length (`Infinity` if unreachable). `act(chosen, beliefs, ctx, tnow)` dispatches the chosen intention; `doDeliver` is where own putDowns happen.
- **`MissionSlot`** (`src/mission/slot.ts`) has `install`/`current`/`supersede`/`epoch`; no change-hook yet.
- **No `console.log`** — use the injected Pino logger.
- **Strict TS, no `any`.** Validate `unknown` at boundaries with hand-written guards.

## File structure (this phase)

```
src/bdi/
  rate-tracker.ts        # DeliveryRateTracker: windowed reward/tick → rhoRef()/uForgone()
  mission-intention.ts   # uMission(...): Candidate | null — §5.5 for a coordinate target
  intentions.ts          # (modify) add { kind:'mission'; mission } variant + matches case
  params.ts              # (modify) add theta_mission, c, p_feasible_min, rate_window, rate_bootstrap
  loop.ts                # (modify) own a DeliveryRateTracker; build U_mission candidate (Liaison);
                         #          act() steps to targetTile + onSatisfied; feed tracker in doDeliver
src/mission/
  view.ts                # TeamMissionView: set(m|null) / current() (accessors grow in Phase 2)
  slot.ts                # (modify) optional onChange callback fired on install/supersede
src/agents/
  liaison.ts             # (modify) wire view + slot.onChange + pass mission ctx into BdiLoop
tests/
  rate-tracker.test.ts
  mission-intention.test.ts
  mission-view.test.ts
  mission-slot.test.ts          # (extend) onChange hook
  bdi-intentions.test.ts        # (extend) mission variant + matches
  bdi-params.test.ts            # (extend) new param defaults
  bdi-loop-mission.test.ts      # loop integration: divert to target, courier ignores
```

---

## Task 1: `DeliveryRateTracker` — windowed own-delivery rate

**Files:**
- Create: `src/bdi/rate-tracker.ts`
- Test: `tests/rate-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rate-tracker.test.ts
import { test, expect } from 'bun:test'
import { DeliveryRateTracker } from '../src/bdi/rate-tracker.js'

test('returns the bootstrap rate before any sample', () => {
  const t = new DeliveryRateTracker(5, 2)
  expect(t.uForgone()).toBe(2)
  expect(t.rhoRef()).toBe(2)
})

test('first delivery sets the clock but yields no sample', () => {
  const t = new DeliveryRateTracker(5, 2)
  t.record(10, 0) // no prior tick → no rate sample yet
  expect(t.uForgone()).toBe(2) // still bootstrap
})

test('computes reward/tick samples between deliveries', () => {
  const t = new DeliveryRateTracker(5, 0.1)
  t.record(0, 0)   // clock = 0
  t.record(10, 5)  // 10 pts over 5 ticks → 2.0
  t.record(20, 15) // 20 pts over 10 ticks → 2.0
  expect(t.uForgone()).toBeCloseTo(2.0, 6) // mean of [2,2]
  expect(t.rhoRef()).toBeCloseTo(2.0, 6)   // p90 of [2,2]
})

test('rhoRef is the 90th percentile, uForgone the mean', () => {
  const t = new DeliveryRateTracker(10, 0)
  // samples: deliver 1 pt every 1 tick (rate 1), except one fat 10-pt/1-tick (rate 10)
  let tick = 0
  t.record(0, tick)
  for (let i = 0; i < 9; i++) { tick += 1; t.record(1, tick) } // nine rate-1 samples
  tick += 1; t.record(10, tick) // one rate-10 sample
  expect(t.uForgone()).toBeCloseTo((9 * 1 + 10) / 10, 6) // mean = 1.9
  expect(t.rhoRef()).toBeGreaterThan(t.uForgone())        // p90 picks up the high tail
})

test('window evicts old samples (FIFO)', () => {
  const t = new DeliveryRateTracker(2, 0)
  t.record(0, 0)
  t.record(2, 1)  // rate 2
  t.record(2, 2)  // rate 2
  t.record(100, 3) // rate 100 — window holds only the last 2 samples [2, 100]
  expect(t.uForgone()).toBeCloseTo(51, 6)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/rate-tracker.test.ts`
Expected: FAIL — `Cannot find module '../src/bdi/rate-tracker.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/bdi/rate-tracker.ts
// Per-agent running average of OWN realised delivery rate (reward/tick), windowed.
// Feeds U_mission's rate ceiling (ρ_ref, §5.5) and §7.1's toll exchange rate (ū_forgone).
// Open-loop exception (§1): own pickups/putDowns are ground truth, so this is measurable at
// runtime even though mission payoffs are not. No replication — each agent tracks itself.

export class DeliveryRateTracker {
  private readonly samples: number[] = []
  private lastTick: number | null = null

  /**
   * @param window  max retained reward/tick samples (FIFO eviction)
   * @param bootstrap rate returned until at least one sample exists
   */
  constructor(private readonly window: number, private readonly bootstrap: number) {}

  /** Record a delivery of `reward` points at absolute tick `tnow`. */
  record(reward: number, tnow: number): void {
    if (this.lastTick !== null && tnow > this.lastTick) {
      this.samples.push(reward / (tnow - this.lastTick))
      while (this.samples.length > this.window) this.samples.shift()
    }
    this.lastTick = tnow
  }

  /** Mean reward/tick (ū_forgone, §7.1). Bootstrap until a sample exists. */
  uForgone(): number {
    if (this.samples.length === 0) return this.bootstrap
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length
  }

  /** 90th-percentile reward/tick (ρ_ref, §5.5). Bootstrap until a sample exists. */
  rhoRef(): number {
    if (this.samples.length === 0) return this.bootstrap
    const sorted = [...this.samples].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))
    return sorted[Math.max(0, idx)]!
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/rate-tracker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bdi/rate-tracker.ts tests/rate-tracker.test.ts
git commit -m "feat(bdi): windowed own-delivery rate tracker (rho_ref/u_forgone) (§5.5/§7.1)"
```

---

## Task 2: Params — mission tunables

**Files:**
- Modify: `src/bdi/params.ts`
- Test: `tests/bdi-params.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/bdi-params.test.ts`:

```ts
test('mission defaults are present and sane', () => {
  expect(DEFAULT_PARAMS.theta_mission).toBeGreaterThan(0)
  expect(DEFAULT_PARAMS.c).toBe(1.5)            // §5.5 rate-ceiling factor
  expect(DEFAULT_PARAMS.p_feasible_min).toBe(0.3) // §12 floor
  expect(DEFAULT_PARAMS.rate_window).toBeGreaterThan(0)
  expect(DEFAULT_PARAMS.rate_bootstrap).toBeGreaterThan(0)
})

test('out-of-range mission param throws', () => {
  expect(() => loadParams(tmpFile('p_feasible_min: 2.0\n'))).toThrow(/p_feasible_min/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-params.test.ts`
Expected: FAIL — `theta_mission` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/bdi/params.ts`, add to the `Params` interface (after `partner_lost_ticks`):

```ts
  theta_mission: number      // global mission utility weight (θ_mission, §5.5)
  c: number                  // rate-ceiling factor in U_mission (§5.5)
  p_feasible_min: number     // mission dropped below this feasibility (§5.5/§12)
  rate_window: number        // retained reward/tick samples in DeliveryRateTracker
  rate_bootstrap: number     // delivery rate used before any sample exists
```

Add to `DEFAULT_PARAMS` (after `partner_lost_ticks: 25,`):

```ts
  theta_mission: 1.0,
  c: 1.5,
  p_feasible_min: 0.3,
  rate_window: 20,
  rate_bootstrap: 0.5,
```

Add to `RANGES` (after `partner_lost_ticks: [1, 100000],`):

```ts
  theta_mission: [0, 4],
  c: [0, 10],
  p_feasible_min: [0, 1],
  rate_window: [1, 1000],
  rate_bootstrap: [0, 100],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-params.test.ts`
Expected: PASS (all, incl. the 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/bdi/params.ts tests/bdi-params.test.ts
git commit -m "feat(bdi): add mission utility params (theta_mission, c, p_feasible_min, rate_*) (§5.5)"
```

---

## Task 3: `uMission` — the §5.5 formula for a coordinate target

**Files:**
- Create: `src/bdi/mission-intention.ts`
- Test: `tests/mission-intention.test.ts`

The candidate is built only for a `CANDIDATE_INTENTION` whose `params.targetTile` is `TEXT_BOUND`. Returns `null` (not a low-`u` candidate) when below the feasibility floor, unreachable, or non-positive — `null` documents "not a candidate this tick" and avoids hysteresis churn.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-intention.test.ts
import { test, expect } from 'bun:test'
import { uMission } from '../src/bdi/mission-intention.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { assembleMission, type MissionDraft } from '../src/mission/kinds.js'
import type { Pos } from '../src/types/perception.js'

const self: Pos = { x: 0, y: 0 }
// dist = manhattan; unreachable tiles flagged by a sentinel coordinate (x<0).
const dist = (a: Pos, b: Pos): number => (b.x < 0 ? Infinity : Math.abs(a.x - b.x) + Math.abs(a.y - b.y))

function coordMission(over: Partial<MissionDraft> = {}, x = 3, y = 0): ReturnType<typeof assembleMission> {
  const draft: MissionDraft = {
    kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go',
    params: { targetTile: { tag: 'TEXT_BOUND', x, y } }, ...over,
  }
  return assembleMission(draft, 'raw', 'm-1')
}

test('a reachable positive coordinate mission is a candidate', () => {
  const c = uMission(coordMission(), self, dist, 0, 1.0, DEFAULT_PARAMS)
  expect(c).not.toBeNull()
  expect(c!.intention.kind).toBe('mission')
  expect(c!.u).toBeGreaterThan(0)
})

test('an unreachable target is dropped (P_feasible = 0)', () => {
  expect(uMission(coordMission({}, -1, 0), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('a non-positive payoff never wins', () => {
  expect(uMission(coordMission({ payoff: -10 }), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
  expect(uMission(coordMission({ payoff: 0 }), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('a non-coordinate or runtime-bound mission yields no candidate', () => {
  const shaper = assembleMission({ kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'x', params: {} }, 'r', 'm-2')
  expect(uMission(shaper, self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
  const runtime = assembleMission({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'x', params: { targetTile: { tag: 'RUNTIME_BOUND', rule: 'leftmost' } } }, 'r', 'm-3')
  expect(uMission(runtime, self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('the rate ceiling clamps a hallucinated payoff to c·rho_ref', () => {
  const huge = uMission(coordMission({ payoff: 1_000_000 }), self, dist, 0, 1.0, DEFAULT_PARAMS)
  expect(huge!.u).toBeCloseTo(DEFAULT_PARAMS.c * 1.0, 6) // min(raw, c·rhoRef) = 1.5
})

test('a passed deadline drops the mission (s_m < 0)', () => {
  // target 3 away, deadline at tick 1, now tick 0 → s_m = 1 - 0 - 3 = -2 < 0
  expect(uMission(coordMission({ deadline: 1 }), self, dist, 0, 1.0, DEFAULT_PARAMS)).toBeNull()
})

test('deadline urgency raises u as slack tightens', () => {
  // far deadline: completion rate dominates; tight deadline: shadow term dominates → higher u.
  const far = uMission(coordMission({ deadline: 1000 }), self, dist, 0, 1.0, { ...DEFAULT_PARAMS, c: 1000 })
  const tight = uMission(coordMission({ deadline: 4 }), self, dist, 0, 1.0, { ...DEFAULT_PARAMS, c: 1000 })
  expect(tight!.u).toBeGreaterThan(far!.u)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-intention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/bdi/mission-intention.ts
// U_mission(m) for a CANDIDATE_INTENTION coordinate target (DESIGN §5.5). V_plan = 0 this slice
// (no parcels delivered by the plan), so the value scale is the signed payoff alone. Returns null
// when the mission is not a candidate this tick (wrong kind/slot, unreachable, below the
// P_FEASIBLE_MIN floor, deadline passed, or non-positive) — distinct from a low-u candidate, so it
// never churns the §5.6 commitment hysteresis.

import type { Pos } from '../types/perception.js'
import type { Params } from './params.js'
import type { Candidate } from './intentions.js'
import type { Mission } from '../mission/kinds.js'

type Dist = (a: Pos, b: Pos) => number

export function uMission(
  mission: Mission,
  self: Pos,
  dist: Dist,
  tnow: number,
  rhoRef: number,
  params: Params,
): Candidate | null {
  const t = mission.params.targetTile
  if (mission.kind !== 'CANDIDATE_INTENTION' || t === undefined || t.tag !== 'TEXT_BOUND') return null

  const target: Pos = { x: t.x, y: t.y }
  const Lm = dist(self, target)
  const pFeasible = Number.isFinite(Lm) ? 1 : 0           // binary reachability (§5.5)
  if (pFeasible < params.p_feasible_min) return null       // floor: unreachable ⇒ out (§12)

  const sm = mission.deadline === undefined ? Infinity : mission.deadline - tnow - Lm
  if (sm < 0) return null                                  // deadline unreachable ⇒ P_feasible 0 (§4.3)

  const theta = mission.theta ?? params.theta_mission
  const value = mission.payoff                             // + V_plan (=0 this slice)
  const completion = 1 / Math.pow(Lm + 1, params.alpha)
  const shadow = sm === Infinity ? 0 : 1 / Math.pow(sm + 1, params.alpha)
  const urgency = Math.max(completion, shadow)             // §5.5 deadline urgency

  const raw = theta * pFeasible * value * urgency
  const u = Math.min(raw, params.c * rhoRef)               // open-loop rate ceiling (§5.5)
  if (u <= 0) return null                                  // negative/zero payoff never wins
  return { intention: { kind: 'mission', mission }, u }
}
```

> This imports `Candidate`/`Intention` from `intentions.ts`, which gains the `'mission'` variant in Task 4. Implement Task 4 if `tsc` complains about the `kind:'mission'` literal; the tests in this task only need the runtime behaviour. Run Tasks 3 and 4 together if your worker type-checks between tasks.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-intention.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bdi/mission-intention.ts tests/mission-intention.test.ts
git commit -m "feat(bdi): U_mission for coordinate intentions (§5.5)"
```

---

## Task 4: Intention selector — the `'mission'` variant

**Files:**
- Modify: `src/bdi/intentions.ts`
- Test: `tests/bdi-intentions.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/bdi-intentions.test.ts`:

```ts
import { assembleMission } from '../src/mission/kinds.js'

const mk = (id: string) => assembleMission({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 1, y: 0 } } }, 'raw', id)

test('matches: same mission id matches, different id does not', () => {
  const a = { kind: 'mission', mission: mk('m-1') } as const
  const b = { kind: 'mission', mission: mk('m-1') } as const
  const c = { kind: 'mission', mission: mk('m-2') } as const
  expect(matches(a, b)).toBe(true)
  expect(matches(a, c)).toBe(false)
})

test('select picks a dominating mission candidate', () => {
  const chosen = select([
    { intention: { kind: 'idle' }, u: 0.001 },
    { intention: { kind: 'mission', mission: mk('m-1') }, u: 5 },
  ], null, 0.15)
  expect(chosen.intention.kind).toBe('mission')
})
```

Ensure `matches` and `select` are imported at the top of the file (they are, in the existing suite — add `assembleMission` import only if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-intentions.test.ts`
Expected: FAIL — `'mission'` not assignable to `Intention` / `matches` has no mission case.

- [ ] **Step 3: Write the implementation**

In `src/bdi/intentions.ts`:

Add the import at the top:

```ts
import type { Mission } from '../mission/kinds.js'
```

Extend the `Intention` union:

```ts
export type Intention =
  | { kind: 'route'; route: Route }
  | { kind: 'explore'; target: ExploreTarget }
  | { kind: 'mission'; mission: Mission }
  | { kind: 'idle' }
```

In `matches`, add a mission case before the final `return false` (after the `explore` case):

```ts
  if (committed.kind === 'mission' && cand.kind === 'mission') {
    return committed.mission.id === cand.mission.id
  }
```

Update the `select` doc comment header `§9.9 four-candidate argmax (three this slice)` → `§9.9 four-candidate argmax`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-intentions.test.ts`
Expected: PASS (all, incl. the 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/bdi/intentions.ts tests/bdi-intentions.test.ts
git commit -m "feat(bdi): mission intention variant + identity matching (§9.9)"
```

---

## Task 5: `TeamMissionView` — local read model

**Files:**
- Create: `src/mission/view.ts`
- Test: `tests/mission-view.test.ts`

This phase needs only `set`/`current`; the shaper/toll accessors are added in Phase 2.

- [ ] **Step 1: Write the failing test**

```ts
// tests/mission-view.test.ts
import { test, expect } from 'bun:test'
import { TeamMissionView } from '../src/mission/view.js'
import { assembleMission } from '../src/mission/kinds.js'

const mk = (id: string) => assembleMission({ kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x: 1, y: 0 } } }, 'raw', id)

test('starts empty', () => {
  expect(new TeamMissionView().current()).toBeNull()
})

test('set installs and clears the current mission', () => {
  const v = new TeamMissionView()
  v.set(mk('m-1'))
  expect(v.current()?.id).toBe('m-1')
  v.set(null)
  expect(v.current()).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/mission/view.ts
// Local read model of the active mission, as seen by ONE agent's BDI loop. The Liaison feeds it
// from its MissionSlot.onChange; the Courier (Phase 2) feeds it from the replicated a2a 'mission'
// message. The loop reads this — never the slot directly — so both agents share one code path.
// Shaper/toll/filter accessors are added in Phase 2; this phase needs only set/current.

import type { Mission } from './kinds.js'

export class TeamMissionView {
  private mission: Mission | null = null

  set(m: Mission | null): void { this.mission = m }
  current(): Mission | null { return this.mission }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-view.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mission/view.ts tests/mission-view.test.ts
git commit -m "feat(mission): TeamMissionView local read model (set/current)"
```

---

## Task 6: `MissionSlot` — onChange hook

**Files:**
- Modify: `src/mission/slot.ts`
- Test: `tests/mission-slot.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/mission-slot.test.ts`:

```ts
test('onChange fires with the current mission on install and supersede', () => {
  const seen: Array<string | null> = []
  const s = new MissionSlot((m) => seen.push(m?.id ?? null))
  s.install(mk('a'))
  s.install(mk('b'))
  s.supersede()
  expect(seen).toEqual(['a', 'b', null])
})

test('no onChange callback is safe', () => {
  const s = new MissionSlot()
  expect(() => { s.install(mk('a')); s.supersede() }).not.toThrow()
})
```

(`mk` and `MissionSlot` are already imported at the top of the existing file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mission-slot.test.ts`
Expected: FAIL — `MissionSlot` constructor takes no argument; `onChange` never fires.

- [ ] **Step 3: Write the implementation**

Replace the `MissionSlot` class in `src/mission/slot.ts`:

```ts
import type { Mission } from './kinds.js'

export class MissionSlot {
  private slot: Mission | null = null
  private gen = 0

  // onChange fires after every slot mutation with the new current() value — the seam the Liaison
  // uses to mirror the slot into its TeamMissionView (and, Phase 2, broadcast to the Courier).
  constructor(private readonly onChange?: (m: Mission | null) => void) {}

  install(m: Mission): void {
    if (this.slot) this.teardown(this.slot)
    this.slot = m
    this.gen++
    this.onChange?.(this.slot)
  }

  current(): Mission | null { return this.slot }

  supersede(): void {
    if (this.slot) {
      this.slot.status = 'SUPERSEDED'
      this.teardown(this.slot)
      this.slot = null
      this.gen++
      this.onChange?.(this.slot)
    }
  }

  epoch(): number { return this.gen }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private teardown(_m: Mission): void {
    // #3/#5: release reward shapers, A* tolls, MISSION parcel locks (§9.10), open contracts.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mission-slot.test.ts`
Expected: PASS (all, incl. the 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/mission/slot.ts tests/mission-slot.test.ts
git commit -m "feat(mission): MissionSlot onChange hook for view mirroring"
```

---

## Task 7: Wire `U_mission` into the BDI loop

**Files:**
- Modify: `src/bdi/loop.ts`
- Test: `tests/bdi-loop-mission.test.ts`

The loop gains an optional `mission` context (6th constructor arg). When `mission.pursue` is true and the view holds a mission, it builds the `U_mission` candidate; `act()` steps toward the `targetTile` and calls `onSatisfied` on arrival. The loop owns a `DeliveryRateTracker` fed in `doDeliver`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/bdi-loop-mission.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { assembleMission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

interface Recorder { moves: string[]; client: DeliverooClient }
function fakeClient(map: Tile[], role: 'liaison' | 'courier'): Recorder {
  const rec: Recorder = { moves: [], client: null as never }
  rec.client = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}

// self at (1,0); empty world (no parcels, no spawners) → route/explore both null.
const snap = (): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 1, y: 0 }, score: 0 },
  parcels: [], agents: [], crates: [],
})

const coordMission = (x: number) => assembleMission(
  { kind: 'CANDIDATE_INTENTION', payoff: 100, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x, y: 0 } } },
  'raw', 'm-1',
)

const log = { info: () => {}, debug: () => {}, warn: () => {} }

test('Liaison diverts toward the mission target tile', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const view = new TeamMissionView()
  view.set(coordMission(4)) // target right of self
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  await loop.tick(snap())
  expect(rec.moves).toEqual(['right'])
})

test('arriving at the target satisfies the mission (onSatisfied fires)', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const view = new TeamMissionView()
  let satisfied = 0
  view.set(coordMission(1)) // target == self position (1,0)
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true, onSatisfied: () => { satisfied++ } })
  await loop.tick(snap())
  expect(satisfied).toBe(1)
  expect(rec.moves.length).toBe(0)
})

test('a pursue:false loop (Courier) never chases the coordinate target', async () => {
  const rec = fakeClient(rowMap(), 'courier')
  const view = new TeamMissionView()
  view.set(coordMission(4))
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: false })
  await loop.tick(snap())
  expect(rec.moves.length).toBe(0) // no mission candidate → idle
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bdi-loop-mission.test.ts`
Expected: FAIL — `BdiLoop` takes no 6th argument / no mission candidate built.

- [ ] **Step 3: Write the implementation**

In `src/bdi/loop.ts`:

Add imports (with the other `./` imports near the top):

```ts
import { uMission } from './mission-intention.js'
import { DeliveryRateTracker } from './rate-tracker.js'
import type { TeamMissionView } from '../mission/view.js'
```

Add a class field (with the other private fields, before the constructor):

```ts
  private readonly rateTracker: DeliveryRateTracker
```

Add the 6th constructor parameter (after `coord?`):

```ts
    private readonly mission?: { view: TeamMissionView; pursue: boolean; onSatisfied?: () => void },
```

At the end of the constructor body (after `this.spawners = ...`):

```ts
    this.rateTracker = new DeliveryRateTracker(params.rate_window, params.rate_bootstrap)
```

In `tick`, build the mission candidate. Insert immediately **before** the idle push (`cands.push({ intention: { kind: 'idle' }, ... })`):

```ts
    if (this.mission?.pursue) {
      const m = this.mission.view.current()
      if (m !== null) {
        const mc = uMission(m, self, dist, tnow, this.rateTracker.rhoRef(), this.params)
        if (mc !== null) cands.push(mc)
      }
    }
```

In `act`, handle the mission intention. Insert at the **top** of `act`, right after `if (chosen.kind === 'idle') return`:

```ts
    if (chosen.kind === 'mission') {
      const t = chosen.mission.params.targetTile
      // uMission only emits a candidate for a TEXT_BOUND target, so this is safe.
      if (t === undefined || t.tag !== 'TEXT_BOUND') return
      const target: Pos = { x: t.x, y: t.y }
      const here = beliefs.self.pos
      if (here.x === target.x && here.y === target.y) {
        this.mission?.onSatisfied?.()
        return
      }
      await this.stepToward(beliefs, ctx, here, target)
      return
    }
```

In `doDeliver`, feed the realised reward into the tracker. After `beliefs.applyDelivery(ids)` inside the `try`:

```ts
      this.rateTracker.record(bundle.value, tnow)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bdi-loop-mission.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + type-check**

Run: `bun test`
Expected: PASS — all existing suites plus the new ones.

Run: `bunx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/bdi/loop.ts tests/bdi-loop-mission.test.ts
git commit -m "feat(bdi): build U_mission candidate + pursue coordinate target in the loop (§5.5/§9.9)"
```

---

## Task 8: Wire the Liaison

**Files:**
- Modify: `src/agents/liaison.ts`

The Liaison constructs a `TeamMissionView`, connects it to the slot via `onChange`, points the slot's teardown at `supersede`, and passes the mission context into `BdiLoop`. (Broadcasting to the Courier is Phase 2 — this phase the Courier is unchanged.)

- [ ] **Step 1: Read the current file**

Run: read `src/agents/liaison.ts` fully (already wired for the mission lane — `missionSlot`, `intake`, `BdiLoop`).

- [ ] **Step 2: Apply the wiring**

Add the import (with the other `../mission/*` imports):

```ts
import { TeamMissionView } from '../mission/view.js'
```

Replace the `const missionSlot = new MissionSlot()` line with:

```ts
  const missionView = new TeamMissionView()
  const missionSlot = new MissionSlot((m) => missionView.set(m))
```

Replace the `BdiLoop` construction with the mission context as the 6th arg:

```ts
  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'courier',
    send,
  }, {
    view: missionView,
    pursue: true,
    onSatisfied: () => missionSlot.supersede(),
  })
```

- [ ] **Step 3: Type-check + full suite**

Run: `bunx tsc --noEmit`
Expected: no type errors.

Run: `bun test`
Expected: PASS — all suites.

- [ ] **Step 4: Commit**

```bash
git add src/agents/liaison.ts
git commit -m "feat(liaison): wire MissionSlot -> TeamMissionView -> BdiLoop U_mission (Phase 1)"
```

---

## Self-review notes (resolved)

- **Spec coverage (Phase 1 scope):** §5.5 `U_mission` for a coordinate target — Tasks 3,4,7; `P_feasible` binary + `P_FEASIBLE_MIN` floor — Task 3; deadline urgency/`s_m` — Task 3; rate ceiling `min(·,c·ρ_ref)` with a real tracker (decision A2) — Tasks 1,3,7; Liaison-pursues-no-bid (decision A3) — Task 7 (`pursue` flag), Task 8 (only Liaison passes `pursue:true`); slot→view seam — Tasks 5,6,8. Shapers (§6), constraints (§7), and team-wide replication (decision A1) are **Phase 2/3** and out of this plan by design.
- **Type consistency:** `uMission(mission, self, dist, tnow, rhoRef, params)` — same signature in Task 3 def and Task 7 call. `Intention` `'mission'` variant (Task 4) used by `uMission` (Task 3) and `matches` (Task 4) and `act` (Task 7). `TeamMissionView.set/current` (Task 5) used by Task 7 (`view.current()`) and Task 8 (`view.set` via `onChange`). `MissionSlot(onChange?)` (Task 6) used by Task 8. `DeliveryRateTracker(window, bootstrap)` with `rhoRef()/uForgone()/record(reward,tnow)` (Task 1) used by Task 7. New params (Task 2) read in Tasks 3,7.
- **No placeholders:** every code step is complete and runnable. The only "read at execution time" note is Task 8 against `liaison.ts`, whose current shape is reproduced in the plan header facts.
- **Deferred deliberately:** `ū_forgone` is implemented in the tracker (Task 1) but only consumed by §7 tolls in Phase 3; it is exercised by Task 1's tests now so Phase 3 inherits a tested primitive.
```
