// src/coordination/claims.ts
// Stored, replicated coordination state (DESIGN §9.2/§9.7/§9.10). One local replica
// per agent, kept convergent by broadcasting commits (Task 4). Claims are stored;
// routes are derived from them (§2.3.2) and never published.
import type { AgentId } from '../types/a2a.js'

export type ClaimOrigin = 'AUCTION' | 'MISSION' // only AUCTION is created this slice

export interface Claim {
  parcelId: string
  agentId: AgentId
  origin: ClaimOrigin
  epoch: number // material-change round id; monotone, tick-derived
  commitTick: number
  originD: number // d(committer pos at commit, parcel) — sunk-travel basis (§9.6)
  lastD: number // most recent d(owner now, parcel)
  lastProgressTick: number // last tick lastD strictly decreased (§9.7 CLAIM_TTL liveness)
}

export class ClaimStore {
  private readonly byParcel = new Map<string, Claim>()

  claimedBy(parcelId: string): AgentId | null {
    return this.byParcel.get(parcelId)?.agentId ?? null
  }

  /** Own claims, sorted by parcelId for replica-deterministic route ordering. */
  ownClaims(self: AgentId): Claim[] {
    return [...this.byParcel.values()].filter((c) => c.agentId === self).sort((a, b) => a.parcelId.localeCompare(b.parcelId))
  }

  /** Parcel ids claimed by anyone other than `self` (§9.4 P_avail=0 set). */
  partnerClaimed(self: AgentId): Set<string> {
    const out = new Set<string>()
    for (const c of this.byParcel.values()) if (c.agentId !== self) out.add(c.parcelId)
    return out
  }

  add(c: Claim): void {
    this.byParcel.set(c.parcelId, c)
  }

  remove(parcelId: string): void {
    this.byParcel.delete(parcelId)
  }

  /**
   * §9.7 liveness. `distOf(c)` = d(owner now, parcel). Updates lastD/lastProgressTick;
   * returns (and removes) AUCTION claims with no strict progress for CLAIM_TTL ticks.
   * MISSION claims never expire here (§9.10). Iterates sorted ids for determinism.
   */
  expire(tnow: number, distOf: (c: Claim) => number, claimTtl: number): Claim[] {
    const dropped: Claim[] = []
    for (const id of [...this.byParcel.keys()].sort()) {
      const c = this.byParcel.get(id)!
      const d = distOf(c)
      if (d < c.lastD) {
        c.lastD = d
        c.lastProgressTick = tnow
      }
      if (c.origin === 'AUCTION' && tnow - c.lastProgressTick >= claimTtl) {
        this.byParcel.delete(id)
        dropped.push(c)
      }
    }
    return dropped
  }
}
