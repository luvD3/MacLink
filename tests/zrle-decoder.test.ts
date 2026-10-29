import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import BufferedInflator from '../src/renderer/vnc/buffered-inflator';
import { TileBatch, type PixelDisplay } from './helpers/tile-batch';
import { compressZrleRectangles, encodeZrleRectangle, zrleModes } from './fixtures/zrle';

const require = createRequire(import.meta.url);
const decoderUrl = pathToFileURL(path.join(path.dirname(require.resolve('@novnc/novnc')), 'decoders/zrle.js')).href;
const { default: Decoder } = await import(/* @vite-ignore */ decoderUrl);

class Socket {
  private data = new Uint8Array(0);
  private offset = 0;
  push(data: Uint8Array): void { this.data = Buffer.concat([this.data.subarray(this.offset), data]); this.offset = 0; }
  rQwait(_reason: string, length: number): boolean { return this.data.length - this.offset < length; }
  rQshift32(): number { const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getUint32(0); this.offset += 4; return value; }
  rQshiftBytes(length: number): Uint8Array { const value = this.data.subarray(this.offset, this.offset + length); this.offset += length; return value; }
}

function memoryDisplay(x: number, y: number, width: number, height: number) {
  const storage = new TileBatch();
  storage.begin(x, y, width, height);
  let uploads = 0;
  return {
    ...{ fillRect: storage.fillRect.bind(storage) },
    blitImage(...args: Parameters<PixelDisplay['blitImage']>) {
      uploads++;
      const [px, py, w, h, data, offset] = args;
      storage.blitImage(px, py, w, h, data, offset);
    },
    get uploads() { return uploads; },
    pixels(): Uint8Array {
      let result!: Uint8Array;
      storage.commit({ fillRect() {}, blitImage(_x, _y, w, h, pixels) { result = pixels.slice(0, w * h * 4); } });
      return result;
    },
  };
}

describe('ZRLE decode adapter', () => {
  it.each(zrleModes)('preserves exact RGBA for %s tiles, edge rows, offsets, and a persistent stream', async mode => {
    const input = [1, 2, 3].map(seed => encodeZrleRectangle({ x: 11, y: 17, width: 130, height: 129, mode, seed }));
    const rectangles = await compressZrleRectangles(input);
    const decoder = new Decoder();
    decoder._inflator = new BufferedInflator();
    const batch = new TileBatch();
    const socket = new Socket();
    for (const rectangle of rectangles) {
      const { x, y, width, height, wire, expectedRgba } = rectangle;
      const display = memoryDisplay(x, y, width, height);
      batch.begin(x, y, width, height);
      // Fragment both the length prefix and the compressed data. Nothing should
      // be painted until the complete rectangle can be decoded.
      socket.push(wire.subarray(0, 2));
      expect(decoder.decodeRect(x, y, width, height, socket, batch, 24)).toBe(false);
      socket.push(wire.subarray(2, wire.length - 1));
      expect(decoder.decodeRect(x, y, width, height, socket, batch, 24)).toBe(false);
      expect(display.uploads).toBe(0);
      socket.push(wire.subarray(wire.length - 1));
      expect(decoder.decodeRect(x, y, width, height, socket, batch, 24)).toBe(true);
      batch.commit(display);
      expect(display.uploads).toBe(1);
      expect(Buffer.from(display.pixels()).equals(expectedRgba)).toBe(true);
    }
  });

  it('matches upstream and expected pixels for a complete mixed 4K rectangle', async () => {
    const [rectangle] = await compressZrleRectangles([encodeZrleRectangle({ width: 3840, height: 2160 })]);
    for (const optimized of [false, true]) {
      const decoder = new Decoder();
      if (optimized) decoder._inflator = new BufferedInflator();
      const socket = new Socket();
      socket.push(rectangle.wire);
      const display = memoryDisplay(0, 0, rectangle.width, rectangle.height);
      expect(decoder.decodeRect(0, 0, rectangle.width, rectangle.height, socket, display, 24)).toBe(true);
      expect(Buffer.from(display.pixels()).equals(rectangle.expectedRgba)).toBe(true);
    }
  });

  it('keeps source byte offsets and reuses a larger tile buffer for a smaller update', () => {
    const batch = new TileBatch();
    batch.begin(0, 0, 100, 100);
    batch.fillRect(0, 0, 100, 100, [1, 2, 3]);
    batch.begin(5, 7, 2, 1);
    const source = new Uint8Array([9, 9, 9, 9, 10, 20, 30, 255, 40, 50, 60, 255, 9]);
    batch.blitImage(5, 7, 2, 1, source.subarray(1), 3);
    const display = memoryDisplay(5, 7, 2, 1);
    batch.commit(display);
    expect([...display.pixels()]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });
});
