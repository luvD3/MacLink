// Experimental Apple protocol probe; deliberately not part of the application.
// Credentials stay in the already authenticated viewer. Only protocol metadata
// and timing are saved, never desktop pixels or clipboard/keyboard contents.
import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argument = process.argv[2];
if (!['baseline', '1', '0.5'].includes(argument)) {
  throw new Error('Usage: node scripts/transmission-scale-probe.mjs baseline|1|0.5');
}
const port = (await readFile(path.join(process.env.APPDATA, 'MacLink', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const page = browser.contexts()[0].pages()[0];
  if (await page.locator('[data-session-state]').getAttribute('data-session-state') !== 'connected') {
    throw new Error('Log in through MacLink before running this probe.');
  }
  const rfb = await page.evaluateHandle(() => {
    const shell = document.querySelector('.app-shell');
    let fiber = shell?.[Object.keys(shell).find((key) => key.startsWith('__reactFiber$'))];
    while (fiber) {
      const session = fiber.memoizedState?.memoizedState;
      if (typeof session?.getSnapshot === 'function' && session.active?.rfb) return session.active.rfb;
      fiber = fiber.return;
    }
    throw new Error('No active viewer session');
  });
  const report = await rfb.evaluate(async (rfb, argument) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const started = performance.now();
    const metadata = () => ({ width: rfb._fbWidth, height: rfb._fbHeight, version: rfb._rfbVersion, auth: rfb._rfbAuthScheme, state: rfb._rfbConnectionState });
    const result = { argument, startedAt: new Date().toISOString(), before: metadata(), resize: [], rectangles: {}, bytes: 0, messages: 0, flips: 0, errors: [] };
    const resize = rfb._resize;
    const handleRect = rfb._handleRect;
    const flip = rfb._display.flip;
    const fail = rfb._fail;
    const ws = rfb._sock._websocket;
    const onMessage = (event) => { result.bytes += event.data.byteLength; result.messages++; };
    ws.addEventListener('message', onMessage);
    rfb._resize = function (width, height) {
      result.resize.push({ width, height, at: performance.now() - started });
      return resize.call(this, width, height);
    };
    rfb._handleRect = function () {
      const { x, y, width, height, encoding } = this._FBU;
      const complete = handleRect.call(this);
      if (complete) {
        const key = String(encoding);
        const entry = result.rectangles[key] ??= { count: 0, maxRight: 0, maxBottom: 0, pixels: 0 };
        entry.count++;
        entry.maxRight = Math.max(entry.maxRight, x + width);
        entry.maxBottom = Math.max(entry.maxBottom, y + height);
        entry.pixels += width * height;
      }
      return complete;
    };
    rfb._display.flip = function (...args) { result.flips++; return flip.apply(this, args); };
    rfb._fail = function (reason) { result.errors.push(String(reason)); return fail.call(this, reason); };
    try {
      const deadline = performance.now() + 5000;
      while (rfb._FBU.rects !== 0 || rfb._display.pending()) {
        if (performance.now() > deadline) throw new Error('No complete framebuffer boundary within five seconds');
        await wait(10);
      }
      if (argument !== 'baseline') {
        // Candidate Apple message from iShareScreen §8.10, not UltraVNC's
        // unrelated four-byte SetScale message. Compatibility is unconfirmed.
        const bytes = new Uint8Array(10);
        bytes[0] = 8;
        new DataView(bytes.buffer).setFloat64(2, Number(argument), false);
        result.sentHex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        rfb._sock.sQpushBytes(bytes);
        rfb._sock.flush();
      }
      // A still desktop can leave an incremental request unanswered forever.
      // One standard full refresh tests whether the parser remains aligned.
      const bytes = new Uint8Array(10);
      bytes[0] = 3;
      const view = new DataView(bytes.buffer);
      view.setUint16(6, rfb._fbWidth, false);
      view.setUint16(8, rfb._fbHeight, false);
      rfb._sock.sQpushBytes(bytes);
      rfb._sock.flush();
      result.sentAtMs = performance.now() - started;
      await wait(5000);
      result.after = metadata();
      return result;
    } finally {
      ws.removeEventListener('message', onMessage);
      rfb._resize = resize;
      rfb._handleRect = handleRect;
      rfb._display.flip = flip;
      rfb._fail = fail;
    }
  }, argument);
  await rfb.dispose();
  await mkdir('test-results', { recursive: true });
  const file = `test-results/transmission-scale-${argument}-${Date.now()}.json`;
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ file, ...report }));
} finally {
  await browser.close();
}
