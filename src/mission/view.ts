// src/mission/view.ts
// Local read model of the active mission, as seen by ONE agent's BDI loop. The Liaison feeds it
// from its MissionSlot.onChange; the Courier feeds it from the replicated a2a 'mission' message.
// The loop reads shapers from HERE (never the slot, never mission kinds) so both agents share one
// code path. Returns identity shapers (M1/G1) when there is no mission, or the mission carries no
// shaper — base play is then byte-for-byte unchanged. Toll/filter accessors (Phase 3): tolls()/bundleFilter().

import type { Mission } from './kinds.js'
import { M1, G1, F1, type CountShaper, type ZoneShaper, type BundleFilter } from '../bdi/utility.js'
import { buildCountShaper, buildZoneShaper, buildTolls, buildBundleFilter } from './shapers.js'

export class TeamMissionView {
  private mission: Mission | null = null

  set(m: Mission | null): void { this.mission = m }
  current(): Mission | null { return this.mission }

  countShaper(): CountShaper {
    return this.mission?.kind === 'REWARD_SHAPER' ? buildCountShaper(this.mission.params.m) : M1
  }

  zoneShaper(): ZoneShaper {
    return this.mission?.kind === 'REWARD_SHAPER' ? buildZoneShaper(this.mission.params.g) : G1
  }

  tolls(): Map<string, number> {
    return this.mission?.kind === 'HARD_CONSTRAINT' ? buildTolls(this.mission.params.priced) : new Map()
  }

  bundleFilter(): BundleFilter {
    return this.mission?.kind === 'HARD_CONSTRAINT' ? buildBundleFilter(this.mission.params.absolute) : F1
  }
}
