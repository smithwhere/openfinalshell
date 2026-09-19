import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Zmodem from 'zmodem.js'
import type { SendSession, Session } from 'zmodem.js'
import { ZmodemReceiver } from '../../src/main/ssh/ZmodemReceiver'

const { showOpenDialog, showSaveDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({ dialog: { showOpenDialog, showSaveDialog } }))
vi.mock('../../src/main/window', () => ({ getMainWindow: () => null }))
vi.mock('../../src/main/utils/logger', () => ({
  scopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

class FakeChannel extends EventEmitter {
  readonly writes: Buffer[] = []
  peerInput: ((chunk: Buffer) => void) | null = null
  readonly pause = vi.fn()
  readonly resume = vi.fn()

  write(data: string | Buffer): boolean {
    const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data)
    this.writes.push(bytes)
    this.peerInput?.(bytes)
    return true
  }
}

describe('ZMODEM receiver file download', () => {
  let directory: string
  let targetPath: string
  let channel: FakeChannel
  let receiver: ZmodemReceiver
  let remoteSession: SendSession | null
  let terminal: Buffer[]

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ofs-zmodem-'))
    targetPath = join(directory, 'download.bin')
    vi.mocked(showSaveDialog).mockReset().mockResolvedValue({ canceled: false, filePath: targetPath })
    vi.mocked(showOpenDialog).mockReset()
    channel = new FakeChannel()
    terminal = []
    remoteSession = null
    const remoteSentry = new Zmodem.Sentry({
      to_terminal: () => undefined,
      sender: (octets) => receiver.consume(Buffer.from(octets)),
      on_detect: (detection) => { remoteSession = detection.confirm() as SendSession },
      on_retract: () => undefined
    })
    channel.peerInput = (chunk) => remoteSentry.consume(new Uint8Array(chunk))
    receiver = new ZmodemReceiver({
      channel: channel as never,
      toTerminal: (chunk) => terminal.push(Buffer.from(chunk)),
      pause: () => undefined,
      resume: () => undefined
    })
  })

  afterEach(async () => {
    receiver.close()
    vi.clearAllTimers()
    await rm(directory, { recursive: true, force: true })
  })

  it('streams offered bytes into the chosen path and accepts a second sz session', async () => {
    const firstPayload = Buffer.from([0, 1, 2, 0xff, 0x0d, 0x0a, 0x18, 0x2a])
    await transferFromRemote('/root/.ssh/id_ed25519', firstPayload)
    await vi.waitFor(async () => expect(await readFile(targetPath)).toEqual(firstPayload))
    expect(showSaveDialog).toHaveBeenCalledOnce()
    expect(showSaveDialog.mock.calls[0][0]).toEqual({ defaultPath: 'id_ed25519' })

    const secondPath = join(directory, 'second.bin')
    vi.mocked(showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: secondPath })
    const secondPayload = Buffer.from('second transfer')
    await transferFromRemote('/tmp/second.bin', secondPayload)
    await vi.waitFor(async () => expect(await readFile(secondPath)).toEqual(secondPayload))
    expect(showSaveDialog).toHaveBeenCalledTimes(2)
  })

  it('streams files selected for rz to the remote receiver', async () => {
    const sourcePath = join(directory, 'upload.bin')
    const payload = Buffer.from([0, 0xff, 0x18, 0x2a, 0x0d, 0x0a, 1, 2, 3])
    const received: Buffer[] = []
    const RemoteReceive = (Zmodem as unknown as { Session: { Receive: new () => Session } }).Session.Receive
    const remoteReceive = new RemoteReceive()
    remoteReceive.set_sender((octets) => receiver.consume(Buffer.from(octets)))
    remoteReceive.on('garbage', () => undefined)
    remoteReceive.on('offer', (offer) => {
      offer.on('input', (octets) => received.push(Buffer.from(octets)))
      void offer.accept()
    })
    channel.peerInput = (chunk) => remoteReceive.consume(Array.from(chunk))
    await writeFile(sourcePath, payload)
    vi.mocked(showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [sourcePath] })

    const ended = new Promise<void>((resolve) => remoteReceive.on('session_end', resolve))
    remoteReceive.start()
    await ended

    expect(showOpenDialog).toHaveBeenCalledOnce()
    expect(Buffer.concat(received)).toEqual(payload)
  })

  it('skips an incoming sz offer when the save dialog is canceled', async () => {
    vi.mocked(showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: '' })
    receiver.consume(Buffer.from(Zmodem.Header.build('ZRQINIT').to_hex()))
    if (!remoteSession) throw new Error('the local ZRINIT response did not establish a sender session')

    const transfer = await remoteSession.send_offer({ name: '../../etc/passwd', size: 1 })
    expect(transfer).toBeUndefined()
    await remoteSession.close()

    expect(showSaveDialog).toHaveBeenCalledOnce()
    expect(showSaveDialog.mock.calls[0][0]).toEqual({ defaultPath: 'passwd' })
    await expect(readFile(join(directory, 'passwd'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('closes the upload session cleanly when the file picker is canceled', async () => {
    const RemoteReceive = (Zmodem as unknown as { Session: { Receive: new () => Session } }).Session.Receive
    const remoteReceive = new RemoteReceive()
    remoteReceive.set_sender((octets) => receiver.consume(Buffer.from(octets)))
    remoteReceive.on('garbage', () => undefined)
    channel.peerInput = (chunk) => remoteReceive.consume(Array.from(chunk))
    vi.mocked(showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    const ended = new Promise<void>((resolve) => remoteReceive.on('session_end', resolve))

    remoteReceive.start()
    await ended

    expect(showOpenDialog).toHaveBeenCalledOnce()
  })

  it('removes the incomplete temporary file when the SSH shell closes mid-download', async () => {
    receiver.consume(Buffer.from(Zmodem.Header.build('ZRQINIT').to_hex()))
    if (!remoteSession) throw new Error('the local ZRINIT response did not establish a sender session')
    const transfer = await remoteSession.send_offer({ name: 'unfinished.bin', size: 1024 })
    expect(transfer).toBeDefined()
    await vi.waitFor(async () => expect((await readdir(directory)).some((name) => name.endsWith('.part'))).toBe(true))

    receiver.close()

    await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]))
  })

  async function transferFromRemote(remoteName: string, bytes: Buffer): Promise<void> {
    receiver.consume(Buffer.from(Zmodem.Header.build('ZRQINIT').to_hex()))
    if (!remoteSession) throw new Error('the local ZRINIT response did not establish a sender session')
    const transfer = await remoteSession.send_offer({ name: remoteName, size: bytes.length })
    if (!transfer) throw new Error('the local receiver skipped the file')
    transfer.send(bytes.subarray(0, Math.min(3, bytes.length)))
    const finalChunk = bytes.subarray(Math.min(3, bytes.length))
    await transfer.end(finalChunk)
    await remoteSession.close()
  }
})
