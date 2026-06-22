import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

/** Free BDI hyperparameters (DESIGN §5.8). ρ/λ/λ_agent are derived from GameConsts, not here. */
export interface Params {
  alpha: number
  beta_comp: number
  theta_explore: number
  kappa_info: number
  h_commit: number
  eps_idle: number
  push_plan_budget_ms: number
  claim_ttl: number          // soft-claim expiry if no progress (ticks)
  bid_wait: number           // max wait for partner's same-epoch commit (ticks)
  rebalance_period: number   // global rebalance cadence (ticks)
  auction_budget_ms: number  // anytime cap on the SSI auction (ms)
  theta_disp: number         // dispersion weight (tie-break-only)
  partner_lost_ticks: number // no a2a from partner for this many ticks ⇒ degrade, reclaim its soft claims (§9.7/§11)
  theta_mission: number      // global mission utility weight (θ_mission, §5.5)
  c: number                  // rate-ceiling factor in U_mission (§5.5)
  p_feasible_min: number     // mission dropped below this feasibility (§5.5/§12)
  rate_window: number        // retained reward/tick samples in DeliveryRateTracker
  rate_bootstrap: number     // delivery rate used before any sample exists
  expiry_floor_ticks: number // §6.2: force-deliver a carried parcel decaying to 0 within this many ticks
  explore_stale_cap: number  // §5.5 cap on staleness in U_explore (ticks): keeps the info bonus a bounded DIRECTION signal, below real route opportunities, instead of growing unbounded and dominating collection
  theta_llm: number          // §18.9 humility weight for the LLM-agent branch (< theta_mission)
  c_llm: number              // §18.9 tighter rate ceiling for the LLM-agent branch
  max_iters: number          // §18.9 max ReAct turns per plan mission
  max_iters_query: number    // §18.9 max ReAct turns for an atomic QUERY
  batch_max: number          // §18.4 independent tool calls per turn
}

export const DEFAULT_PARAMS: Params = {
  alpha: 1.0,
  beta_comp: 0.7,
  theta_explore: 0.3,
  kappa_info: 0.1,
  h_commit: 0.15,
  eps_idle: 0.001,
  push_plan_budget_ms: 8,
  claim_ttl: 10,
  bid_wait: 1,
  rebalance_period: 15,
  auction_budget_ms: 8,
  theta_disp: 0.05,
  partner_lost_ticks: 25,
  theta_mission: 1.0,
  c: 1.5,
  p_feasible_min: 0.3,
  rate_window: 20,
  rate_bootstrap: 0.5,
  expiry_floor_ticks: 3,
  explore_stale_cap: 20,
  theta_llm: 0.45,
  c_llm: 1.2,
  max_iters: 12,
  max_iters_query: 3,
  batch_max: 6,
}

type Range = [min: number, max: number]
const RANGES: Record<keyof Params, Range> = {
  alpha: [0, 4],
  beta_comp: [0, 1],
  theta_explore: [0, 4],
  kappa_info: [0, 4],
  h_commit: [0, 2],
  eps_idle: [0, 1],
  push_plan_budget_ms: [0, 1000],
  claim_ttl: [1, 1000],
  bid_wait: [0, 100],
  rebalance_period: [1, 10000],
  auction_budget_ms: [0, 1000],
  theta_disp: [0, 4],
  partner_lost_ticks: [1, 100000],
  theta_mission: [0, 4],
  c: [0, 10],
  p_feasible_min: [0, 1],
  rate_window: [1, 1000],
  rate_bootstrap: [0, 100],
  expiry_floor_ticks: [0, 100],
  explore_stale_cap: [1, 100000],
  theta_llm: [0, 4],
  c_llm: [0, 10],
  max_iters: [1, 100],
  max_iters_query: [1, 100],
  batch_max: [1, 50],
}

export function loadParams(path = 'config/params.yaml'): Params {
  let raw: unknown
  try {
    raw = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_PARAMS }
    throw err
  }
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`params file must be a YAML mapping, got ${typeof raw}`)
  }
  const over = (raw ?? {}) as Record<string, unknown>
  const out: Params = { ...DEFAULT_PARAMS }
  for (const key of Object.keys(DEFAULT_PARAMS) as (keyof Params)[]) {
    if (!(key in over)) continue
    const v = over[key]
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`Param ${key} must be a number`)
    const [min, max] = RANGES[key]
    if (v < min || v > max) throw new Error(`Param ${key}=${v} out of range [${min}, ${max}]`)
    out[key] = v
  }
  return out
}
