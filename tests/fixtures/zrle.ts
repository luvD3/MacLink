import { constants, createDeflate } from 'node:zlib';

export const zrleModes = ['raw', 'solid', 'palette2', 'palette4', 'palette16', 'rle', 'paletteRle'] as const;
export type ZrleMode = typeof zrleModes[number];
export interface RectangleOptions {
  width: number;
  height: number;
  x?: number;
  y?: number;
  mode?: ZrleMode | 'mixed';
  seed?: number;
}
export interface EncodedZrleRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  uncompressed: Buffer;
  expectedRgba: Uint8Array;
  tileCount: number;
  modeCounts: Record<ZrleMode, number>;
}
export interface CompressedZrleRectangle extends Omit<EncodedZrleRectangle, 'uncompressed'> {
  compressed: Uint8Array;
  wire: Uint8Array;
  uncompressedBytes: number;
}

/** Entirely synthetic: text-like palette tiles, flat panels, runs, and noisy gradients. */
export function encodeZrleRectangle({ width, height, x = 0, y = 0, mode = 'mixed', seed = 1 }: RectangleOptions): EncodedZrleRectangle {
  const rgba = new Uint8Array(width * height * 4);
  const chunks: Buffer[] = [];
  const modeCounts = Object.fromEntries(zrleModes.map((value) => [value, 0])) as Record<ZrleMode, number>;
  let tileCount = 0;

  for (let tileY = 0; tileY < height; tileY += 64) {
    for (let tileX = 0; tileX < width; tileX += 64) {
      const tileWidth = Math.min(64, width - tileX);
      const tileHeight = Math.min(64, height - tileY);
      const pixels = tileWidth * tileHeight;
      const tileSeed = seed + tileX * 3 + tileY * 7;
      const selected = mode === 'mixed' ? zrleModes[(tileCount + seed) % zrleModes.length] : mode;
      modeCounts[selected]++;
      tileCount++;
      const bytes: number[] = [];
      const palette = (index: number): [number, number, number] => [
        (47 + tileSeed + index * 37) & 255,
        (91 + tileSeed * 3 + index * 71) & 255,
        (137 + tileSeed * 5 + index * 19) & 255,
      ];
      const pixel = (position: number, color: readonly number[]) => {
        const px = tileX + position % tileWidth;
        const py = tileY + Math.floor(position / tileWidth);
        const offset = (py * width + px) * 4;
        rgba[offset] = color[0]; rgba[offset + 1] = color[1]; rgba[offset + 2] = color[2]; rgba[offset + 3] = 255;
      };
      const runLength = (length: number) => {
        let remaining = length - 1;
        while (remaining >= 255) { bytes.push(255); remaining -= 255; }
        bytes.push(remaining);
      };

      if (selected === 'raw') {
        bytes.push(0);
        for (let position = 0; position < pixels; position++) {
          const px = tileX + position % tileWidth;
          const py = tileY + Math.floor(position / tileWidth);
          const noise = ((Math.imul(px + tileSeed, 1664525) ^ Math.imul(py + 1, 1013904223)) >>> 22) & 31;
          const color = [(px * 3 + py + noise) & 255, (px + py * 2 + noise) & 255, (px * 2 + py * 3 + tileSeed) & 255];
          bytes.push(...color); pixel(position, color);
        }
      } else if (selected === 'solid') {
        const color = palette(0);
        bytes.push(1, ...color);
        for (let position = 0; position < pixels; position++) pixel(position, color);
      } else if (selected === 'palette2' || selected === 'palette4' || selected === 'palette16') {
        const count = selected === 'palette2' ? 2 : selected === 'palette4' ? 4 : 16;
        const bits = count === 2 ? 1 : count === 4 ? 2 : 4;
        const colors = Array.from({ length: count }, (_, index) => palette(index));
        bytes.push(count, ...colors.flat());
        for (let row = 0; row < tileHeight; row++) {
          let packed = 0; let shift = 8 - bits;
          for (let column = 0; column < tileWidth; column++) {
            const index = count === 2
              ? Number(row % 13 < 2 || ((column + seed) % 17 < 2 && row % 13 < 10))
              : (Math.floor(column / 4) + Math.floor(row / 6) * 3 + seed) % count;
            packed |= index << shift;
            pixel(row * tileWidth + column, colors[index]);
            if (shift === 0 || column === tileWidth - 1) { bytes.push(packed); packed = 0; shift = 8 - bits; }
            else shift -= bits;
          }
        }
      } else {
        const colors = Array.from({ length: 7 }, (_, index) => palette(index));
        bytes.push(selected === 'rle' ? 128 : 128 + colors.length);
        if (selected === 'paletteRle') bytes.push(...colors.flat());
        let position = 0; let run = 0;
        while (position < pixels) {
          const index = (run + seed) % colors.length;
          const length = Math.min(pixels - position, run % 6 === 0 ? 1 : 2 + ((run * 31 + seed) % 350));
          if (selected === 'rle') { bytes.push(...colors[index]); runLength(length); }
          else if (length === 1) bytes.push(index);
          else { bytes.push(index | 128); runLength(length); }
          for (let item = 0; item < length; item++) pixel(position + item, colors[index]);
          position += length; run++;
        }
      }
      chunks.push(Buffer.from(bytes));
    }
  }
  return { x, y, width, height, uncompressed: Buffer.concat(chunks), expectedRgba: rgba, tileCount, modeCounts };
}

/** One compressor and dictionary span all rectangles, as in a persistent RFB session. */
export async function compressZrleRectangles(rectangles: EncodedZrleRectangle[], { level = 6 }: { level?: number } = {}): Promise<CompressedZrleRectangle[]> {
  const compressor = createDeflate({ level });
  let chunks: Buffer[] = [];
  let compressionError: Error | undefined;
  compressor.on('data', (chunk: Buffer) => chunks.push(chunk));
  compressor.on('error', (error: Error) => { compressionError = error; });
  const result: CompressedZrleRectangle[] = [];
  try {
    for (const rectangle of rectangles) {
      await new Promise<void>((resolve, reject) => {
        compressor.write(rectangle.uncompressed, (error) => {
          if (error) { reject(error); return; }
          compressor.flush(constants.Z_SYNC_FLUSH, () => compressionError ? reject(compressionError) : resolve());
        });
      });
      if (compressionError) throw compressionError;
      const compressed = Buffer.concat(chunks);
      chunks = [];
      const wire = Buffer.allocUnsafe(4 + compressed.length);
      wire.writeUInt32BE(compressed.length, 0);
      compressed.copy(wire, 4);
      const { uncompressed, ...metadata } = rectangle;
      result.push({ ...metadata, uncompressedBytes: uncompressed.length, compressed, wire });
    }
    return result;
  } finally {
    compressor.destroy();
  }
}

export async function createZrleFixture({ width = 3840, height = 2160, frames = 3, seed = 1, mode = 'mixed' }: Partial<RectangleOptions> & { frames?: number } = {}): Promise<CompressedZrleRectangle[]> {
  return compressZrleRectangles(Array.from({ length: frames }, (_, frame) => encodeZrleRectangle({ width, height, seed: seed + frame, mode })));
}
