// Development-only, passive noVNC 1.7 cursor diagnosis. Private noVNC fields are
// used here solely to compare its cached cursor with its separate cursor canvas.
// No application state/protocol methods are changed, and no input is dispatched.
// Only cursor pixels are compared in memory; pixels, framebuffer, credentials,
// clipboard, connection URLs, and pointer coordinates are never collected/output.
// Canvas equality does not prove that the OS compositor displayed the same image.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const usage = `Usage: node scripts/cursor-check.mjs [port|auto] [seconds]
       node scripts/cursor-check.mjs [--port PORT] [--duration SECONDS]

Defaults: read %APPDATA%/MacLink/DevToolsActivePort; sample for 30 seconds.
Duration must be 1–60 seconds. Waits up to 60 seconds for a connected session.
Move the pointer yourself to reproduce the issue. The script sends no input.
Output contains only cursor dimensions, equality/visibility flags and counts.
Ctrl+C stops sampling and detaches; the application stays open.`;

async function boundThis(cdp, objectId) {
  if (!objectId) return undefined;
  // Inspect only the bound function's metadata, never RFB object properties.
  const { internalProperties = [] } = await cdp.send('Runtime.getProperties', { objectId });
  return internalProperties.find(({ name }) => name === '[[BoundThis]]')?.value?.objectId;
}

async function findRfb(cdp, objectGroup) {
  const invoke = async (objectId, functionDeclaration, args = []) => {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: args, objectGroup,
    });
    return result;
  };
  const { result: prototype } = await cdp.send('Runtime.evaluate', {
    expression: 'WebSocket.prototype', objectGroup,
  });
  const { objects } = await cdp.send('Runtime.queryObjects', {
    prototypeObjectId: prototype.objectId, objectGroup,
  });
  const sockets = await invoke(objects.objectId, `function() {
    return this.filter(socket => socket.readyState === 1 && typeof socket.onmessage === 'function');
  }`);
  const count = await invoke(sockets.objectId, 'function() { return this.length; }');
  for (let index = 0; index < count.value; index++) {
    const message = await invoke(sockets.objectId, 'function(i) { return this[i].onmessage; }', [{ value: index }]);
    const websock = await boundThis(cdp, message.objectId);
    if (!websock) continue;
    const handler = await invoke(websock, 'function() { return this._eventHandlers?.message; }');
    const rfb = await boundThis(cdp, handler.objectId);
    if (!rfb) continue;
    const valid = await invoke(rfb, `function() {
      return this._rfbConnectionState === 'connected' &&
        this._canvas instanceof HTMLCanvasElement &&
        this._cursor?._canvas instanceof HTMLCanvasElement &&
        this._cursor._canvas !== this._canvas;
    }`);
    if (valid.value) return rfb;
  }
  throw new Error('Cannot locate a connected noVNC 1.7 session. No cursor data was sampled.');
}

// Runs in the renderer, returning a controller without placing anything on window
// or modifying RFB. All recorded values are whitelisted below.
function createSampler(seconds) {
  const rfb = this;
  const remote = rfb._canvas;
  const cursor = rfb._cursor._canvas;
  const started = performance.now();
  const comparison = new OffscreenCanvas(1, 1);
  const comparisonContext = comparison.getContext('2d', { willReadFrequently: true });
  let source;
  let expected;
  let sourceOpaquePixels = 0;
  let timer;
  let deadline;
  let finished = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const totals = {
    samples: 0, mouseMoves: 0, mouseMovesOverCanvas: 0,
    cursorImageUpdates: 0, cursorCanvasSizeMutations: 0,
    comparedSamples: 0, mismatchedSamples: 0, dimensionMismatchSamples: 0,
    dotFallbackSamples: 0, oversizedCursorSamples: 0,
    pointerOverCanvasSamples: 0, visibleOverlaySamples: 0,
    flushingSamples: 0, pendingUpdateSamples: 0,
    maximumPendingRectangles: 0, maximumUnreadBytes: 0,
  };
  const shapeChanges = [];
  let omittedShapeChanges = 0;
  let before;
  let after;
  const onMove = event => {
    totals.mouseMoves++;
    if (event.target === remote) totals.mouseMovesOverCanvas++;
  };
  const observer = new MutationObserver(records => { totals.cursorCanvasSizeMutations += records.length; });

  function sample() {
    const img = rfb._cursorImage;
    const safeSize = img.w > 0 && img.h > 0 && img.w <= 256 && img.h <= 256;
    if (img !== source) {
      if (source) totals.cursorImageUpdates++;
      source = img;
      expected = undefined;
      sourceOpaquePixels = 0;
      // A cap limits diagnostic work even if the server supplies a huge cursor.
      if (safeSize) {
        for (let i = 3; i < img.rgbaPixels.length; i += 4) {
          if (img.rgbaPixels[i]) sourceOpaquePixels++;
        }
        comparison.width = img.w;
        comparison.height = img.h;
        comparisonContext.putImageData(new ImageData(new Uint8ClampedArray(img.rgbaPixels), img.w, img.h), 0, 0);
        // Normalize through the canvas round trip, including partial alpha.
        expected = comparisonContext.getImageData(0, 0, img.w, img.h).data;
      }
      const change = {
        elapsedMs: Math.round(performance.now() - started),
        width: img.w, height: img.h, hotspotX: img.hotx, hotspotY: img.hoty,
      };
      if (shapeChanges.length < 120) shapeChanges.push(change);
      else omittedShapeChanges++;
    }

    let pixelsMatch = null;
    let comparisonReason = 'compared';
    const dotFallback = rfb.showDotCursor && (safeSize || img.w === 0 || img.h === 0) && sourceOpaquePixels === 0;
    if (dotFallback) {
      comparisonReason = 'expected-dot-fallback';
      totals.dotFallbackSamples++;
    } else if (!safeSize) {
      comparisonReason = 'empty-or-oversized-cursor';
      totals.oversizedCursorSamples++;
    } else if (cursor.width !== img.w || cursor.height !== img.h) {
      comparisonReason = 'dimension-mismatch';
      pixelsMatch = false;
      totals.dimensionMismatchSamples++;
    } else {
      // This is the small cursor canvas, explicitly verified distinct from remote.
      const actual = cursor.getContext('2d').getImageData(0, 0, img.w, img.h).data;
      pixelsMatch = true;
      for (let i = 0; i < expected.length; i += 4) {
        if (actual[i + 3] !== expected[i + 3] || (expected[i + 3] &&
            (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] || actual[i + 2] !== expected[i + 2]))) {
          pixelsMatch = false;
          break;
        }
      }
      totals.comparedSamples++;
    }
    if (pixelsMatch === false) totals.mismatchedSamples++;
    const style = getComputedStyle(cursor);
    const overlayMounted = cursor.isConnected;
    const overlayVisible = overlayMounted && style.visibility === 'visible' && style.display !== 'none';
    const pointerOverCanvas = remote.matches(':hover');
    const cssCursor = getComputedStyle(remote).cursor;
    const cursorKind = cssCursor.startsWith('url(') ? 'image' : cssCursor === 'none' ? 'none' : 'other';
    const pendingRectangles = rfb._FBU.rects;
    const flushing = rfb._flushing;
    totals.samples++;
    if (pointerOverCanvas) totals.pointerOverCanvasSamples++;
    if (overlayVisible) totals.visibleOverlaySamples++;
    if (flushing) totals.flushingSamples++;
    if (pendingRectangles > 0) totals.pendingUpdateSamples++;
    totals.maximumPendingRectangles = Math.max(totals.maximumPendingRectangles, pendingRectangles);
    totals.maximumUnreadBytes = Math.max(totals.maximumUnreadBytes, rfb._sock._rQlen - rfb._sock._rQi);
    return {
      source: { width: img.w, height: img.h, hotspotX: img.hotx, hotspotY: img.hoty },
      canvas: { width: cursor.width, height: cursor.height },
      pixelsMatch, comparisonReason, overlayMounted, overlayVisible,
      pointerOverCanvas, cursorKind, captureActive: Boolean(document.captureElement),
      pendingRectangles, flushing,
    };
  }

  function finish(reason) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearTimeout(deadline);
    totals.cursorCanvasSizeMutations += observer.takeRecords().length;
    observer.disconnect();
    document.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pagehide', onPageHide);
    resolveDone({ reason, elapsedMs: Math.round(performance.now() - started), totals, before, after, shapeChanges, omittedShapeChanges });
  }
  const onPageHide = () => finish('page-hidden');
  before = after = sample();
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  window.addEventListener('pagehide', onPageHide, { once: true });
  observer.observe(cursor, { attributes: true, attributeFilter: ['width', 'height'] });
  timer = setInterval(() => {
    if (rfb._rfbConnectionState !== 'connected') return finish('disconnected');
    try {
      after = sample();
    } catch {
      // A renderer/DOM change during sampling must still remove every listener.
      finish('sampling-unavailable');
    }
  }, 50);
  deadline = setTimeout(() => finish('completed'), seconds * 1000);
  return { done, stop: () => finish('interrupted') };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { port: { type: 'string' }, duration: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  });
  if (values.help) return console.log(usage);
  if (positionals.length > 2 || (values.port && positionals[0]) || (values.duration && positionals[1])) {
    throw new Error(usage);
  }
  const seconds = Number(values.duration ?? positionals[1] ?? 30);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Duration must be an integer from 1 to 60 seconds.');
  let portText = values.port ?? positionals[0];
  if (!portText || portText === 'auto') {
    if (!process.env.APPDATA) throw new Error('APPDATA is unavailable; pass --port explicitly.');
    portText = (await readFile(path.join(process.env.APPDATA, 'MacLink', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDP port must be an integer from 1 to 65535.');

  let browser;
  let cdp;
  let collector;
  let interrupted = false;
  const objectGroup = 'maclink-cursor-diagnostic';
  const stopCollector = () => collector && cdp.send('Runtime.callFunctionOn', {
    objectId: collector, functionDeclaration: 'function() { this.stop(); }',
  });
  const onInterrupt = () => {
    interrupted = true;
    process.exitCode = 130;
    // CDP can already be detached if the user closed the app concurrently.
    void stopCollector()?.catch(() => {});
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  let stage = 'attaching to the MacLink CDP endpoint';
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000, noDefaults: true });
    console.error('Waiting up to 60 seconds for a connected MacLink session…');
    stage = 'waiting for a connected MacLink session';
    const waitUntil = Date.now() + 60_000;
    let page;
    while (!page && Date.now() < waitUntil && !interrupted) {
      for (const candidate of browser.contexts().flatMap(context => context.pages())) {
        if (await candidate.locator('.app-shell[data-session-state="connected"]').count()) {
          page = candidate;
          break;
        }
      }
      if (!page) await delay(250);
    }
    if (interrupted) return;
    if (!page) throw new Error('No connected MacLink session appeared within 60 seconds.');
    cdp = await page.context().newCDPSession(page);
    stage = 'locating the noVNC cursor';
    const rfb = await findRfb(cdp, objectGroup);
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: rfb, functionDeclaration: createSampler.toString(),
      arguments: [{ value: seconds }], objectGroup,
    });
    if (exceptionDetails || !result.objectId) throw new Error('Cursor sampling could not start.');
    collector = result.objectId;
    if (interrupted) await stopCollector();
    console.error(`Sampling for ${seconds} seconds. Reproduce the cursor issue in MacLink; no input is sent by this script.`);
    stage = 'sampling the cursor';
    const measured = await cdp.send('Runtime.callFunctionOn', {
      objectId: collector, functionDeclaration: 'function() { return this.done; }',
      awaitPromise: true, returnByValue: true,
    });
    if (measured.exceptionDetails) throw new Error('Cursor sampling became unavailable.');
    console.log(JSON.stringify(measured.result.value, null, 2));
  } catch {
    // Do not print raw CDP/Playwright errors, which can include URLs or object data.
    console.error(`Cursor diagnostic stopped while ${stage}. The app was not closed or changed.`);
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    await stopCollector()?.catch(() => {});
    if (cdp) {
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    // For connectOverCDP, Playwright 1.64 closes its transport here, not Chromium.
    // Never call page.close(), context.close(), or CDP Browser.close.
    await browser?.close().catch(() => {});
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

main().catch(error => {
  // Argument and filesystem failures happen before any renderer data is accessed.
  console.error(error.code === 'ENOENT' ? 'MacLink DevToolsActivePort was not found. Start MacLink or pass --port.' : error.message);
  process.exitCode = 1;
});
