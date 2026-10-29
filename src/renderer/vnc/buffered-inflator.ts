import { inflateInit, inflate, inflateReset } from '@maclink/novnc-zlib';
import ZStream from '@maclink/novnc-zstream';

/**
 * ZRLE-only adapter for noVNC 1.7's Inflate interface. Decode ahead in 64 KiB
 * blocks so palette/RLE byte reads do not re-enter pako for every byte.
 * setInput replaces a complete compressed rectangle; it keeps the zlib window.
 * Returned views, like upstream Inflate's views, are valid until the next read.
 */
export default class BufferedInflator {
  private readonly strm = new ZStream();
  private output = new Uint8Array(64 * 1024);
  private readOffset = 0;
  private writeOffset = 0;

  constructor() {
    this.strm.output = this.output;
    inflateInit(this.strm);
  }

  setInput(data: Uint8Array | null): void {
    this.strm.input = data;
    this.strm.next_in = 0;
    this.strm.avail_in = data?.length ?? 0;
  }

  inflate(expected: number): Uint8Array {
    if (this.writeOffset - this.readOffset < expected) {
      const remaining = this.writeOffset - this.readOffset;
      if (expected > this.output.length) {
        const larger = new Uint8Array(Math.max(expected, this.output.length * 2));
        larger.set(this.output.subarray(this.readOffset, this.writeOffset));
        this.output = larger;
      } else if (remaining) {
        this.output.copyWithin(0, this.readOffset, this.writeOffset);
      }
      this.readOffset = 0;
      this.strm.output = this.output;
      this.strm.next_out = remaining;
      this.strm.avail_out = this.output.length - remaining;

      // Call even with no input left: pako can still have a pending match to emit.
      const status = inflate(this.strm, 0);
      this.writeOffset = this.strm.next_out;
      if (status < 0) throw new Error('zlib inflate failed');
      if (this.writeOffset < expected) throw new Error('Incomplete zlib block');
    }

    const start = this.readOffset;
    this.readOffset += expected;
    return this.output.subarray(start, this.readOffset);
  }

  reset(): void {
    inflateReset(this.strm);
    this.readOffset = 0;
    this.writeOffset = 0;
  }
}
