// Controlled metadata-only A/B/A: one drain refresh, then 8 full requests per
// phase (first frame is warmup, leaving 7 measured frames). No pixels or input.
// node scripts/pipeline-refresh-check.mjs [CDP_PORT]
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = process.argv[2] ?? (await readFile(path.join(process.env.APPDATA, 'MacLink', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
const frameCount = Number(process.argv[3] ?? 8);
if (!Number.isInteger(frameCount) || frameCount < 3 || frameCount > 30) throw new Error('Frame count must be 3–30');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let handle;
try {
  const page = browser.contexts()[0].pages()[0];
  handle = await page.evaluateHandle(() => {
    const shell = document.querySelector('.app-shell');
    let fiber = shell?.[Object.keys(shell).find(key => key.startsWith('__reactFiber$'))];
    while (fiber) {
      const session = fiber.memoizedState?.memoizedState;
      if (typeof session?.getSnapshot === 'function' && session.active?.rfb) return session.active.rfb;
      fiber = fiber.return;
    }
    throw new Error('No active viewer session');
  });
  const report = await handle.evaluate(async (rfb, frameCount) => {
    if (rfb._rfbConnectionState !== 'connected' || rfb._enabledContinuousUpdates) throw new Error('A connected, request-driven session is required');
    if (rfb._fbWidth !== 3840 || rfb._fbHeight !== 2160) throw new Error('Expected the unchanged 3840×2160 framebuffer');
    const sock = rfb._sock, ws = sock._websocket, display = rfb._display, messages = rfb.constructor.messages;
    const originals = { request: messages.fbUpdateRequest, update: rfb._framebufferUpdate, rect: rfb._handleDataRect,
      flip: display.flip, wait: sock.rQwait, shift16: sock.rQshift16, message: ws.onmessage };
    const now = () => performance.now(), round = n => Math.round(n * 100) / 100;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let received = sock.rQlen(), phase, frame, boundaryDone, lengthIsHeader = false, lastComplete = now(), sentTotal = 0, skipped = 0;
    const chunks = received ? [{ start: 0, end: received, at: null }] : [], phases = [], drains = [];
    const position = () => received - sock.rQlen();
    const full = () => { if (++sentTotal > 1 + 3 * frameCount) throw new Error('Full-request quota exceeded'); originals.request.call(messages, sock, false, 0, 0, 3840, 2160); };
    function sendNext() {
      if (!phase || phase.sent >= phase.quota || phase.sent - phase.frames.length >= 2) return;
      phase.sent++; phase.requests.push(now()); full();
    }
    function coverage(rects) {
      const xs = [...new Set(rects.flatMap(r => [r.x, r.x + r.width]))].sort((a, b) => a - b);
      let area = 0;
      for (let i = 1; i < xs.length; i++) {
        const rows = rects.filter(r => r.x < xs[i] && r.x + r.width > xs[i - 1]).sort((a, b) => a.y - b.y);
        let height = 0, bottom = 0;
        for (const r of rows) { height += Math.max(0, r.y + r.height - Math.max(bottom, r.y)); bottom = Math.max(bottom, r.y + r.height); }
        area += (xs[i] - xs[i - 1]) * height;
      }
      return area / (3840 * 2160);
    }
    ws.onmessage = function(event) {
      const bytes = event.data.byteLength;
      chunks.push({ start: received, end: received + bytes, at: now() }); received += bytes;
      if (phase) { phase.bytes += bytes; phase.wsMessages++; }
      return originals.message.call(this, event);
    };
    messages.fbUpdateRequest = function(socket, incremental, ...geometry) {
      if (socket === sock && incremental) { skipped++; return; }
      return originals.request.call(this, socket, incremental, ...geometry);
    };
    sock.rQwait = function(label, ...args) {
      const waiting = originals.wait.call(this, label, ...args);
      if (label === 'FBU header' && !waiting) lengthIsHeader = true;
      return waiting;
    };
    sock.rQshift16 = function(...args) {
      const value = originals.shift16.apply(this, args);
      if (lengthIsHeader) {
        lengthIsHeader = false;
        if (frame) frame.headerReadyAt = now();
        // Count comes from noVNC's own parser. There is only one next request.
        if (value > 0 && phase?.mode === 'pipeline' && frame?.offset >= phase.fence && !display.pending()) sendNext();
      }
      return value;
    };
    rfb._handleDataRect = function(...args) {
      const { x, y, width, height, encoding } = this._FBU, start = now();
      const complete = originals.rect.apply(this, args);
      if (frame) {
        frame.decodeCpu += now() - start;
        if (complete) frame.rectangles.push({ x, y, width, height, encoding });
      }
      return complete;
    };
    display.flip = function(...args) {
      const start = now(), result = originals.flip.apply(this, args);
      if (frame) { frame.flipCpu += now() - start; frame.flipAt = now(); }
      return result;
    };
    rfb._framebufferUpdate = function(...args) {
      frame ??= { offset: this._FBU.rects === 0 ? position() - 1 : -1, startedAt: now(), rectangles: [], cpu: 0, decodeCpu: 0, flipCpu: 0 };
      const start = now(), complete = originals.update.apply(this, args);
      frame.cpu += now() - start;
      if (complete) {
        const item = frame; frame = undefined; lastComplete = now();
        if (phase && item.offset >= phase.fence && coverage(item.rectangles) >= 0.95) {
          const first = chunks.find(chunk => chunk.start <= item.offset && chunk.end > item.offset);
          phase.frames.push({ headerAt: item.headerReadyAt, firstDataAt: first?.at ?? null, completeAt: lastComplete,
            bytes: position() - item.offset, cpuMs: round(item.cpu), decodeCpuMs: round(item.decodeCpu), flipCpuMs: round(item.flipCpu),
            firstDataToCompleteMs: first?.at == null ? null : round(lastComplete - first.at),
            headerToCompleteMs: round(lastComplete - item.headerReadyAt), rectangles: item.rectangles });
          if (phase.frames.length === phase.quota) phase.done();
          else if (phase.mode !== 'pipeline' || phase.sent === phase.frames.length) sendNext();
        } else if (phase) phase.nonTargetFbus++;
        if (!phase) boundaryDone?.();
      }
      return complete;
    };
    const disconnected = () => { phase?.done(); boundaryDone?.(); };
    rfb.addEventListener('disconnect', disconnected);
    async function run(mode, quota) {
      let done; const complete = new Promise(resolve => { done = resolve; });
      const item = { mode, quota, sent: 0, frames: [], requests: [], bytes: 0, wsMessages: 0, nonTargetFbus: 0,
        fence: received, visibility: document.visibilityState, focused: document.hasFocus(), done };
      phase = item;
      if (rfb._rfbConnectionState === 'connected') sendNext(); else done();
      await complete; phase = undefined;
      return item;
    }
    async function drain() {
      const start = now(); let quiet;
      do {
        quiet = now() - lastComplete >= 500 && !frame && !sock.rQlen() && !display.pending();
        if (quiet || rfb._rfbConnectionState !== 'connected') break;
        await sleep(50);
      } while (now() - start < 3000);
      const result = { quiet, durationMs: round(now() - start) }; drains.push(result); return quiet;
    }
    try {
      await run('drain-warmup', 1);
      if (await drain()) for (const mode of ['baseline', 'pipeline', 'restored']) {
        const item = await run(mode, frameCount); phases.push(item);
        if (rfb._rfbConnectionState !== 'connected' || !await drain()) break;
      }
      return { generatedAt: new Date().toISOString(), framebuffer: { width: 3840, height: 2160 }, sentTotal, fullRequestLimit: 1 + 3 * frameCount,
        skippedIncremental: skipped, drains, connectionState: rfb._rfbConnectionState,
        phases: phases.map(({ done, fence, ...item }) => {
          const base = item.requests[0], measured = item.frames.slice(1);
          const intervals = measured.slice(1).map((f, i) => f.completeAt - measured[i].completeAt).sort((a, b) => a - b);
          return { ...item, outstandingFull: item.sent - item.frames.length, measuredFrames: measured.length,
            requestSentEpochMs: item.requests.map(t => round(performance.timeOrigin + t)), requests: item.requests.map(t => round(t - base)),
            completionIntervalMedianMs: intervals.length ? round(intervals[Math.floor(intervals.length / 2)]) : null,
            completionIntervalP95Ms: intervals.length ? round(intervals[Math.ceil(intervals.length * .95) - 1]) : null,
            completionIntervalsMs: intervals.map(round),
            frames: item.frames.map((f, i) => ({ ...f, warmup: i === 0, headerAt: round(f.headerAt - base),
              firstDataAt: f.firstDataAt == null ? null : round(f.firstDataAt - base), completeAt: round(f.completeAt - base) })) };
        }), note: 'Controlled full-refresh A/B/A, not mouse latency. First frame in each phase is discarded as warmup. Header/data times include server/transport/scheduling. No pixels or input recorded.' };
    } finally {
      // run() completes only at a full-FBU boundary (or disconnect), after every
      // quota-limited full request has received its matching complete refresh.
      if (frame && rfb._rfbConnectionState === 'connected') await new Promise(resolve => { boundaryDone = resolve; });
      rfb.removeEventListener('disconnect', disconnected);
      ws.onmessage = originals.message; sock.rQwait = originals.wait; sock.rQshift16 = originals.shift16;
      rfb._framebufferUpdate = originals.update; rfb._handleDataRect = originals.rect; display.flip = originals.flip;
      messages.fbUpdateRequest = originals.request;
      if (rfb._rfbConnectionState === 'connected') originals.request.call(messages, sock, true, 0, 0, rfb._fbWidth, rfb._fbHeight);
    }
  }, frameCount);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/live-pipeline-refresh.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sentTotal: report.sentTotal, connectionState: report.connectionState, drains: report.drains,
    phases: report.phases.map(p => ({ mode: p.mode, frames: p.frames.length, outstandingFull: p.outstandingFull,
      medianMs: p.completionIntervalMedianMs, p95Ms: p.completionIntervalP95Ms, bytes: p.bytes })) }, null, 2));
} finally {
  await handle?.dispose();
  await browser.close();
}
