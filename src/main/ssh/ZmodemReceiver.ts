import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dialog } from 'electron'
import type { ClientChannel } from 'ssh2'
import Zmodem from 'zmodem.js'
import type { Detection, Offer, SendSession, Session, Sentry } from 'zmodem.js'
import { getMainWindow } from '../window'
import { scopedLogger } from '../utils/logger'

const log = scopedLogger('zmodem')
const START_MARKER = Buffer.from([0x2a, 0x2a, 0x18, 0x42, 0x30])
const MAX_START_HEADER_BYTES = 32

interface ReceiverOptions {
  channel: ClientChannel
  toTerminal: (chunk: Buffer) => void
  pause: (reason: string) => void
  resume: (reason: string) => void
}

interface ActiveOutput {
  tempPath: string
  stream: ReturnType<typeof createWriteStream>
  completion: Promise<void>
}

/** Bridges SSH's raw channel bytes to zmodem.js and the native file dialogs. */
export class ZmodemReceiver {
  private sentry: Sentry
  private activeSession: Session | null = null
  private activeOutput: ActiveOutput | null = null
  private terminalPending = Buffer.alloc(0)
  private closed = false
  private writeDrain: Promise<void> = Promise.resolve()

  constructor(private readonly options: ReceiverOptions) {
    this.sentry = this.createSentry()
  }

  consume(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return
    try {
      this.sentry.consume(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    } catch (error) {
      log.warn('ZMODEM stream was reset after a protocol error', error)
      this.abortActiveSession()
      this.sentry = this.createSentry()
      this.flushTerminalPending()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.abortActiveSession()
    const output = this.activeOutput
    this.activeOutput = null
    if (output) {
      output.stream.destroy()
      void rm(output.tempPath, { force: true }).catch(() => undefined)
    }
    this.flushTerminalPending()
  }

  private createSentry(): Sentry {
    return new Zmodem.Sentry({
      to_terminal: (octets) => this.emitTerminalBytes(octets),
      sender: (octets) => this.sendProtocolBytes(octets),
      on_detect: (detection) => this.onDetect(detection),
      on_retract: () => undefined
    })
  }

  private onDetect(detection: Detection): void {
    let session: Session
    try {
      session = detection.confirm()
    } catch (error) {
      log.warn('Could not confirm ZMODEM session', error)
      return
    }
    this.activeSession = session
    session.on('session_end', () => {
      if (this.activeSession === session) this.activeSession = null
      queueMicrotask(() => {
        if (!this.closed && this.activeSession === null) this.sentry = this.createSentry()
      })
    })

    if (detection.get_session_role() === 'receive') {
      session.on('offer', (offer) => this.onFileOffer(session, offer))
      try {
        void Promise.resolve(session.start()).catch((error: unknown) => this.failSession(session, error))
      } catch (error) {
        this.failSession(session, error)
      }
      return
    }

    void this.sendFiles(session as SendSession)
  }

  private emitTerminalBytes(octets: number[] | Uint8Array): void {
    if (octets.length === 0) return
    const incoming = Buffer.from(octets)
    this.terminalPending = this.terminalPending.length
      ? Buffer.concat([this.terminalPending, incoming])
      : incoming

    const output: Buffer[] = []
    while (this.terminalPending.length > 0) {
      const markerAt = this.terminalPending.indexOf(START_MARKER)
      if (markerAt < 0) {
        const keep = this.longestMarkerPrefixSuffix(this.terminalPending)
        if (keep > 0) {
          output.push(this.terminalPending.subarray(0, this.terminalPending.length - keep))
          this.terminalPending = this.terminalPending.subarray(this.terminalPending.length - keep)
        } else {
          output.push(this.terminalPending)
          this.terminalPending = Buffer.alloc(0)
        }
        break
      }

      if (markerAt > 0) output.push(this.terminalPending.subarray(0, markerAt))
      this.terminalPending = this.terminalPending.subarray(markerAt)
      const lineEnd = this.findHeaderLineEnd(this.terminalPending)
      if (lineEnd < 0) {
        if (this.terminalPending.length < MAX_START_HEADER_BYTES) break
        output.push(this.terminalPending.subarray(0, 1))
        this.terminalPending = this.terminalPending.subarray(1)
        continue
      }

      const candidate = this.terminalPending.subarray(0, lineEnd + 1)
      let isStartupHeader = false
      try {
        const parsed = Zmodem.Header.parse(Array.from(candidate))
        isStartupHeader = parsed?.[0].NAME === 'ZRQINIT' || parsed?.[0].NAME === 'ZRINIT'
      } catch { /* ordinary terminal text can resemble an incomplete header */ }

      if (isStartupHeader) {
        let consumed = lineEnd + 1
        if (this.terminalPending[consumed] === 0x11) consumed++
        this.terminalPending = this.terminalPending.subarray(consumed)
      } else {
        output.push(this.terminalPending.subarray(0, 1))
        this.terminalPending = this.terminalPending.subarray(1)
      }
    }

    if (output.length) this.options.toTerminal(Buffer.concat(output))
  }

  private findHeaderLineEnd(bytes: Buffer): number {
    const lf = bytes.indexOf(0x0a)
    const highLf = bytes.indexOf(0x8a)
    if (lf < 0) return highLf
    return highLf < 0 ? lf : Math.min(lf, highLf)
  }

  private longestMarkerPrefixSuffix(bytes: Buffer): number {
    const max = Math.min(bytes.length, START_MARKER.length - 1)
    for (let length = max; length > 0; length--) {
      if (bytes.subarray(bytes.length - length).equals(START_MARKER.subarray(0, length))) return length
    }
    return 0
  }

  private flushTerminalPending(): void {
    if (this.terminalPending.length) {
      this.options.toTerminal(this.terminalPending)
      this.terminalPending = Buffer.alloc(0)
    }
  }

  private sendProtocolBytes(octets: number[] | Uint8Array): void {
    if (this.closed) return
    const writable = this.options.channel.write(Buffer.from(octets))
    if (writable) return
    this.writeDrain = new Promise((resolve) => {
      const finish = (): void => {
        this.options.channel.off('drain', finish)
        this.options.channel.off('close', finish)
        this.options.resume('zmodem-write')
        resolve()
      }
      this.options.pause('zmodem-write')
      this.options.channel.once('drain', finish)
      this.options.channel.once('close', finish)
    })
  }

  private async onFileOffer(session: Session, offer: Offer): Promise<void> {
    const previous = this.activeOutput
    if (previous) {
      try { await previous.completion } catch { return }
    }
    if (this.closed || this.activeSession !== session) return

    try {
      const details = offer.get_details()
      const suggestedName = safeFileName(details.name)
      const window = getMainWindow()
      const options = { defaultPath: suggestedName }
      const result = window && !window.isDestroyed()
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (this.closed || this.activeSession !== session) return
      if (result.canceled || !result.filePath) {
        await offer.skip()
        return
      }

      const tempPath = join(dirname(result.filePath), `.${basename(result.filePath)}.${randomUUID()}.part`)
      const stream = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
      const completion = new Promise<void>((resolve, reject) => {
        stream.once('finish', resolve)
        stream.once('error', reject)
      }).then(() => rename(tempPath, result.filePath!))
      const output: ActiveOutput = { tempPath, stream, completion }
      this.activeOutput = output
      void completion.catch((error: unknown) => this.failSession(session, error))
      stream.on('drain', () => this.options.resume('zmodem-file'))
      stream.on('error', () => this.options.resume('zmodem-file'))
      offer.on('complete', () => {
        if (this.activeOutput !== output) return
        stream.end()
        void completion.catch((error: unknown) => this.failSession(session, error))
      })
      await offer.accept({
        on_input: (octets) => {
          if (!stream.write(Buffer.from(octets))) this.options.pause('zmodem-file')
        }
      })
      await completion
      if (this.activeOutput === output) this.activeOutput = null
    } catch (error) {
      this.failSession(session, error)
    }
  }

  private async sendFiles(session: SendSession): Promise<void> {
    try {
      const window = getMainWindow()
      const result = window && !window.isDestroyed()
        ? await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
      if (this.closed || this.activeSession !== session) return

      if (result.canceled || result.filePaths.length === 0) {
        await session.close()
        return
      }

      for (const filePath of result.filePaths) {
        const details = await stat(filePath)
        if (!details.isFile()) continue
        const transfer = await session.send_offer({ name: safeFileName(basename(filePath)), size: details.size })
        if (!transfer) continue

        const stream = createReadStream(filePath)
        let lastChunk: Buffer | undefined
        for await (const chunk of stream) {
          if (lastChunk) transfer.send(lastChunk)
          lastChunk = Buffer.from(chunk)
          await this.writeDrain
        }
        await transfer.end(lastChunk)
        await this.writeDrain
      }
      await session.close()
    } catch (error) {
      this.failSession(session, error)
    }
  }

  private failSession(session: Session, error: unknown): void {
    if (this.closed || this.activeSession !== session) return
    log.warn('ZMODEM transfer failed; keeping the SSH shell open', error)
    const output = this.activeOutput
    this.activeOutput = null
    if (output) {
      output.stream.destroy()
      void rm(output.tempPath, { force: true }).catch(() => undefined)
    }
    try { session.abort() } catch { /* reset below even if the library already ended */ }
    this.activeSession = null
    this.sentry = this.createSentry()
  }

  private abortActiveSession(): void {
    if (!this.activeSession) return
    try { this.activeSession.abort() } catch { /* channel is being closed */ }
    this.activeSession = null
  }
}

function safeFileName(remoteName: string): string {
  const leaf = basename(remoteName.replace(/\\/g, '/'))
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : 'download'
}
