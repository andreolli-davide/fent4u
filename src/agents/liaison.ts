import { makeLogger } from '../logger.js'
import { connect } from '../external/deliveroo.js'
import { Blackboard } from '../blackboard/blackboard.js'
import { BdiLoop } from '../bdi/loop.js'
import { ClaimStore, isClaimMsg } from '../coordination/claims.js'
import { MissionSlot } from '../mission/slot.js'
import { makeChat } from '../mission/llm.js'
import { compile } from '../mission/compiler.js'
import { createIntake } from '../mission/intake.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'
import type { Params } from '../bdi/params.js'

let log: ReturnType<typeof makeLogger> | null = null
let blackboard: Blackboard | null = null
let claims: ClaimStore | null = null
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

  const missionSlot = new MissionSlot()
  const chat = makeChat(config) // throws fast if LITELLM_MODEL is not an OpenAI-handler id
  const intake = createIntake({
    slot: missionSlot,
    compile: (raw) => compile(raw, chat),
    say: (toId, msg) => client.say(toId, msg),
    logger: log,   // log is non-null here — set at top of boot()
  })
  client.onMissionMsg((id, _name, msg) => {
    if (typeof msg === 'string') intake.onMessage(id, msg)
    else intake.onMessage(id, JSON.stringify(msg))
  })
  log.info({}, 'mission lane online')

  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  }, claims, {
    partner: 'courier',
    send,
  })
  let booted = false
  client.onPerception((snap) => {
    if (!booted) {
      blackboard = new Blackboard(loop.beliefBase(snap), { self: 'liaison', partner: 'courier', send, logger, partnerTtl: params.partner_lost_ticks })
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
    } else blackboard?.receive(msg)
  }
}
