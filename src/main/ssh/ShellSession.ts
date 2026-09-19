import iconv from 'iconv-lite'
import type { ClientChannel } from 'ssh2'
import type { TermId } from '@shared/types'
import {
  TERM_FLOW_PAUSE_BYTES,
  TERM_FLOW_RESUME_BYTES,
  TERM_FLUSH_INTERVAL_MS,
  TERM_FLUSH_MAX_BYTES
} from '@shared/constants'
import { emit } from '../ipc/registry'
import { ZmodemReceiver } from './ZmodemReceiver'
import { RzWaitingLineBreakFilter } from './RzWaitingLineBreakFilter'

/**
 * 一个 shell channel = 一个终端 tab。
 * 下行：双阈值批处理（8ms / 256KB）+ 背压（bytesInFlight 水位控制 pause/resume）。
 * 编码：charset 非 utf-8 时在此处用 iconv-lite 双向转码（xterm 只吃 UTF-8）。
 */
export class ShellSession {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private flushTimer: NodeJS.Timeout | null = null
  private bytesInFlight = 0
  private paused = false
  private readonly pauseReasons = new Set<string>()
  private closed = false
  private readonly decoder: { write(buf: Buffer): string; end(): string | undefined } | null
  private readonly rzWaitingFilter = new RzWaitingLineBreakFilter()
  private readonly zmodem: ZmodemReceiver

  constructor(
    readonly termId: TermId,
    private readonly channel: ClientChannel,
    private readonly charset: string,
    onExit: (reason: 'closed' | 'error') => void
  ) {
    const needsConvert = charset.toLowerCase() !== 'utf-8' && iconv.encodingExists(charset)
    this.decoder = needsConvert ? iconv.getDecoder(charset) : null

    this.zmodem = new ZmodemReceiver({
      channel,
      toTerminal: (chunk) => this.enqueueTerminal(chunk),
      pause: (reason) => this.pauseFor(reason),
      resume: (reason) => this.resumeFor(reason)
    })
    channel.on('data', (chunk: Buffer) => this.zmodem.consume(chunk))
    channel.stderr.on('data', (chunk: Buffer) => this.enqueueTerminal(chunk))
    channel.on('close', () => {
      this.closed = true
      this.zmodem.close()
      this.enqueue(this.rzWaitingFilter.flush())
      this.flushNow()
      onExit('closed')
    })
    channel.on('error', () => {
      this.closed = true
      this.zmodem.close()
      this.enqueue(this.rzWaitingFilter.flush())
      this.flushNow()
      onExit('error')
    })
  }

  // ---------- 下行：批处理 + 背压 ----------
  private enqueueTerminal(chunk: Buffer): void {
    const normalized = this.rzWaitingFilter.push(chunk)
    if (normalized.length) this.enqueue(normalized)
  }

  private enqueue(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes >= TERM_FLUSH_MAX_BYTES) {
      this.flushNow()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushNow(), TERM_FLUSH_INTERVAL_MS)
    }
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pendingBytes === 0) return
    let payload = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending)
    this.pending = []
    this.pendingBytes = 0

    if (this.decoder) {
      const text = this.decoder.write(payload)
      if (text.length === 0) return
      payload = Buffer.from(text, 'utf8')
    }

    emit('term:data', {
      termId: this.termId,
      data: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    })
    this.bytesInFlight += payload.byteLength
    if (this.bytesInFlight > TERM_FLOW_PAUSE_BYTES) this.pauseFor('renderer')
  }

  /** renderer 消费确认（term:flow-ack） */
  ack(bytes: number): void {
    this.bytesInFlight = Math.max(0, this.bytesInFlight - bytes)
    if (this.bytesInFlight < TERM_FLOW_RESUME_BYTES) this.resumeFor('renderer')
  }

  private pauseFor(reason: string): void {
    this.pauseReasons.add(reason)
    this.syncChannelPause()
  }

  private resumeFor(reason: string): void {
    this.pauseReasons.delete(reason)
    this.syncChannelPause()
  }

  private syncChannelPause(): void {
    const shouldPause = this.pauseReasons.size > 0
    if (shouldPause === this.paused) return
    this.paused = shouldPause
    if (this.closed) return
    if (shouldPause) this.channel.pause()
    else this.channel.resume()
  }

  // ---------- 上行 ----------
  write(data: string): void {
    if (this.closed) return
    if (this.decoder) {
      this.channel.write(iconv.encode(data, this.charset))
    } else {
      this.channel.write(data)
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return
    this.channel.setWindow(rows, cols, 0, 0)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.zmodem.close()
    this.enqueue(this.rzWaitingFilter.flush())
    this.flushNow()
    this.channel.close()
  }
}
