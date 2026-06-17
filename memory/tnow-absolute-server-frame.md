---
name: tnow-absolute-server-frame
description: tnow is the server's absolute frame counter (uptime), not a session clock — only safe in difference expressions
metadata:
  type: project
---

`tnow` (= `snap.tick`, from `tickFrom` in `src/external/deliveroo.ts`) is the Deliveroo server's **absolute frame counter** — it tracks server uptime and can be huge (observed 173088 in a ~1s session). It is NOT a session-relative clock.

**Rule:** only use `tnow` inside difference expressions (`tnow - lastSeen`, ages, epoch ordering) — those are offset-invariant and correct. Any *absolute* use of `tnow` scales without bound as the server ages.

This bit us: `chooseExplore` (`src/bdi/intentions.ts`) used `staleness = tnow` for never-seen spawners, so explore utility ≈ `theta_explore*(1+kappa_info*tnow)` exploded (uTo ~5192 at frame 173088), dwarfed every route, and froze both agents in a permanent explore lock. Fixed by clamping staleness to a `stalenessCap` (`STALE_TTL_INTERVALS * decay horizon`). When adding any new utility/heuristic term, audit it for absolute `tnow` use.
