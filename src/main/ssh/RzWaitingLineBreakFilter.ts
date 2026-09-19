const WAITING_MESSAGE = Buffer.from('rz waiting to receive.')

/** Inserts a line break after lrzsz's status text when the shell prompt follows it. */
export class RzWaitingLineBreakFilter {
  private pending = Buffer.alloc(0)
  private skipNextLineEnding = false

  push(chunk: Buffer): Buffer {
    if (chunk.length === 0) return chunk
    let input = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)

    if (this.skipNextLineEnding) {
      if (input[0] === 0x0d) {
        input = input.subarray(input[1] === 0x0a ? 2 : 1)
        this.skipNextLineEnding = input.length === 0
      } else if (input[0] === 0x0a) {
        input = input.subarray(1)
        this.skipNextLineEnding = false
      } else this.skipNextLineEnding = false
      if (input.length === 0) return input
    }

    const output: Buffer[] = []
    let offset = 0
    while (offset < input.length) {
      const match = input.indexOf(WAITING_MESSAGE, offset)
      if (match < 0) {
        const remaining = input.subarray(offset)
        const keep = this.partialMatchLength(remaining)
        if (keep > 0) {
          output.push(remaining.subarray(0, remaining.length - keep))
          this.pending = Buffer.from(remaining.subarray(remaining.length - keep))
        } else {
          output.push(remaining)
        }
        break
      }

      output.push(input.subarray(offset, match + WAITING_MESSAGE.length), Buffer.from('\r\n'))
      offset = match + WAITING_MESSAGE.length
      if (offset === input.length) {
        this.skipNextLineEnding = true
      } else if (input[offset] === 0x0d) {
        offset += input[offset + 1] === 0x0a ? 2 : 1
      } else if (input[offset] === 0x0a) {
        offset++
      }
    }

    return output.length === 0 ? Buffer.alloc(0) : Buffer.concat(output)
  }

  flush(): Buffer {
    const pending = this.pending
    this.pending = Buffer.alloc(0)
    this.skipNextLineEnding = false
    return pending
  }

  private partialMatchLength(input: Buffer): number {
    const max = Math.min(input.length, WAITING_MESSAGE.length - 1)
    for (let length = max; length > 0; length--) {
      if (input.subarray(input.length - length).equals(WAITING_MESSAGE.subarray(0, length))) return length
    }
    return 0
  }
}
