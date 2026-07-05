import { makeLogger } from '../logger.js'
import { connect } from '../external/deliveroo.js'
import { Blackboard } from '../blackboard/blackboard.js'
import { BdiLoop } from '../bdi/loop.js'
import { ClaimStore, isClaimMsg } from '../coordination/claims.js'
import { ContractRuntime, isContractMsg, isGateMsg } from '../coordination/contract.js'
import { TeamMissionView } from '../mission/view.js'
import { isMission } from '../mission/kinds.js'
import { buildGrid } from '../planning/astar.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'
import type { Params } from '../bdi/params.js'

let log: ReturnType<typeof makeLogger> | null = null
let blackboard: Blackboard | null = null
let claims: ClaimStore | null = null
let contracts: ContractRuntime | null = null
let missionView: TeamMissionView | null = null
let booting = false

function send(msg: A2AMessage): void {
  self.postMessage({ kind: 'a2a', data: msg } satisfies WorkerEnvelope)
}

async function boot(config: Config, params: Params): Promise<void> {
  log = makeLogger('courier', 'agent', {
    level: config.LOG_LEVEL,
    writeFn: (line) => self.postMessage({ kind: 'log', data: line } satisfies WorkerEnvelope),
  })
  const logger = {
    warn: (o: unknown, m?: string) => log!.warn(o as object, m),
    info: (o: unknown, m?: string) => log!.info(o as object, m),
    debug: (o: unknown, m?: string) => log!.debug(o as object, m),
  }
  const client = await connect(config, 'courier', logger)

  claims = new ClaimStore()
  contracts = new ContractRuntime()

  missionView = new TeamMissionView()
  missionView.bindGrid(buildGrid(client.map)) // §17.5.3: resolve RUNTIME_BOUND zones against the map
  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'liaison',
    send,
  }, {
    view: missionView,
    pursue: false, // Courier honours shapers/zone but never chases the coordinate target (A3)
    contracts,
  })
  let booted = false
  client.onPerception((snap) => {
    if (!booted) {
      blackboard = new Blackboard(loop.beliefBase(snap), { self: 'courier', partner: 'liaison', send, logger, partnerTtl: params.partner_lost_ticks })
      blackboard.hello(snap.tick)
      booted = true
    }
    // partnerAlive: heartbeat-backed channel liveness (§9.7/§11), the authority for degradation.
    // false until first contact (partnerLastSeenTick = -Infinity) ⇒ degraded solo at boot.
    void loop.tick(snap, blackboard?.partnerAlive(snap.tick) ?? false)
      .then(() => blackboard?.onTick(snap.tick))
      .catch((err: unknown) => log?.error({ err }, 'tick error'))
  })
  log.info({}, 'Courier BDI online')
}

self.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
  const envelope = event.data
  if (envelope.kind === 'init') {
    if (booting) return
    booting = true
    void boot(envelope.config, envelope.params)
    return
  }
  if (envelope.kind === 'a2a') {
    const msg = envelope.data
    if (msg.type === 'claims' && isClaimMsg(msg.payload)) {
      if (claims !== null) claims.applyMsg(msg.payload, 'courier')
      else log?.debug({ type: msg.type }, 'claims msg dropped — boot in progress')
    } else if (msg.type === 'mission') {
      if (msg.payload === null) missionView?.set(null)
      else if (isMission(msg.payload)) missionView?.set(msg.payload)
      else log?.debug({ type: msg.type }, 'mission msg dropped — bad payload')
    } else if (msg.type === 'contract' && isContractMsg(msg.payload)) {
      const reply = contracts?.applyMsg(msg.payload, 'courier') ?? null
      if (reply !== null) send({ from: 'courier', to: 'liaison', type: 'contract', payload: reply })
    } else if (msg.type === 'gate' && isGateMsg(msg.payload)) {
      contracts?.applyGate(msg.payload)
    } else blackboard?.receive(msg)
  }
}
