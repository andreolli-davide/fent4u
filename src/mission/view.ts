// src/mission/view.ts
// Local read model of the active mission, as seen by ONE agent's BDI loop. The Liaison feeds it
// from its MissionSlot.onChange; the Courier feeds it from the replicated a2a 'mission' message.
// The loop reads shapers from HERE (never the slot, never mission kinds) so both agents share one
// code path. Returns identity shapers (M1/G1) when there is no mission, or the mission carries no
// shaper — base play is then byte-for-byte unchanged. Toll/filter accessors (Phase 3): tolls()/bundleFilter().

import type { Mission } from './kinds.js'
import type { Pos } from '../types/perception.js'
import type { Grid } from '../planning/astar.js'
import { M1, G1, F1, type CountShaper, type ZoneShaper, type BundleFilter } from '../bdi/utility.js'
import { buildCountShaper, buildZoneShaper, buildTolls, buildBundleFilter } from './shapers.js'
import { resolveLandmark } from './region.js'

export class TeamMissionView {
  private mission: Mission | null = null
  private grid: Grid | null = null

  set(m: Mission | null): void { this.mission = m }
  current(): Mission | null { return this.mission }

  /** Bind the map once perception has built it, so RUNTIME_BOUND shaper/constraint zones resolve (§17.5.3). */
  bindGrid(grid: Grid): void { this.grid = grid }

  private resolver(): ((rule: string) => Pos | null) | undefined {
    const g = this.grid
    return g === null ? undefined : (rule: string) => resolveLandmark(g, rule)
  }

  countShaper(): CountShaper {
    return this.mission?.kind === 'REWARD_SHAPER' ? buildCountShaper(this.mission.params.m) : M1
  }

  zoneShaper(): ZoneShaper {
    return this.mission?.kind === 'REWARD_SHAPER' ? buildZoneShaper(this.mission.params.g, this.resolver()) : G1
  }

  tolls(): Map<string, number> {
    return this.mission?.kind === 'HARD_CONSTRAINT' ? buildTolls(this.mission.params.priced) : new Map()
  }

  bundleFilter(): BundleFilter {
    return this.mission?.kind === 'HARD_CONSTRAINT' ? buildBundleFilter(this.mission.params.absolute, this.resolver()) : F1
  }
}
