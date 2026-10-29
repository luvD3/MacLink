import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import ZRLEDecoder from '../src/renderer/vnc/zrle-decoder';
import { compressZrleRectangles, encodeZrleRectangle, zrleModes } from './fixtures/zrle';

class Socket {
  private data = new Uint8Array(0);
  private offset = 0;
  push(data: Uint8Array): void {
    this.data = Buffer.concat([this.data.subarray(this.offset), data]);
    this.offset = 0;
  }
  rQwait(_reason: string, length: number): boolean { return this.data.length - this.offset < length; }
  rQshift32(): number {
    const value = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4).getUint32(0);
    this.offset += 4;
    return value;
  }
  rQshiftBytes(length: number): Uint8Array {
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

function displayFor(width: number, height: number, originX = 0, originY = 0) {
  const pixels = new Uint8Array(width * height * 4);
  let uploads = 0;
  return {
    pixels,
    get uploads() { return uploads; },
    blitImage(x: number, y: number, w: number, h: number, data: Uint8Array, offset = 0) {
      uploads++;
      for (let row = 0; row < h; row++) {
        const start = offset + row * w * 4;
        pixels.set(data.subarray(start, start + w * 4), ((y - originY + row) * width + x - originX) * 4);
      }
    },
    fillRect(x: number, y: number, w: number, h: number, color: ArrayLike<number>) {
      uploads++;
      for (let row = 0; row < h; row++) {
        for (let column = 0; column < w; column++) {
          const index = ((y - originY + row) * width + x - originX + column) * 4;
          pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = 255;
        }
      }
    },
  };
}

function socketFor(uncompressed: Uint8Array): Socket {
  const compressed = deflateSync(uncompressed);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(compressed.length);
  const socket = new Socket();
  socket.push(Buffer.concat([prefix, compressed]));
  return socket;
}

describe('ZRLE pixel expansion', () => {
  it.each(zrleModes)('matches independent RGBA for %s with edge tiles and a persistent stream', async mode => {
    const fixtures = [1, 2, 3].map(seed => encodeZrleRectangle({ x: 11, y: 17, width: 131, height: 129, mode, seed }));
    const rectangles = await compressZrleRectangles(fixtures);
    const decoder = new ZRLEDecoder();
    const socket = new Socket();
    for (const { x, y, width, height, wire, expectedRgba } of rectangles) {
      const display = displayFor(width, height, x, y);
      socket.push(wire.subarray(0, 2));
      expect(decoder.decodeRect(x, y, width, height, socket, display, 24)).toBe(false);
      socket.push(wire.subarray(2, wire.length - 1));
      expect(decoder.decodeRect(x, y, width, height, socket, display, 24)).toBe(false);
      expect(display.uploads).toBe(0);
      socket.push(wire.subarray(wire.length - 1));
      expect(decoder.decodeRect(x, y, width, height, socket, display, 24)).toBe(true);
      expect(Buffer.from(display.pixels).equals(expectedRgba)).toBe(true);
    }
  });

  it.each([3, 5, 7, 15])('unpacks a %i-color palette with row padding', paletteSize => {
    const width = 11, height = 3;
    const bits = paletteSize <= 4 ? 2 : 4;
    const colors = Array.from({ length: paletteSize }, (_, index) => [index * 13, 255 - index * 11, index * 7]);
    const bytes = [paletteSize, ...colors.flat()];
    const expected = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      let packed = 0, shift = 8 - bits;
      for (let column = 0; column < width; column++) {
        const index = (row * 7 + column * 3 + 1) % paletteSize;
        packed |= index << shift;
        expected.set([...colors[index], 255], (row * width + column) * 4);
        if (shift === 0 || column === width - 1) { bytes.push(packed); packed = 0; shift = 8 - bits; }
        else shift -= bits;
      }
    }
    const display = displayFor(width, height);
    expect(new ZRLEDecoder().decodeRect(0, 0, width, height, socketFor(Uint8Array.from(bytes)), display, 24)).toBe(true);
    expect(display.pixels).toEqual(expected);
  });

  it('matches the full mixed 4K fixture', async () => {
    const [rectangle] = await compressZrleRectangles([encodeZrleRectangle({ width: 3840, height: 2160 })]);
    const socket = new Socket();
    socket.push(rectangle.wire);
    const display = displayFor(rectangle.width, rectangle.height);
    expect(new ZRLEDecoder().decodeRect(0, 0, rectangle.width, rectangle.height, socket, display, 24)).toBe(true);
    expect(Buffer.from(display.pixels).equals(rectangle.expectedRgba)).toBe(true);
  });

  it.each([
    { name: 'plain run beyond tile', bytes: [128, 10, 20, 30, 4], error: /run exceeds tile size/ },
    { name: 'palette index equal to palette size', bytes: [130, 10, 20, 30, 40, 50, 60, 2], error: /palette index/ },
    { name: 'palette run beyond tile', bytes: [130, 10, 20, 30, 40, 50, 60, 128, 4], error: /palette run exceeds/ },
  ])('rejects $name', ({ bytes, error }) => {
    const display = displayFor(4, 1);
    expect(() => new ZRLEDecoder().decodeRect(0, 0, 4, 1, socketFor(Uint8Array.from(bytes)), display, 24)).toThrow(error);
    expect(display.uploads).toBe(0);
  });
});
