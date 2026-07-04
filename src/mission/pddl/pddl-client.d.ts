// Minimal type stub for the untyped course package @unitn-asa/pddl-client (CLAUDE.md: write stubs
// for untyped JS deps rather than let `any` leak in). We only consume onlineSolver here; the other
// exports (PddlDomain/PddlProblem/PddlExecutor/Beliefset) are declared loosely for completeness.
declare module '@unitn-asa/pddl-client' {
  export interface PddlPlanStep { parallel: boolean; action: string; args: string[] }
  export function onlineSolver(domain: string, problem: string): Promise<PddlPlanStep[] | undefined>
  export const PddlDomain: unknown
  export const PddlProblem: unknown
  export const PddlAction: unknown
  export const PddlExecutor: unknown
  export const Beliefset: unknown
}
