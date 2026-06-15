// src/coordination/dispersion.ts
// §9.5 soft dispersion: a bounded, tie-break-only repulsion from where the partner
// is heading. Added (weighted by θ_disp) to U_explore regions and zone choice.
import type { Pos } from '../types/perception.js'

/**
 * §9.5. min(1, d(x, partnerTarget)/D_ref) ∈ [0,1]. `partnerTarget` is the head of
 * the partner's derived route (its intention), or null when unknown — null yields 0
 * so the term vanishes (degraded mode falls back to static region ownership elsewhere).
 */
export function awayFromPartner(
  x: Pos,
  partnerTarget: Pos | null,
  dRef: number,
  dist: (a: Pos, b: Pos) => number
): number {
  if (partnerTarget === null || dRef <= 0) return 0
  return Math.min(1, dist(x, partnerTarget) / dRef)
}
