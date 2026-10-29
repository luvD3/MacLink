// Bounded development A/B: no pixels/credentials read, no keyboard/mouse input.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const port = process.argv[2] ?? (await readFile(path.join(process.env.APPDATA, 'MacLink', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
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
  const results = [];
  for (const mode of ['baseline', 'pipelined', 'restored']) {
    console.log(`Sampling ${mode} for 10 seconds…`);
    const result = await rfb.evaluate(async (rfb, mode) => {
      if (rfb._rfbConnectionState !== 'connected') throw new Error('Viewer is not connected');
      const originalNormal = rfb._normalMsg;
      const originalUpdate = rfb._framebufferUpdate;
      const originalRect = rfb._handleDataRect;
      const originalFlip = rfb._display.flip;
      const socket = rfb._sock._websocket;
      const originalMessage = socket.onmessage;
      const start = performance.now();
      let earlySent = false, earlyWidth = 0, earlyHeight = 0, earlyRequests = 0, stopping = false, stopped;
      let bytes = 0, frames = 0, maxQueueBytes = 0, pendingCpu = 0, pendingStart, framePixels = 0, pointerMoves = 0;
      const rectangles = [], updates = [];
      const sendNext = () => rfb.constructor.messages.fbUpdateRequest(rfb._sock, true, 0, 0, rfb._fbWidth, rfb._fbHeight);
      const restorePipeline = () => { rfb._normalMsg = originalNormal; rfb._framebufferUpdate = originalUpdate; stopped?.(); };
      const pointer = () => { pointerMoves++; };
      document.addEventListener('pointermove', pointer, { passive: true });
      socket.onmessage = function(event) { bytes += event.data.byteLength; return originalMessage.call(this, event); };
      rfb._handleDataRect = function() {
        const before = performance.now();
        pendingStart ??= before;
        const pixels = this._FBU.width * this._FBU.height;
        const encoding = this._FBU.encoding;
        const complete = originalRect.call(this);
        pendingCpu += performance.now() - before;
        maxQueueBytes = Math.max(maxQueueBytes, this._sock.rQlen());
        if (complete) {
          rectangles.push({ encoding, pixels, cpuMs: pendingCpu, wallMs: performance.now() - pendingStart });
          framePixels += pixels;
          pendingCpu = 0; pendingStart = undefined;
        }
        return complete;
      };
      rfb._display.flip = function(...args) {
        const result = originalFlip.apply(this, args);
        if (framePixels) { updates.push({ ms: performance.now() - start, pixels: framePixels }); frames++; }
        framePixels = 0;
        return result;
      };
      if (mode === 'pipelined') {
        rfb._normalMsg = function() {
          if (this._FBU.rects === 0 && this._sock.rQpeek8() !== 0) return originalNormal.call(this);
          if (this._FBU.rects === 0) this._sock.rQshift8();
          const complete = this._framebufferUpdate();
          if (complete) {
            if (this._rfbConnectionState === 'connected' && !this._enabledContinuousUpdates &&
                (!earlySent || earlyWidth !== this._fbWidth || earlyHeight !== this._fbHeight)) sendNext();
            earlySent = false;
            if (stopping) restorePipeline();
          }
          return complete;
        };
        rfb._framebufferUpdate = function() {
          if (!stopping && !earlySent && !this._pendingRemoteResize && this._FBU.rects === 0 && this._sock.rQlen() >= 3 &&
              !this._display.pending() && !this._enabledContinuousUpdates && this._rfbConnectionState === 'connected') {
            const header = this._sock.rQpeekBytes(3, false);
            if (header[1] || header[2]) {
              earlyWidth = this._fbWidth; earlyHeight = this._fbHeight;
              earlySent = true; earlyRequests++;
              sendNext();
            }
          }
          return originalUpdate.call(this);
        };
      }
      try {
        await new Promise(resolve => setTimeout(resolve, 10_000));
        const intervals = updates.slice(1).map((update, index) => update.ms - updates[index].ms).sort((a, b) => a - b);
        return { mode, durationMs: performance.now() - start, frames, bytes, earlyRequests, maxQueueBytes, pointerMoves,
          frameIntervalMedianMs: intervals[Math.floor(intervals.length / 2)] ?? null,
          frameIntervalP95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? null, rectangles, updates };
      } finally {
        // Finish the in-progress FBU before reverting, or upstream would send
        // another request for a frame that already has its next request queued.
        stopping = true;
        if (mode === 'pipelined' && earlySent && rfb._rfbConnectionState === 'connected') {
          await new Promise(resolve => { stopped = resolve; rfb.addEventListener('disconnect', restorePipeline, { once: true }); });
          rfb.removeEventListener('disconnect', restorePipeline);
        } else restorePipeline();
        document.removeEventListener('pointermove', pointer);
        socket.onmessage = originalMessage;
        rfb._handleDataRect = originalRect;
        rfb._display.flip = originalFlip;
      }
    }, mode);
    results.push(result);
    console.log(JSON.stringify({ ...result, rectangles: result.rectangles.length, updates: undefined }));
  }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/live-pipeline.json', JSON.stringify(results, null, 2));
} finally {
  await rfb.dispose();
  await browser.close();
}
