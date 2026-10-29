// Synthetic data only. No application/CDP connection or remote pixels are used.
// Run: node scripts/bench-inflate.mjs [rounds=5]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDeflate, deflateSync, constants } from 'node:zlib';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const novnc = new URL('node_modules/@novnc/novnc/', root);
const { default: OriginalInflator } = await import(new URL('core/inflator.js', novnc));
const { default: ZRLEDecoder } = await import(new URL('core/decoders/zrle.js', novnc));
const source = await readFile(new URL('src/renderer/vnc/buffered-inflator.ts', root), 'utf8');
let compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const [alias, relative] of [
  ['@maclink/novnc-zlib', 'vendor/pako/lib/zlib/inflate.js'],
  ['@maclink/novnc-zstream', 'vendor/pako/lib/zlib/zstream.js'],
]) {
  compiled = compiled.replaceAll(`'${alias}'`, JSON.stringify(pathToFileURL(fileURLToPath(new URL(relative, novnc))).href));
}
const { default: BufferedInflator } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const rounds = Number(process.argv[2] ?? 5);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Math.round(value * 100) / 100;

async function compressFrames(frames) {
  const compressor = createDeflate({ level: 6 });
  let chunks = [];
  compressor.on('data', chunk => { chunks.push(chunk); });
  const packets = [];
  for (const frame of frames) {
    await new Promise((resolve, reject) => compressor.write(frame, error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => compressor.flush(constants.Z_SYNC_FLUSH, error => error ? reject(error) : resolve()));
    packets.push(Buffer.concat(chunks));
    chunks = [];
  }
  compressor.close();
  return packets;
}

function makeFixture(mode, seed, width = 3840, height = 2160) {
  const bytes = new Uint8Array(width * height * 4 + 4096);
  const reads = [];
  let offset = 0;
  const byte = value => { bytes[offset++] = value; reads.push(1); };
  const colors = (count, tile) => {
    for (let i = 0; i < count; i++) {
      bytes[offset++] = (i * 17 + tile * 7 + seed) & 255;
      bytes[offset++] = (i * 31 + tile + seed * 3) & 255;
      bytes[offset++] = (i * 53 + tile * 3 + seed * 5) & 255;
    }
    reads.push(count * 3);
  };
  const runLength = length => {
    let encoded = length - 1;
    while (encoded >= 255) { byte(255); encoded -= 255; }
    byte(encoded);
  };
  let tile = 0;
  for (let y = 0; y < height; y += 64) {
    for (let x = 0; x < width; x += 64, tile++) {
      const w = Math.min(64, width - x), h = Math.min(64, height - y), pixels = w * h;
      const kind = mode === 'raw' ? 0 : mode === 'palette' ? 2 : tile % 6;
      if (kind === 0) {
        byte(0);
        for (let i = 0; i < pixels; i++) {
          bytes[offset++] = (i + tile * 7 + seed) & 255;
          bytes[offset++] = ((i >>> 4) + seed) & 255;
          bytes[offset++] = ((i >>> 8) + tile) & 255;
        }
        reads.push(pixels * 3);
      } else if (kind === 1) {
        byte(1); colors(1, tile);
      } else if (kind === 2 || kind === 3) {
        const palette = kind === 2 ? 16 : 2;
        const bits = kind === 2 ? 4 : 1;
        byte(palette); colors(palette, tile);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < Math.ceil(w * bits / 8); col++) {
            byte((row * 13 + col * 7 + tile + seed) & 255);
          }
        }
      } else if (kind === 4) {
        byte(128);
        for (let position = 0; position < pixels;) {
          const length = Math.min(1 + ((position + tile) % 320), pixels - position);
          colors(1, tile + position); runLength(length); position += length;
        }
      } else {
        byte(132); colors(4, tile);
        for (let position = 0; position < pixels;) {
          const length = Math.min(1 + ((position + tile) % 29), pixels - position);
          byte((position & 3) | (length > 1 ? 128 : 0));
          if (length > 1) runLength(length);
          position += length;
        }
      }
    }
  }
  return { width, height, payload: bytes.slice(0, offset), reads: Uint32Array.from(reads) };
}

function readFrames(Inflator, fixtures, packets, verify = false) {
  const inflator = new Inflator();
  let checksum = 0, pakoCalls = 0;
  const hashes = [];
  for (let frame = 0; frame < fixtures.length; frame++) {
    const fixture = fixtures[frame];
    inflator.setInput(packets[frame]);
    const output = verify ? new Uint8Array(fixture.payload.length) : undefined;
    let offset = 0;
    for (const expected of fixture.reads) {
      const before = verify ? inflator.strm.total_out : 0;
      const view = inflator.inflate(expected);
      checksum = (checksum + view[0] + view[view.length - 1]) >>> 0;
      if (verify) {
        output.set(view, offset);
        if (inflator.strm.total_out !== before) pakoCalls++;
      }
      offset += expected;
    }
    if (verify) {
      assert.deepEqual(output, fixture.payload);
      if (Inflator === BufferedInflator) assert.equal(inflator.strm.avail_in, 0, 'compressed rectangle must be fully consumed');
      hashes.push(sha(output));
    }
  }
  return { checksum, hashes, pakoCalls };
}

function decodeFrames(Inflator, fixtures, packets, verify = false) {
  const decoder = new ZRLEDecoder();
  decoder._inflator = new Inflator(); // Benchmark injection only; product uses the Vite module mapping.
  let checksum = 0;
  const outputs = [];
  for (let frame = 0; frame < fixtures.length; frame++) {
    const { width, height } = fixtures[frame];
    const pixels = verify ? new Uint8Array(width * height * 4) : undefined;
    const display = {
      blitImage(x, y, w, h, data) {
        checksum = (checksum + data[0] + data[w * h * 4 - 1]) >>> 0;
        if (pixels) for (let row = 0; row < h; row++) pixels.set(data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
      },
      fillRect(x, y, w, h, color) {
        checksum = (checksum + color[0] + 255) >>> 0;
        if (pixels) for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          const index = ((y + row) * width + x + col) * 4;
          pixels[index] = color[0]; pixels[index + 1] = color[1]; pixels[index + 2] = color[2]; pixels[index + 3] = 255;
        }
      },
    };
    const sock = { rQwait: () => false, rQshift32: () => packets[frame].length, rQshiftBytes: () => packets[frame] };
    assert.equal(decoder.decodeRect(0, 0, width, height, sock, display, 24), true);
    if (pixels) outputs.push(pixels);
  }
  return { checksum, outputs };
}

async function edgeChecks() {
  const lengths = [1, 65535, 65536, 65537, 131072, 131089, 196607];
  const fixtures = lengths.map((length, index) => {
    const payload = Uint8Array.from({ length }, (_, byte) => ((byte >>> 4) + index * 7) & 255);
    const reads = [];
    let remaining = length;
    while (remaining) { const take = Math.min(remaining, reads.length % 3 === 0 ? 1 : 12288); reads.push(take); remaining -= take; }
    return { payload, reads };
  });
  const packets = await compressFrames(fixtures.map(fixture => fixture.payload));
  readFrames(BufferedInflator, fixtures, packets, true);
  const inflator = new BufferedInflator();
  const a = new Uint8Array(200000).fill(91), b = new Uint8Array(90000).fill(37);
  inflator.setInput(deflateSync(a));
  assert.equal(inflator.inflate(1)[0], 91);
  inflator.reset();
  inflator.setInput(deflateSync(b));
  assert.deepEqual(inflator.inflate(b.length), b, 'reset must discard buffered old output and grow for a large read');

  const carried = new BufferedInflator();
  const continuation = await compressFrames([a.subarray(0, 100), b.subarray(0, 100)]);
  carried.setInput(continuation[0]);
  assert.equal(carried.inflate(1)[0], 91);
  carried.setInput(continuation[1]);
  assert.deepEqual(carried.inflate(199), Uint8Array.from([...a.subarray(1, 100), ...b.subarray(0, 100)]), 'preserve prefetched output when input advances');

  const tooShort = new BufferedInflator();
  tooShort.setInput(deflateSync(new Uint8Array(3)));
  assert.throws(() => tooShort.inflate(4), /Incomplete zlib block/);
  const corrupt = new BufferedInflator();
  corrupt.setInput(new Uint8Array([1, 2, 3, 4]));
  assert.throws(() => corrupt.inflate(1), /zlib inflate failed/);
  return { exactAndCrossed64KiBBoundaries: true, persistentSyncFlush: true, resetAfterPrefetch: true, growAndCarryOutput: true, truncatedAndCorruptRejected: true };
}

const edges = await edgeChecks();
console.log(JSON.stringify({ edgeChecks: edges }));
for (const mode of ['mixed', 'palette', 'raw']) {
  const fixtures = [makeFixture(mode, 17), makeFixture(mode, 29)];
  const packets = await compressFrames(fixtures.map(fixture => fixture.payload));
  const originalCheck = readFrames(OriginalInflator, fixtures, packets, true);
  const bufferedCheck = readFrames(BufferedInflator, fixtures, packets, true);
  assert.deepEqual(bufferedCheck.hashes, originalCheck.hashes);
  const baselinePixels = decodeFrames(OriginalInflator, fixtures, packets, true);
  const bufferedPixels = decodeFrames(BufferedInflator, fixtures, packets, true);
  bufferedPixels.outputs.forEach((output, index) => assert.deepEqual(output, baselinePixels.outputs[index]));

  const timings = { inflateOriginal: [], inflateBuffered: [], zrleOriginal: [], zrleBuffered: [] };
  for (let iteration = -2; iteration < rounds; iteration++) {
    for (const [name, run, Inflator] of [
      ['inflateOriginal', readFrames, OriginalInflator], ['inflateBuffered', readFrames, BufferedInflator],
      ['zrleOriginal', decodeFrames, OriginalInflator], ['zrleBuffered', decodeFrames, BufferedInflator],
    ]) {
      const started = performance.now();
      const result = run(Inflator, fixtures, packets);
      const elapsed = (performance.now() - started) / fixtures.length;
      assert.equal(result.checksum, name.startsWith('inflate') ? originalCheck.checksum : baselinePixels.checksum);
      if (iteration >= 0) timings[name].push(elapsed);
    }
  }
  const msPer4kFrame = Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, round(median(values))]));
  console.log(JSON.stringify({
    mode, width: 3840, height: 2160, frames: fixtures.length, rounds,
    uncompressedBytes: fixtures.map(fixture => fixture.payload.length), compressedBytes: packets.map(packet => packet.length),
    inflateRequests: fixtures.reduce((sum, fixture) => sum + fixture.reads.length, 0),
    pakoCalls: { original: originalCheck.pakoCalls, buffered: bufferedCheck.pakoCalls },
    byteEqual: true, decodedPixelEqual: true, inflatedSha256: bufferedCheck.hashes, rgbaSha256: bufferedPixels.outputs.map(sha),
    msPer4kFrame, speedup: { inflate: round(median(timings.inflateOriginal) / median(timings.inflateBuffered)), zrle: round(median(timings.zrleOriginal) / median(timings.zrleBuffered)) },
  }));
}
