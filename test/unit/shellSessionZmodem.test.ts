import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Zmodem from 'zmodem.js'
import { emit } from '../../src/main/ipc/registry'
import { ShellSession } from '../../src/main/ssh/ShellSession'
import type { TermId } from '../../src/shared/types'

const { showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(() => new Promise(() => {})),
  showSaveDialog: vi.fn(() => new Promise(() => {}))
}))

vi.mock('../../src/main/ipc/registry', () => ({ emit: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog, showSaveDialog } }))
vi.mock('../../src/main/window', () => ({ getMainWindow: () => null }))
vi.mock('../../src/main/utils/logger', () => ({
  scopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter()
  readonly writes: Array<string | Buffer> = []
  readonly pause = vi.fn()
  readonly resume = vi.fn()
  readonly setWindow = vi.fn()
  readonly close = vi.fn()

  write(data: string | Buffer): boolean {
    this.writes.push(data)
    return true
  }
}

function renderedText(): string {
  const calls = vi.mocked(emit).mock.calls
  return calls
    .filter(([event]) => event === 'term:data')
    .map(([, payload]) => Buffer.from((payload as { data: Uint8Array }).data).toString('utf8'))
    .join('')
}

describe('SSH ZMODEM terminal handling', () => {
  let channel: FakeChannel
  let session: ShellSession

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(emit).mockClear()
    showOpenDialog.mockClear()
    showSaveDialog.mockClear()
    channel = new FakeChannel()
    session = new ShellSession('zmodem-test' as TermId, channel as never, 'utf-8', vi.fn())
  })

  afterEach(() => {
    session.close()
    vi.useRealTimers()
  })

  it('does not render a ZMODEM startup header as shell text', async () => {
    const header = Buffer.from(Zmodem.Header.build('ZRQINIT').to_hex())
    channel.emit('data', Buffer.concat([Buffer.from('ordinary output\r\n'), header]))
    await vi.advanceTimersByTimeAsync(50)

    expect(renderedText()).toContain('ordinary output')
    expect(renderedText()).not.toContain('**\x18B')
    expect(channel.writes.some((write) => Buffer.isBuffer(write) && write.includes(0x18))).toBe(true)
  })

  it('opens the upload picker when the remote rz side sends a valid ZRINIT header', () => {
    const header = Buffer.from(Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANFC32']).to_hex())
    channel.emit('data', header)

    expect(showOpenDialog).toHaveBeenCalledOnce()
  })

  it('holds a split ZMODEM startup header until the complete frame can be parsed', async () => {
    const header = Buffer.from(Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANFC32']).to_hex())
    channel.emit('data', header.subarray(0, 8))
    await vi.advanceTimersByTimeAsync(50)
    expect(renderedText()).not.toContain('**\x18B')

    channel.emit('data', header.subarray(8))
    await vi.advanceTimersByTimeAsync(50)

    expect(showOpenDialog).toHaveBeenCalledOnce()
    expect(renderedText()).not.toContain('**\x18B')
  })

  it('recognizes a split startup marker that follows ordinary output', async () => {
    const prefix = Buffer.from('ordinary output that is longer than the parser cache')
    const header = Buffer.from(Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANFC32']).to_hex())
    channel.emit('data', Buffer.concat([prefix, header.subarray(0, 4)]))
    channel.emit('data', header.subarray(4))
    await vi.advanceTimersByTimeAsync(50)

    expect(showOpenDialog).toHaveBeenCalledOnce()
    expect(renderedText()).toContain(prefix.toString())
    expect(renderedText()).not.toContain('**\x18B')
  })

  it('keeps the typed rz command and the remote command echo visible', async () => {
    session.write('rz')
    channel.emit('data', Buffer.from('rz\r\n'))
    await vi.advanceTimersByTimeAsync(50)

    expect(channel.writes).toEqual(['rz'])
    expect(renderedText()).toContain('rz\r\n')
  })

  it('starts the shell prompt on a new line after the rz waiting message', async () => {
    channel.emit('data', Buffer.from('rz waiting to receive.root@Debian:~# '))
    await vi.advanceTimersByTimeAsync(50)

    expect(renderedText()).toContain('rz waiting to receive.\r\nroot@Debian:~# ')
  })

  it('normalizes a split rz waiting message without adding a blank line', async () => {
    channel.emit('data', Buffer.from('rz waiting to rece'))
    channel.emit('data', Buffer.from('ive.\r\nroot@Debian:~# '))
    await vi.advanceTimersByTimeAsync(50)

    expect(renderedText()).toBe('rz waiting to receive.\r\nroot@Debian:~# ')
  })
})
