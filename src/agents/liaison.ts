import { makeLogger } from '../logger.js'
import { connect } from '../external/deliveroo.js'
import { Blackboard } from '../blackboard/blackboard.js'
import { BdiLoop } from '../bdi/loop.js'
import { ClaimStore, isClaimMsg } from '../coordination/claims.js'
import { ContractRuntime, isContractMsg, isGateMsg } from '../coordination/contract.js'
import { MissionSlot } from '../mission/slot.js'
import { TeamMissionView } from '../mission/view.js'
import { makeChat } from '../mission/llm.js'
import { compile } from '../mission/compiler.js'
import { createIntake } from '../mission/intake.js'
import { reactPlan } from '../mission/agent/loop.js'
import { makeMissionCompile, snapshotFromBeliefs, makeReplanRequester } from '../mission/agent/wire.js'
import { makePddlCompile } from '../mission/pddl/lane.js'
import { onlineSolver } from '../mission/pddl/solver.js'
import { buildGrid } from '../planning/astar.js'
import { decayConsts } from '../bdi/utility.js'
import type { BeliefBase } from '../blackboard/beliefs.js'
import type { Grid } from '../planning/astar.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'
import type { Params } from '../bdi/params.js'
import type { Pos } from '../types/perception.js'

let log: ReturnType<typeof makeLogger> | null = null
let blackboard: Blackboard | null = null
let claims: ClaimStore | null = null
let contracts: ContractRuntime | null = null
let booting = false

function send(msg: A2AMessage): void {
  self.postMessage({ kind: 'a2a', data: msg } satisfies WorkerEnvelope)
}

async function boot(config: Config, params: Params): Promise<void> {
  log = makeLogger('liaison', 'agent', {
    level: config.LOG_LEVEL,
    writeFn: (line) => self.postMessage({ kind: 'log', data: line } satisfies WorkerEnvelope),
  })
  const logger = {
    warn: (o: unknown, m?: string) => log!.warn(o as object, m),
    info: (o: unknown, m?: string) => log!.info(o as object, m),
    debug: (o: unknown, m?: string) => log!.debug(o as object, m),
  }
  const client = await connect(config, 'liaison', logger)

  claims = new ClaimStore()
  contracts = new ContractRuntime()

  const missionView = new TeamMissionView()
  const broadcast = config.MISSION_HANDLER !== 'LLM_AGENT'
  const missionSlot = new MissionSlot((m) => {
    missionView.set(m)
    if (broadcast) send({ from: 'liaison', to: 'courier', type: 'mission', payload: m })
  })
  const chat = makeChat(config)

  let grid: Grid | null = null
  let beliefs: BeliefBase | null = null
  let tnow = 0
  let pendingMask: Pos[] | undefined
  const seq = { n: 0 }
  const nextId = () => `m-${Date.now()}-${seq.n++}`

  // Single snapshot source for both mission back-ends. Consumes the one-shot K_block mask
  // (§17.7.4) so a masked re-plan is honoured whichever handler owns compilation — the
  // LLM_AGENT lane reads it via reactPlan's snapshot, the PDDL lane via makePddlCompile's.
  const takeSnapshot = () => {
    if (grid === null || beliefs === null) return null
    const snap = snapshotFromBeliefs(beliefs, grid.deliveryZones, tnow, pendingMask)
    pendingMask = undefined // one-shot: the mask applies only to the re-plan it was set for
    return snap
  }

  const missionCompile = makeMissionCompile({
    handler: config.MISSION_HANDLER,
    params,
    compile: (raw) => compile(raw, chat),
    reactPlan: (raw, snap) =>
      reactPlan(raw, snap, chat, grid!, decayConsts(client.consts), tnow, params, nextId),
    snapshot: takeSnapshot,
    pddlCompile: makePddlCompile({
      grid: () => grid,
      snapshot: takeSnapshot,
      solve: onlineSolver,
      dc: decayConsts(client.consts),
      params,
      tnow: () => tnow,
      nextId,
    }),
  })

  const intake = createIntake({
    slot: missionSlot,
    compile: missionCompile,
    say: (toId, msg) => client.say(toId, msg),
    logger: log,   // log is non-null here — set at top of boot()
  })
  client.onMissionMsg((id, _name, msg) => {
    if (typeof msg === 'string') intake.onMessage(id, msg)
    else intake.onMessage(id, JSON.stringify(msg))
  })
  log.info({}, 'mission lane online')

  const requestReplan = makeReplanRequester(
    (raw) => intake.onMessage('self', raw),
    (m) => { pendingMask = m },
  )

  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'courier',
    send,
  }, {
    view: missionView,
    pursue: true,
    onSatisfied: () => missionSlot.supersede(),
    contracts,
    requestReplan,
  })
  let booted = false
  client.onPerception((snap) => {
    tnow = snap.tick
    if (!booted) {
      beliefs = loop.beliefBase(snap)
      grid = buildGrid(client.map)
      blackboard = new Blackboard(beliefs, { self: 'liaison', partner: 'courier', send, logger, partnerTtl: params.partner_lost_ticks })
      blackboard.hello(snap.tick)
      booted = true
    }
    // partnerAlive: heartbeat-backed channel liveness (§9.7/§11), the authority for degradation.
    // false until first contact (partnerLastSeenTick = -Infinity) ⇒ degraded solo at boot.
    void loop.tick(snap, blackboard?.partnerAlive(snap.tick) ?? false)
      .then(() => blackboard?.onTick(snap.tick))
      .catch((err: unknown) => log?.error({ err }, 'tick error'))
  })
  log.info({}, 'Liaison BDI online')
}

self.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
  const envelope = event.data
  if (envelope.kind === 'init') {
    if (booting) return
    booting = true
    void boot(envelope.config, envelope.params).catch((err: unknown) => self.reportError(err instanceof Error ? err : new Error(String(err))))
    return
  }
  if (envelope.kind === 'a2a') {
    const msg = envelope.data
    if (msg.type === 'claims' && isClaimMsg(msg.payload)) {
      if (claims !== null) claims.applyMsg(msg.payload, 'liaison')
      else log?.debug({ type: msg.type }, 'claims msg dropped — boot in progress')
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'liaison') ?? null
      if (reply !== null) send({ from: 'liaison', to: 'courier', type: 'contract', payload: reply })
    } else if (msg.type === 'gate' && isGateMsg(msg.payload)) {
      contracts?.applyGate(msg.payload)
    } else blackboard?.receive(msg)
  }
}
