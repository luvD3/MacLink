// Synthetic, isolated Electron benchmark. Never connects to a real VNC server.
// node --experimental-strip-types scripts/bench-decoder.mjs [--quick] [--mode mixed|raw] [--no-batch] [--samples 10] [--output report.json]
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import electronExecutable from 'electron';
import { createServer } from 'vite';
import { compressZrleRectangles, createZrleFixture, encodeZrleRectangle, zrleModes } from '../tests/fixtures/zrle.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const quick = args.includes('--quick');
const samples = Number(option('--samples', quick ? 3 : 10));
const warmup = Number(option('--warmup', quick ? 1 : 2));
const width = Number(option('--width', quick ? 960 : 3840));
const height = Number(option('--height', quick ? 540 : 2160));
const frames = Number(option('--frames', 3));
const mode = option('--mode', 'mixed');
if (![samples, width, height, frames].every((value) => Number.isInteger(value) && value > 0) || !Number.isInteger(warmup) || warmup < 0) throw new Error('Dimensions, samples and frames must be positive integers; warmup must be non-negative.');
if (!['mixed', ...zrleModes].includes(mode)) throw new Error(`Unknown synthetic tile mode: ${mode}`);
const candidateFile = path.resolve(root, option('--inflator', 'src/renderer/vnc/buffered-inflator.ts'));
const batchFile = path.resolve(root, 'tests/helpers/tile-batch.ts');
const wasmFile = path.resolve(root, 'src/renderer/vnc/wasm-inflator.ts');
const optimizedDecoderFile = path.resolve(root, 'src/renderer/vnc/zrle-decoder.ts');
const wasmBinaryFile = path.resolve(root, 'node_modules/zlib-streams/dist/zlib-streams.wasm');
const hasCandidate = await access(candidateFile).then(() => true, () => false);
const hasBatch = !args.includes('--no-batch') && await access(batchFile).then(() => true, () => false);
const hasWasm = await access(wasmFile).then(() => true, () => false);
const hasOptimizedDecoder = hasWasm && await access(optimizedDecoderFile).then(() => true, () => false);
const wasmBytes = hasWasm ? await readFile(wasmBinaryFile) : null;
const browserPath = (file) => `/@fs/${file.replaceAll('\\', '/')}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(await Promise.all([
  path.join(root, 'node_modules/@novnc/novnc/core/decoders/zrle.js'),
  path.join(root, 'node_modules/@novnc/novnc/core/inflator.js'),
  path.join(root, 'tests/fixtures/zrle.ts'),
  ...(hasCandidate ? [candidateFile] : []), ...(hasBatch ? [batchFile] : []),
  ...(hasWasm ? [wasmFile, wasmBinaryFile] : []),
  ...(hasOptimizedDecoder ? [optimizedDecoderFile] : []),
].map(async (file) => [path.relative(root, file).replaceAll('\\', '/'), sha256(await readFile(file))])));

console.log(`Generating synthetic ${width}×${height} ${mode} tiles, ${frames} persistent-stream rectangles…`);
const benchmarkGroup = `${mode}-desktop`;
const groups = [{ name: benchmarkGroup, rectangles: await createZrleFixture({ width, height, frames, mode }) }];
for (const mode of zrleModes) {
  groups.push({ name: `edge-${mode}`, rectangles: await compressZrleRectangles([
    encodeZrleRectangle({ width: 65, height: 67, x: 3, y: 5, mode, seed: 7 }),
    encodeZrleRectangle({ width: 65, height: 67, x: 3, y: 5, mode, seed: 8 }),
  ]) });
}
const metadata = groups.map((group, groupIndex) => ({ name: group.name, rectangles: group.rectangles.map((rectangle, rectangleIndex) => ({
  x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
  bytes: rectangle.wire.byteLength, uncompressedBytes: rectangle.uncompressedBytes,
  tileCount: rectangle.tileCount, modeCounts: rectangle.modeCounts,
  expectedSha256: sha256(rectangle.expectedRgba), url: `/__bench/data/${groupIndex}/${rectangleIndex}`,
})) }));

const browserEntry = `
import OriginalDecoder from '/node_modules/@novnc/novnc/core/decoders/zrle.js';
import Display from '/node_modules/@novnc/novnc/core/display.js';
${hasCandidate ? `import BufferedInflator from ${JSON.stringify(browserPath(candidateFile))};` : ''}
${hasBatch ? `import { TileBatch } from ${JSON.stringify(browserPath(batchFile))};` : ''}
${hasOptimizedDecoder ? `import OptimizedDecoder from ${JSON.stringify(browserPath(optimizedDecoderFile))};` : ''}
${hasWasm ? `import WasmInflator, { compileInflater } from ${JSON.stringify(browserPath(wasmFile))};
const wasmModule = await compileInflater(new Uint8Array(await (await fetch('/__bench/inflator.wasm')).arrayBuffer()));` : ''}

class Socket {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  rQwait(_label, size) { return this.position + size > this.bytes.length; }
  rQshift32() { const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.position, 4).getUint32(0); this.position += 4; return value; }
  rQshiftBytes(size, copy = true) { const value = this.bytes.subarray(this.position, this.position + size); this.position += size; return copy ? value.slice() : value; }
}
class MemoryDisplay {
  constructor(rectangle) { Object.assign(this, rectangle); this.pixels = new Uint8Array(this.width * this.height * 4); this.blits = 0; this.fills = 0; }
  fillRect(x, y, width, height, color) {
    this.fills++;
    for (let row = 0; row < height; row++) {
      let target = ((y - this.y + row) * this.width + x - this.x) * 4;
      for (let column = 0; column < width; column++, target += 4) {
        this.pixels[target] = color[0]; this.pixels[target + 1] = color[1]; this.pixels[target + 2] = color[2]; this.pixels[target + 3] = 255;
      }
    }
  }
  blitImage(x, y, width, height, pixels, offset = 0) {
    this.blits++;
    for (let row = 0; row < height; row++) {
      const source = offset + row * width * 4;
      this.pixels.set(pixels.subarray(source, source + width * 4), ((y - this.y + row) * this.width + x - this.x) * 4);
    }
  }
}
const variants = [
  { name: 'original', create: () => new OriginalDecoder(), batch: null },
  ${hasCandidate ? `{ name: 'buffered-inflator', create: () => { const decoder = new OriginalDecoder(); decoder._inflator = new BufferedInflator(); return decoder; }, batch: null },` : ''}
  ${hasCandidate && hasBatch ? `{ name: 'buffered-inflator+tile-batch', create: () => { const decoder = new OriginalDecoder(); decoder._inflator = new BufferedInflator(); return decoder; }, batch: () => new TileBatch() },` : ''}
  ${hasWasm ? `{ name: 'wasm-inflator', create: () => { const decoder = new OriginalDecoder(); decoder._inflator = new WasmInflator(wasmModule); return decoder; }, batch: null },` : ''}
  ${hasWasm && hasBatch ? `{ name: 'wasm-inflator+tile-batch', create: () => { const decoder = new OriginalDecoder(); decoder._inflator = new WasmInflator(wasmModule); return decoder; }, batch: () => new TileBatch() },` : ''}
  ${hasOptimizedDecoder ? `{ name: 'wasm-inflator+pixel-unpack', create: () => { const decoder = new OptimizedDecoder(); decoder._inflator = new WasmInflator(wasmModule); return decoder; }, batch: null },` : ''}
];
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
function decode(decoder, batch, rectangle, display) {
  const socket = new Socket(rectangle.wire);
  if (batch) batch.begin(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
  const complete = decoder.decodeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height, socket, batch || display, 24);
  if (!complete || socket.position !== rectangle.wire.length) throw new Error('Incomplete synthetic rectangle decode');
  if (batch) batch.commit(display);
}
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
window.runDecoderBench = async ({ samples, warmup }) => {
  const groups = await (await fetch('/__bench/meta.json')).json();
  for (const group of groups) for (const rectangle of group.rectangles) rectangle.wire = new Uint8Array(await (await fetch(rectangle.url)).arrayBuffer());
  const correctness = [];
  for (const variant of variants) {
    console.log('Verify ' + variant.name);
    for (const group of groups) {
      const decoder = variant.create(); const batch = variant.batch?.();
      for (let index = 0; index < group.rectangles.length; index++) {
        const rectangle = group.rectangles[index]; const memory = new MemoryDisplay(rectangle);
        decode(decoder, batch, rectangle, memory);
        const actual = await digest(memory.pixels);
        if (actual !== rectangle.expectedSha256) throw new Error(variant.name + ' mismatch in ' + group.name + ' rectangle ' + index + ': ' + actual);
        correctness.push({ variant: variant.name, group: group.name, rectangle: index, sha256: actual, blitCalls: memory.blits, fillCalls: memory.fills });
      }
      decoder._inflator.dispose?.();
    }
  }
  const rectangles = groups[0].rectangles;
  const runners = variants.map(variant => {
    const canvas = document.createElement('canvas');
    const display = new Display(canvas); display.resize(rectangles[0].width, rectangles[0].height); display.autoscale(1280, 720);
    return { variant, canvas, display, batch: variant.batch?.(), durations: [] };
  });
  for (let sample = 0; sample < warmup + samples; sample++) {
    for (const runner of runners) {
      document.getElementById('surface').replaceChildren(runner.canvas);
      await new Promise(resolve => setTimeout(resolve, 0));
      const decoder = runner.variant.create();
      for (const rectangle of rectangles) {
        const start = performance.now();
        decode(decoder, runner.batch, rectangle, runner.display);
        runner.display.flip();
        const elapsed = performance.now() - start;
        if (sample >= warmup) runner.durations.push(elapsed);
      }
      decoder._inflator.dispose?.();
    }
    console.log((sample < warmup ? 'Warmup ' : 'Sample ') + (sample + 1) + '/' + (warmup + samples));
  }
  const timings = [];
  for (const runner of runners) {
    // One real Canvas readback after every timed trial has finished. Never time readback.
    const actual = await digest(runner.display.getImageData().data);
    if (actual !== rectangles.at(-1).expectedSha256) throw new Error(runner.variant.name + ' Canvas output mismatch');
    timings.push({ variant: runner.variant.name, rectangles: runner.durations.length, p50Ms: percentile(runner.durations, .5), p95Ms: percentile(runner.durations, .95), minMs: Math.min(...runner.durations), maxMs: Math.max(...runner.durations), meanMs: runner.durations.reduce((sum, value) => sum + value, 0) / runner.durations.length, canvasSha256: actual });
  }
  return { correctness, timings, visibility: document.visibilityState, canvasContext: runners[0].canvas.getContext('2d').getContextAttributes() };
};
`;

const tempRoot = path.resolve(os.tmpdir());
const temporary = await mkdtemp(path.join(tempRoot, 'maclink-decoder-bench-'));
let server;
let application;
try {
  server = await createServer({
    root, configFile: false, logLevel: 'error',
    resolve: { alias: {
      '@maclink/novnc-zlib': path.join(root, 'node_modules/@novnc/novnc/vendor/pako/lib/zlib/inflate.js'),
      '@maclink/novnc-zstream': path.join(root, 'node_modules/@novnc/novnc/vendor/pako/lib/zlib/zstream.js'),
      '@maclink/novnc-zrle': path.join(root, 'node_modules/@novnc/novnc/core/decoders/zrle.js'),
    } },
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'synthetic-zrle-bench',
      resolveId(id) { if (id === 'virtual:decoder-bench') return '\0decoder-bench'; },
      load(id) { if (id === '\0decoder-bench') return browserEntry; },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const url = request.url?.split('?')[0];
          if (url === '/__bench/') {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><title>MacLink synthetic decode benchmark</title></head><body style="margin:0;overflow:hidden"><div id="surface"></div><script type="module" src="/@id/__x00__decoder-bench"></script></body></html>');
          } else if (url === '/__bench/meta.json') {
            response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(metadata));
          } else if (url === '/__bench/inflator.wasm' && wasmBytes) {
            response.setHeader('Content-Type', 'application/wasm'); response.end(wasmBytes);
          } else if (url?.startsWith('/__bench/data/')) {
            const [, , , groupIndex, rectangleIndex] = url.split('/');
            const bytes = groups[Number(groupIndex)].rectangles[Number(rectangleIndex)].wire;
            response.setHeader('Content-Type', 'application/octet-stream'); response.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          } else next();
        });
      },
    }],
  });
  await server.listen();
  const url = `${server.resolvedUrls.local[0]}__bench/`;
  const main = path.join(temporary, 'main.cjs');
  await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary, 'profile'))});app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});window.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`);
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: electronExecutable, args: [main], env: environment });
  const page = await application.firstWindow();
  page.on('console', message => { if (message.type() === 'log') console.log(message.text()); });
  page.on('pageerror', error => console.error(error.message));
  await page.waitForFunction(() => typeof window.runDecoderBench === 'function', undefined, { timeout: 30_000 });
  const runtime = await application.evaluate(({ app }) => ({ versions: process.versions, gpu: app.getGPUFeatureStatus() }));
  const result = await page.evaluate(options => window.runDecoderBench(options), { samples, warmup });
  const report = { generatedAt: new Date().toISOString(), synthetic: true, mode, dimensions: { width, height }, frames, samples, warmup, sourceHashes, runtime, fixtures: metadata, ...result,
    timingMeaning: 'Renderer CPU wall time per rectangle: inflate + decode + Canvas command submission + flip. GPU completion, network, server capture and browser readback are excluded. Hidden isolated Electron window, backgroundThrottling=false. This is not an end-to-end FPS claim.' };
  console.log(JSON.stringify({ dimensions: report.dimensions, mode, frames, samples, warmup, correctnessChecks: result.correctness.length, timings: result.timings, uploads: result.correctness.filter(item => item.group === benchmarkGroup && item.rectangle === 0).map(({ variant, blitCalls, fillCalls }) => ({ variant, blitCalls, fillCalls })), timingMeaning: report.timingMeaning }, null, 2));
  const output = option('--output');
  if (output) { const destination = path.resolve(output); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2) + '\n'); }
} finally {
  await Promise.allSettled([application?.close(), server?.close()]);
  const resolved = path.resolve(temporary);
  if (resolved.startsWith(`${tempRoot}${path.sep}`) && path.basename(resolved).startsWith('maclink-decoder-bench-')) await rm(resolved, { recursive: true, force: true });
}
