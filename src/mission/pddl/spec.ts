// §17.3/§17.5 — the transcribed PDDL mission spec (the output of the LLM-PDDL transcription, Call 2)
// and its grounding: constraint→mask resolution (§17.5.2 CostOracle / grid-level :init filter) and
// the ValidationGate (§17.5.4). Pure over the grid + region resolver; no LLM, no planner here.

import type { Pos } from '../../types/perception.js'
import type { Grid } from '../../planning/astar.js'
import { resolveRegion } from '../region.js'

// A region reference is either a transcribed literal tile or a symbolic name resolved against the map.
export type RegionRef = { tag: 'TILE'; x: number; y: number } | { tag: 'NAME'; rule: string }

// §17.5.2 masks — the constraint atoms that configure the CostOracle / grid :init:
//  KeepAway: stay ≥ dist from any tile of `of`;  StayOn: only tiles of `region`;  Avoid: never enter.
export interface PddlConstraints {
  keepAway?: Array<{ of: RegionRef; dist: number }>
  stayOn?: RegionRef
  avoid?: RegionRef[]
}

// The task the planner solves. DELIVER_ALL = multi-parcel ordering (§17.2); COVERAGE = visit every
// tile of a region (§17.5.2). `payoff`/`deadline` are transcribed literals feeding U_mission (§5.5).
export type PddlTask =
  | { kind: 'DELIVER_ALL' }
  | { kind: 'COVERAGE'; region: RegionRef }

export interface PddlSpec {
  task: PddlTask
  constraints: PddlConstraints
  payoff: number
  deadline?: number
}

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const posKey = (p: Pos): string => `${p.x},${p.y}`

/** Resolve a RegionRef to concrete tiles (a literal tile → singleton; a name → the region resolver). */
export function resolveRef(grid: Grid, ref: RegionRef): Pos[] {
  return ref.tag === 'TILE' ? [{ x: ref.x, y: ref.y }] : resolveRegion(grid, ref.rule)
}

/**
 * §17.5.2 — turn the constraints into the set of tiles the planner/CostOracle must treat as blocked.
 * Avoid + KeepAway ADD tiles to the mask; StayOn masks the COMPLEMENT of its region. The union is the
 * mask fed to the deliver-all adjacency / grid :init filter and to costPlan (snap.maskTiles).
 */
export function constraintMask(grid: Grid, c: PddlConstraints): Pos[] {
  const masked = new Set<string>()
  const out: Pos[] = []
  const add = (p: Pos): void => { const k = posKey(p); if (!masked.has(k)) { masked.add(k); out.push(p) } }

  for (const a of c.avoid ?? []) for (const t of resolveRef(grid, a)) add(t)

  for (const ka of c.keepAway ?? []) {
    const centers = resolveRef(grid, ka.of)
    if (centers.length === 0) continue
    for (let x = 0; x < grid.w; x++) {
      for (let y = 0; y < grid.h; y++) {
        const t = { x, y }
        if (centers.some((c0) => manhattan(t, c0) <= ka.dist)) add(t)
      }
    }
  }

  if (c.stayOn !== undefined) {
    const keep = new Set(resolveRef(grid, c.stayOn).map(posKey))
    for (let x = 0; x < grid.w; x++) {
      for (let y = 0; y < grid.h; y++) {
        const tt = grid.tiles.get(posKey({ x, y }))
        if (tt !== undefined && tt.type !== 'wall' && !keep.has(posKey({ x, y }))) add({ x, y })
      }
    }
  }
  return out
}

export type GateResult = { ok: true; mask: Pos[]; targets?: Pos[] } | { ok: false; reason: string }

/**
 * §17.5.4 ValidationGate: ground the spec against the live map. Checks (in order): every referenced
 * region/tile resolves (grounding); a COVERAGE region is non-empty after masking; the self tile is
 * not masked out from under the agent. Returns the resolved mask (+ coverage targets) or a reason.
 */
export function validateSpec(grid: Grid, spec: PddlSpec, self: Pos): GateResult {
  // grounding: constraint refs must resolve to at least the tiles they name
  for (const a of spec.constraints.avoid ?? []) if (resolveRef(grid, a).length === 0) return { ok: false, reason: 'avoid region unresolved' }
  for (const ka of spec.constraints.keepAway ?? []) if (resolveRef(grid, ka.of).length === 0) return { ok: false, reason: 'keepAway region unresolved' }
  if (spec.constraints.stayOn !== undefined && resolveRef(grid, spec.constraints.stayOn).length === 0) return { ok: false, reason: 'stayOn region unresolved' }

  const mask = constraintMask(grid, spec.constraints)
  const maskedKeys = new Set(mask.map(posKey))
  if (maskedKeys.has(posKey(self))) return { ok: false, reason: 'constraints mask the agent tile' }

  if (spec.task.kind === 'COVERAGE') {
    const region = resolveRef(grid, spec.task.region)
    if (region.length === 0) return { ok: false, reason: 'coverage region unresolved' }
    const targets = region.filter((t) => !maskedKeys.has(posKey(t)))
    if (targets.length === 0) return { ok: false, reason: 'coverage region empty after masking' }
    return { ok: true, mask, targets }
  }
  return { ok: true, mask }
}
