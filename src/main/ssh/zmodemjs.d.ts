declare module 'zmodem.js' {
  export interface Detection {
    get_session_role(): 'receive' | 'send'
    confirm(): Session
    deny(): void
  }

  export interface OfferDetails {
    name: string
    size: number | null
  }

  export interface Offer {
    on(event: 'input', listener: (octets: number[] | Uint8Array) => void): this
    on(event: 'complete', listener: () => void): this
    get_details(): OfferDetails
    accept(options?: { on_input?: (octets: number[] | Uint8Array) => void }): Promise<void>
    skip(): Promise<void> | void
  }

  export interface Transfer {
    send(octets: number[] | Uint8Array): void
    end(octets?: number[] | Uint8Array): Promise<void>
  }

  export interface Session {
    on(event: 'garbage', listener: (octets: number[] | Uint8Array) => void): this
    on(event: 'offer', listener: (offer: Offer) => void): this
    on(event: 'file_end', listener: () => void): this
    on(event: 'session_end', listener: () => void): this
    start(): Promise<void> | void
    consume(octets: number[] | Uint8Array): void
    set_sender(sender: (octets: number[] | Uint8Array) => void): this
    abort(): void
    close(): Promise<void>
  }

  export interface SendSession extends Session {
    send_offer(options: { name: string; size: number }): Promise<Transfer | undefined>
  }

  export interface SentryOptions {
    to_terminal(octets: number[] | Uint8Array): void
    sender(octets: number[] | Uint8Array): void
    on_detect(detection: Detection): void
    on_retract(): void
  }

  export class Sentry {
    constructor(options: SentryOptions)
    consume(input: Uint8Array | number[]): void
    get_confirmed_session(): Session | null
  }

  export class Header {
    readonly NAME: string
    static build(name: string, ...args: unknown[]): Header
    static parse(octets: number[]): [Header, number] | undefined
    static parse_hex(octets: number[]): Header | undefined
    to_hex(): number[]
  }

  const Zmodem: {
    Sentry: typeof Sentry
    Header: typeof Header
    Session: { Receive: new () => Session }
  }
  export default Zmodem
}
