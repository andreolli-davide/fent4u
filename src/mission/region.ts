// Region resolver (§17.5.3 "region resolver"): map a symbolic region/landmark name to concrete
// map tiles, deterministically. Used for (a) RUNTIME_BOUND shaper/constraint zone binding (§6/§7)
// and (b) PDDL Coverage / StayOn / KeepAway grounding (§17.5.2). An unknown rule → null / [] ⇒
// grounding fail (and that is fine — the caller drops the effect, §17.5.3).

import type { Pos } from '../types/perception.js'
import type { Grid } from '../planning/astar.js'

const walkable = (grid: Grid, x: number, y: number): boolean => {
  const t = grid.tiles.get(`${x},${y}`)
  return t !== undefined && t.type !== 'wall'
}

/** All walkable tiles, in a fixed (x,y) order — the base set region rules crop. */
export function walkableTiles(grid: Grid): Pos[] {
  const out: Pos[] = []
  for (let x = 0; x < grid.w; x++) for (let y = 0; y < grid.h; y++) if (walkable(grid, x, y)) out.push({ x, y })
  return out
}

// Normalise a free-text rule to a lowercase keyword bag for keyword matching.
function words(rule: string): Set<string> {
  return new Set(rule.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0))
}

/**
 * Resolve a symbolic region NAME to a set of tiles (§17.5.2 Coverage/StayOn/KeepAway). Supported
 * vocabulary (keyword-matched, order-free): left/right/top/bottom half; border/edge/perimeter;
 * a bare "room" defaults to the whole walkable graph. Empty array ⇒ unknown region (grounding fail).
 */
export function resolveRegion(grid: Grid, rule: string): Pos[] {
  const w = words(rule)
  const all = walkableTiles(grid)
  if (all.length === 0) return []
  const midX = (grid.w - 1) / 2
  const midY = (grid.h - 1) / 2
  if (w.has('border') || w.has('edge') || w.has('perimeter')) {
    return all.filter((p) => p.x === 0 || p.y === 0 || p.x === grid.w - 1 || p.y === grid.h - 1)
  }
  if (w.has('left')) return all.filter((p) => p.x <= midX)
  if (w.has('right')) return all.filter((p) => p.x >= midX)
  if (w.has('top')) return all.filter((p) => p.y >= midY)
  if (w.has('bottom')) return all.filter((p) => p.y <= midY)
  if (w.has('room') || w.has('map') || w.has('all')) return all
  return []
}

/**
 * Resolve a symbolic name to ONE landmark tile (§6/§7 RUNTIME_BOUND zone binding). Chooses among
 * delivery zones by an extremal rule (leftmost/rightmost/topmost/bottommost) or the zone nearest
 * the map centre by default. null ⇒ unresolved (drop the effect). Deterministic tie-break by (x,y).
 */
export function resolveLandmark(grid: Grid, rule: string): Pos | null {
  const zones = grid.deliveryZones
  if (zones.length === 0) return null
  const w = words(rule)
  const pick = (score: (p: Pos) => number): Pos =>
    [...zones].sort((a, b) => score(a) - score(b) || a.x - b.x || a.y - b.y)[0]!
  if (w.has('leftmost') || (w.has('left') && !w.has('right'))) return pick((p) => p.x)
  if (w.has('rightmost') || (w.has('right') && !w.has('left'))) return pick((p) => -p.x)
  if (w.has('bottommost') || w.has('bottom')) return pick((p) => p.y)
  if (w.has('topmost') || w.has('top')) return pick((p) => -p.y)
  // default: the delivery zone nearest the map centre (a stable landmark both agents know).
  const cx = Math.floor(grid.w / 2)
  const cy = Math.floor(grid.h / 2)
  return pick((p) => Math.abs(p.x - cx) + Math.abs(p.y - cy))
}
