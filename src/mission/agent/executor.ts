// §17.7 plan-lifecycle state + pure helpers for the AGENT_PLAN step-list executor (slice 2).
// No I/O: the BdiLoop owns the side-effecting moves; this module owns the decisions.

import { planPath, key, type Grid, type PlanCtx, type Dir } from '../../planning/astar.js'
import type { Pos } from '../../types/perception.js'
import type { AgentStep, AgentPlan, Mission } from '../kinds.js'
import type { WorldSnapshot } from './snapshot.js'

// Per-mission execution cursor. suppressedUntil lives on the Mission (it must outlive a null'd
// cursor so the uMission gate keeps holding the branch out of the argmax).
export interface PlanCursor {
  missionId: string
  ptr: number              // index of the current step
  sigAtLanding: string     // worldSignature when the plan landed (born-stale watcher §17.7.2-B)
  ticksNoProgress: number  // anti-phantom counter (§17.7.4)
  blockedCount: number     // consecutive ticks with no positional progress on a transit step (K_block)
  lastDist: number         // manhattan to the current step's goal last tick (progress = it shrank)
  lastSelfPos: Pos         // self position last tick (transit-stall detection)
  waitLeft: number | null  // remaining ticks of an in-progress wait step (null = not waiting)
}

export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

// The tile the agent is heading for this step. wait has no destination (null).
export function goalOf(step: AgentStep, snap: WorldSnapshot): Pos | null {
  switch (step.op) {
    case 'goto': return step.target
    case 'deliver': return step.zone
    case 'pickup': {
      const p = snap.parcels.find((q) => q.id === step.parcelId)
      return p ? p.pos : null
    }
    case 'wait': return null
  }
}

// Born-stale watcher signature: the world OUTSIDE the plan. Excludes own position and the
// parcels the plan references in pickup steps (those are tracked per-step by revalidateStep),
// so executing a step never self-invalidates the plan (DESIGN ~L1488 / §17.8).
export function worldSignature(snap: WorldSnapshot, plan: AgentPlan): string {
  const ref = new Set(plan.steps.filter((s): s is Extract<AgentStep, { op: 'pickup' }> => s.op === 'pickup').map((s) => s.parcelId))
  return [...snap.parcels]
    .filter((p) => !ref.has(p.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${p.pos.x},${p.pos.y}:${p.carriedBy ?? ''}`)
    .join('|')
}

// §17.7.2-D light prefix re-validation of the current step against live (snapshot) state.
export function revalidateStep(step: AgentStep, snap: WorldSnapshot, grid: Grid, ctx: PlanCtx): 'ok' | 'invalid' {
  switch (step.op) {
    case 'goto': {
      const res = planPath(grid, ctx, snap.selfPos, step.target)
      // timedOut is a budget cap, NOT proof of unreachability (§15.3) — do not invalidate on it.
      return res.reachable || res.timedOut ? 'ok' : 'invalid'
    }
    case 'pickup': {
      const p = snap.parcels.find((q) => q.id === step.parcelId)
      if (p === undefined) return 'invalid'
      if (p.carriedBy !== null && p.carriedBy !== 'self') return 'invalid'
      return 'ok'
    }
    case 'deliver':
      return grid.deliveryZones.some((z) => z.x === step.zone.x && z.y === step.zone.y) ? 'ok' : 'invalid'
    case 'wait':
      return 'ok'
  }
}

// Leg-granularity progress (§17.7.4): a ptr advance, a shrinking distance to the next
// waypoint, or a counting-down wait all count as progress.
export function progressed(ptrAdvanced: boolean, prevDist: number, curDist: number, isWaitTick: boolean): boolean {
  return ptrAdvanced || curDist < prevDist || isWaitTick
}

const ahead = (p: Pos, dir: Dir): Pos => {
  if (dir === 'up') return { x: p.x, y: p.y + 1 }
  if (dir === 'down') return { x: p.x, y: p.y - 1 }
  if (dir === 'left') return { x: p.x - 1, y: p.y }
  return { x: p.x + 1, y: p.y }
}

// The first planned tile toward the goal — the tile to mask on a K_block re-plan (§17.7.4).
// null if already at the goal or no path exists.
export function blockingTile(self: Pos, goal: Pos, grid: Grid, ctx: PlanCtx): Pos | null {
  const res = planPath(grid, ctx, self, goal)
  if (res.firstStep === null) return null
  return ahead(self, res.firstStep.dir)
}

export function freshCursor(mission: Mission, sig: string, snap: WorldSnapshot): PlanCursor {
  const step = mission.plan!.steps[0]
  const goal = step ? goalOf(step, snap) : null
  return {
    missionId: mission.id,
    ptr: 0,
    sigAtLanding: sig,
    ticksNoProgress: 0,
    blockedCount: 0,
    lastDist: goal ? manhattan(snap.selfPos, goal) : 0,
    lastSelfPos: snap.selfPos,
    waitLeft: null,
  }
}

// Exported only so callers can reference the obstacle-key form when masking tiles.
export { key as tileKey }
