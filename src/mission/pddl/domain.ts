// §17 PDDL back-end — the fixed, versioned STRIPS domain for Deliveroo (§17.5). Tiles + orthogonal
// adjacency + move/pickup/deliver. The planner decides the ORDER of pickups and deliveries (a spatial
// ordering task PDDL is strong at); real per-tile travel is priced afterwards by the shared push-aware
// A* (§17.6.2, costPlan), so this domain never needs one-way/crate fidelity — only reachable topology.
export const DELIVEROO_DOMAIN = `(define (domain deliveroo)
  (:requirements :strips :typing)
  (:types tile parcel)
  (:predicates
    (at ?t - tile)
    (adjacent ?from - tile ?to - tile)
    (parcel-at ?p - parcel ?t - tile)
    (carrying ?p - parcel)
    (delivery ?t - tile)
    (delivered ?p - parcel))
  (:action move
    :parameters (?from - tile ?to - tile)
    :precondition (and (at ?from) (adjacent ?from ?to))
    :effect (and (not (at ?from)) (at ?to)))
  (:action pickup
    :parameters (?p - parcel ?t - tile)
    :precondition (and (at ?t) (parcel-at ?p ?t))
    :effect (and (not (parcel-at ?p ?t)) (carrying ?p)))
  (:action deliver
    :parameters (?p - parcel ?t - tile)
    :precondition (and (at ?t) (carrying ?p) (delivery ?t))
    :effect (and (not (carrying ?p)) (delivered ?p))))
`

// PDDL identifiers can't carry commas or special chars: tiles → t{x}_{y}, parcels → indexed pk{n}
// (server ids may contain anything). The lane keeps the pk{n} → realId map to rebuild AgentSteps.
export const tileName = (x: number, y: number): string => `t${x}_${y}`
