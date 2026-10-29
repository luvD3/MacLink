// Development A/B probe. Requests screen refreshes, but sends no keyboard/mouse
// input and never reads or records pixels, credentials, clipboard, or URLs.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const port = process.argv[2] ?? (await readFile(path.join(process.env.APPDATA, 'MacLink', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
const compression = process.argv.includes('--compression');
// Follow the known App component's first useState, which owns ViewerSession.
// Avoid Runtime.queryObjects: traversing WASM heaps crashes this Chromium build.
const rfb = await page.evaluateHandle(() => {
  const shell = document.querySelector('.app-shell');
  let fiber = shell?.[Object.keys(shell).find(key => key.startsWith('__reactFiber$'))];
  while (fiber) {
    const session = fiber.memoizedState?.memoizedState;
    if (typeof session?.getSnapshot === 'function' && session.active?.rfb) return session.active.rfb;
    fiber = fiber.return;
  }
  throw new Error('No active viewer session');
});

try {
  console.log(compression ? 'Comparing ZRLE compression 6, 1 and 0; original preferences will be restored.' : 'Measuring ZRLE, Hextile and Raw full refreshes; original encoding preferences will be restored.');
  const report = await rfb.evaluate(async (rfb, compression) => {
    if (rfb._rfbConnectionState !== 'connected') throw new Error('Viewer is not connected');
    const messages = rfb.constructor.messages;
    const originalRequest = messages.fbUpdateRequest;
    const sendEncodings = messages.clientEncodings;
    let originalEncodings;
    messages.clientEncodings = (_socket, encodings) => { originalEncodings = [...encodings]; };
    try { rfb._sendEncodings(); } finally { messages.clientEncodings = sendEncodings; }
    const pictureEncodings = new Set([0, 1, 2, 5, 6, 7, 16, 21, 50, -260]);
    const socket = rfb._sock._websocket;
    const originalMessage = socket.onmessage;
    const originalRect = rfb._handleDataRect;
    const originalFlip = rfb._display.flip;
    // Full-refresh diagnostics supply their own bounded requests. Do not keep
    // adding automatic incrementals to the server's outstanding request set.
    messages.fbUpdateRequest = function(socket, incremental, ...bounds) {
      if (socket === rfb._sock && incremental) return;
      return originalRequest.call(this, socket, incremental, ...bounds);
    };
    let phase, pending, framePixels = 0, requestedAt = 0, finishRefresh;
    const results = [];
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const rounded = number => Math.round(number * 100) / 100;
    socket.onmessage = function(event) {
      if (phase) { phase.bytes += event.data.byteLength; phase.messages++; }
      return originalMessage.call(this, event);
    };
    rfb._handleDataRect = function() {
      const encoding = this._FBU.encoding;
      const pixels = this._FBU.width * this._FBU.height;
      const before = performance.now();
      pending ??= { encoding, pixels, start: before, cpu: 0 };
      const complete = originalRect.call(this);
      pending.cpu += performance.now() - before;
      if (complete) {
        if (phase) phase.rectangles.push({ encoding, pixels, cpuMs: rounded(pending.cpu), receiveAndDecodeMs: rounded(performance.now() - pending.start) });
        framePixels += pixels;
        pending = undefined;
      }
      return complete;
    };
    rfb._display.flip = function(...args) {
      const start = performance.now();
      const result = originalFlip.apply(this, args);
      if (phase) phase.flipMs += performance.now() - start;
      if (finishRefresh && framePixels >= rfb._fbWidth * rfb._fbHeight * 0.95) {
        phase.refreshMs.push(rounded(performance.now() - requestedAt));
        finishRefresh();
      }
      framePixels = 0;
      return result;
    };
    try {
      for (const mode of compression ? ['default', 'compression1', 'compression0', 'restored'] : ['default', 'hextile', 'raw', 'restored']) {
        const keep = mode === 'hextile' ? new Set([1, 5, 0]) : mode === 'raw' ? new Set([1, 0]) : pictureEncodings;
        const preferred = originalEncodings.filter(encoding => !pictureEncodings.has(encoding) || keep.has(encoding));
        sendEncodings(rfb._sock, preferred.map(encoding =>
          encoding >= -256 && encoding <= -247 && mode.startsWith('compression') ? -256 + Number(mode.slice(-1)) : encoding));
        await delay(500);
        phase = { mode, bytes: 0, messages: 0, flipMs: 0, refreshMs: [], rectangles: [], timedOut: false };
        const start = performance.now();
        for (let attempt = 0; attempt < 3; attempt++) {
          const done = new Promise(resolve => { finishRefresh = resolve; });
          requestedAt = performance.now();
          messages.fbUpdateRequest(rfb._sock, false, 0, 0, rfb._fbWidth, rfb._fbHeight);
          let timer;
          const complete = await Promise.race([done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 7000); })]);
          clearTimeout(timer);
          finishRefresh = undefined;
          if (!complete) { phase.timedOut = true; break; }
          await delay(250);
        }
        phase.durationMs = rounded(performance.now() - start);
        phase.flipMs = rounded(phase.flipMs);
        results.push(phase);
        phase = undefined;
      }
      return { framebuffer: { width: rfb._fbWidth, height: rfb._fbHeight }, wasm: rfb._decoders[16]._inflator?.wasm?.memory instanceof WebAssembly.Memory, pixelWords: rfb._decoders[16].pixelWords instanceof Uint32Array, results };
    } finally {
      socket.onmessage = originalMessage;
      rfb._handleDataRect = originalRect;
      rfb._display.flip = originalFlip;
      messages.fbUpdateRequest = originalRequest;
      if (rfb._rfbConnectionState === 'connected') sendEncodings(rfb._sock, originalEncodings);
      if (rfb._rfbConnectionState === 'connected') originalRequest.call(messages, rfb._sock, true, 0, 0, rfb._fbWidth, rfb._fbHeight);
    }
  }, compression);
  await mkdir('test-results', { recursive: true });
  await writeFile(compression ? 'test-results/live-compression.json' : 'test-results/live-encodings.json', JSON.stringify(report, null, 2));
  for (const phase of report.results) console.log(JSON.stringify({ ...phase, rectangles: phase.rectangles.filter(rectangle => rectangle.pixels > 1_000_000) }));
  console.log(JSON.stringify({ framebuffer: report.framebuffer, wasm: report.wasm, pixelWords: report.pixelWords }));
} finally {
  await rfb.dispose();
  await browser.close();
}
