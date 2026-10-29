import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants, createDeflate, deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import WasmInflator, { compileInflater } from '../src/renderer/vnc/wasm-inflator';

let module: WebAssembly.Module;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const bytes = await readFile(require.resolve('zlib-streams/zlib-streams.wasm'));
  module = await compileInflater(Uint8Array.from(bytes));
});

function sampleBytes(length: number, seed = 0x725ea11): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes;
}

async function persistentStream(rectangles: Uint8Array[]): Promise<Buffer[]> {
  const stream = createDeflate();
  let chunks: Buffer[] = [];
  const compressed: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  for (const rectangle of rectangles) {
    stream.write(rectangle);
    await new Promise<void>((resolve) => stream.flush(constants.Z_SYNC_FLUSH, resolve));
    compressed.push(Buffer.concat(chunks));
    chunks = [];
  }
  const ended = once(stream, 'end');
  stream.end();
  await ended;
  return compressed;
}

function read(inflator: WasmInflator, length: number, sizes: number[]): Buffer {
  const output = Buffer.alloc(length);
  let offset = 0;
  let index = 0;
  while (offset < length) {
    const size = Math.min(sizes[index++ % sizes.length], length - offset);
    output.set(inflator.inflate(size), offset);
    offset += size;
  }
  return output;
}

describe('WASM inflator', () => {
  it('reconstructs raw-tile and palette-style reads across input and output buffer boundaries', () => {
    const source = sampleBytes(512 * 1024 + 37);
    const inflator = new WasmInflator(module);
    inflator.setInput(deflateSync(source));

    const output = read(inflator, source.length, [1, 3, 1, 6, 12_288, 1, 4096]);
    expect(output.equals(source)).toBe(true);
  });

  it('handles a long compressed match consumed one byte at a time', () => {
    const source = Buffer.alloc(256 * 1024 + 101, 0x7b);
    const inflator = new WasmInflator(module);
    inflator.setInput(deflateSync(source));

    expect(read(inflator, source.length, [1]).equals(source)).toBe(true);
  });

  it('preserves the dictionary between sync-flushed rectangles while input sizes grow', async () => {
    const dictionary = sampleBytes(24 * 1024);
    const source = [dictionary, dictionary, sampleBytes(384 * 1024, 0x17cab), Buffer.from('final rectangle')];
    const compressed = await persistentStream(source);
    // This rectangle can only be reconstructed using the previous dictionary.
    expect(compressed[1].length).toBeLessThan(compressed[0].length / 10);
    const inflator = new WasmInflator(module);

    for (let i = 0; i < source.length; i++) {
      inflator.setInput(compressed[i]);
      expect(read(inflator, source[i].length, [1, 3, 8192]).equals(source[i])).toBe(true);
      inflator.setInput(null);
    }
  });

  it('fulfills a request larger than the WASM output buffer', () => {
    const source = sampleBytes(1024 * 1024 + 11);
    const inflator = new WasmInflator(module);
    inflator.setInput(deflateSync(source));

    expect(Buffer.from(inflator.inflate(source.length)).equals(source)).toBe(true);
  });

  it.each([
    { length: 128 * 1024, kind: 'random' },
    { length: 256 * 1024, kind: 'random' },
    { length: 128 * 1024, kind: 'solid' },
    { length: 256 * 1024, kind: 'solid' },
  ])('preserves sync-flush framing after exactly $length $kind output bytes', async ({ length, kind }) => {
    const first = kind === 'random' ? sampleBytes(length) : Buffer.alloc(length, 0x17);
    const source = [first, Buffer.concat([first.subarray(-24 * 1024), Buffer.from('next rectangle')])];
    const compressed = await persistentStream(source);
    const inflator = new WasmInflator(module);

    for (let i = 0; i < source.length; i++) {
      inflator.setInput(compressed[i]);
      expect(read(inflator, source[i].length, [1, 3, 12_288]).equals(source[i])).toBe(true);
    }
  });

  it('resets both the dictionary and unread buffered output', () => {
    const inflator = new WasmInflator(module);
    inflator.setInput(deflateSync(Buffer.alloc(256 * 1024, 0x71)));
    expect(inflator.inflate(1)[0]).toBe(0x71);

    for (let i = 0; i < 20; i++) {
      const source = Buffer.alloc(1024 + i, i);
      inflator.reset();
      inflator.setInput(deflateSync(source));
      expect(Buffer.from(inflator.inflate(source.length)).equals(source)).toBe(true);
    }
  });

  it('isolates the state and output memory of instances sharing a compiled module', () => {
    const first = new WasmInflator(module);
    const second = new WasmInflator(module);
    const source = sampleBytes(1024);
    first.setInput(deflateSync(source));
    const firstView = first.inflate(64);
    second.setInput(deflateSync(Buffer.alloc(1024, 0xdd)));
    second.inflate(1024);

    expect(Buffer.from(firstView).equals(source.subarray(0, 64))).toBe(true);
    expect(Buffer.from(first.inflate(960)).equals(source.subarray(64))).toBe(true);
  });

  it('reports truncated compressed input instead of returning incomplete output', () => {
    const source = sampleBytes(256 * 1024);
    const compressed = deflateSync(source);
    const inflator = new WasmInflator(module);
    inflator.setInput(compressed.subarray(0, Math.floor(compressed.length / 2)));

    expect(() => inflator.inflate(source.length)).toThrow('Incomplete zlib block');
  });

  it('reports corrupt compressed input as a zlib failure', () => {
    const inflator = new WasmInflator(module);
    inflator.setInput(new Uint8Array([0, 0, 0, 0]));

    expect(() => inflator.inflate(1)).toThrow('zlib inflate failed');
  });
});
