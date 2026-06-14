// src/external/deliveroo-sdk.d.ts
// Minimal ambient types for @unitn-asa/deliveroo-js-sdk (JSDoc-only, no .d.ts shipped).
// Declares ONLY the surface src/external/deliveroo.ts uses. Verified against
// node_modules/@unitn-asa/deliveroo-js-sdk/src.

declare module '@unitn-asa/deliveroo-js-sdk' {
  export type IOTileType =
    | '0'
    | '1'
    | '2'
    | '3'
    | '4'
    | '5'
    | '5!'
    | '←'
    | '↑'
    | '→'
    | '↓'

  export interface IOTile {
    x: number
    y: number
    type: IOTileType
  }

  export interface IOParcel {
    id: string
    x: number
    y: number
    carriedBy?: string
    reward: number
  }

  export interface IOAgent {
    id: string
    name: string
    teamId: string
    teamName: string
    x?: number
    y?: number
    score: number
    penalty: number
  }

  export interface IOCrate {
    id: string
    x: number
    y: number
  }

  export interface IOSensing {
    positions: { x: number; y: number }[]
    agents: IOAgent[]
    parcels: IOParcel[]
    crates: IOCrate[]
  }

  export interface IOPlayerOptions {
    movement_duration: number
    observation_distance: number
  }

  export interface IOParcelsOptions {
    decaying_event: string
    generation_event: string
  }

  export interface IOGameOptions {
    player: IOPlayerOptions
    parcels: IOParcelsOptions
  }

  export interface IOConfig {
    CLOCK: number
    PENALTY: number
    AGENT_TIMEOUT: number
    BROADCAST_LOGS: boolean
    GAME: IOGameOptions
  }

  export interface IOPing {
    frame: number
    roundTrip: number
  }

  export interface DjsClientSocket {
    // one-shot promise getters
    readonly me: Promise<IOAgent>
    readonly config: Promise<IOConfig>
    readonly map: Promise<{ width: number; height: number; tiles: IOTile[] }>
    readonly token: Promise<string>

    // repeating listeners
    onConnect(cb: () => void): void
    onDisconnect(cb: (reason: string) => void): void
    onYou(cb: (me: IOAgent) => void): void
    onSensing(cb: (sensing: IOSensing) => void): void
    onMsg(
      cb: (id: string, name: string, msg: unknown, reply: (ack: unknown) => void) => void,
    ): void

    // raw socket.io passthrough (used for the `ping` event)
    on(event: 'ping', cb: (data: IOPing, ack: () => void) => void): void
    on(event: string, cb: (...args: unknown[]) => void): void

    // async actions
    emitMove(dir: 'up' | 'right' | 'left' | 'down'): Promise<{ x: number; y: number } | false>
    emitPickup(): Promise<{ id: string }[]>
    emitPutdown(selected?: string[]): Promise<{ id: string }[]>
    emitSay(toId: string, msg: unknown): Promise<'successful' | 'failed'>
    emitAsk(toId: string, msg: unknown): Promise<unknown>
    emitShout(msg: unknown): Promise<unknown>

    // lifecycle
    disconnect(): DjsClientSocket
  }

  export function DjsConnect(
    host?: string,
    token?: string,
    name?: string,
    autoconnect?: boolean,
  ): DjsClientSocket
}
