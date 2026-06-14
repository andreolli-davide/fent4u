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
}

export const DEFAULT_PARAMS: Params = {
  alpha: 1.0,
  beta_comp: 0.7,
  theta_explore: 0.3,
  kappa_info: 0.1,
  h_commit: 0.15,
  eps_idle: 0.001,
  push_plan_budget_ms: 8,
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
