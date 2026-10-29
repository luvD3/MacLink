// Live metadata probe: one warmup and five controlled full refresh requests.
// No keyboard/mouse, pixels, compressed payloads, clipboard, credentials or URLs
// are read. Do not use Runtime.queryObjects with the WASM renderer.
// node scripts/latency-check.mjs [CDP_PORT] [--allow-incremental] [--output path]
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exported only so the instrumentation can be smoke-tested with synthetic RFB
// objects. Playwright serializes this function into the existing renderer.
export async function measureLatency(rfb, { controlled = true, samples = 5, timeoutMs = 10_000 } = {}) {
  if (rfb._rfbConnectionState !== 'connected') throw new Error('Viewer is not connected');
  if (controlled && rfb._enabledContinuousUpdates) throw new Error('Continuous updates are enabled; controlled request isolation is unavailable');
  const sock = rfb._sock;
  const ws = sock._websocket;
  const display = rfb._display;
  const messages = rfb.constructor.messages;
  const framebuffer = { width: rfb._fbWidth, height: rfb._fbHeight };
  const originalMessage = ws.onmessage;
  const originalRequest = messages.fbUpdateRequest;
  const restores = [];
  const now = () => performance.now();
  const environment = () => ({ visibility: document.visibilityState, focused: document.hasFocus() });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rounded = value => Math.round(value * 100) / 100;
  const probeStartedAt = now();
  let received = sock.rQlen();
  const chunks = received ? [{ id: 0, start: 0, end: received, at: null }] : [];
  let wsId = 0, frameId = 0, active, frame, rect, pendingRectHeader;
  let expectingLength = false, framebufferDepth = 0, sendingProbe = false;
  let lastFbuCompleteAt = probeStartedAt, skippedIncremental = 0, requestTimer;
  let raf1Id, raf2Id, rafTimer;
  const queuedFlips = [];
  const attempts = [];
  const allFrames = [];

  function wrap(object, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const original = object[key];
    object[key] = replacement(original);
    restores.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  }
  function event(type, fields = {}, at = now()) {
    if (active) active.timeline.push({ type, at, ...fields });
  }
  function touchFrame(item) {
    if (active && item) active.frames.set(item.id, item);
  }
  function sampleQueue(extra = 0) {
    const bytes = sock.rQlen() + extra;
    if (active) active.rQMax = Math.max(active.rQMax, bytes);
    if (frame) frame.rQMax = Math.max(frame.rQMax, bytes);
    return bytes;
  }
  const streamPosition = () => received - sock.rQlen();
  function chunkAt(offset) {
    if (offset == null) return null;
    let lo = 0, hi = chunks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, chunk = chunks[mid];
      if (offset < chunk.start) hi = mid - 1;
      else if (offset >= chunk.end) lo = mid + 1;
      else return chunk;
    }
    return null;
  }
  function rangeStats(start, end) {
    if (start == null || end == null) return null;
    const overlapping = chunks.filter(chunk => chunk.end > start && chunk.start < end);
    return {
      bytes: end - start,
      wsMessages: overlapping.filter(chunk => chunk.id !== 0).length,
      firstWsId: overlapping[0]?.id ?? null,
      firstWsAt: overlapping[0]?.at ?? null,
      lastWsId: overlapping.at(-1)?.id ?? null,
      lastWsAt: overlapping.at(-1)?.at ?? null,
      includedBufferedBeforeProbe: overlapping.some(chunk => chunk.id === 0),
    };
  }
  // Metadata-only union area prevents overlapping incremental rectangles from
  // being mistaken for a complete refresh merely by adding their areas.
  function coveredPixels(rectangles) {
    const boxes = rectangles.filter(item => item.picture && item.complete).map(item => ({
      x1: Math.max(0, item.x), y1: Math.max(0, item.y),
      x2: Math.min(framebuffer.width, item.x + item.width),
      y2: Math.min(framebuffer.height, item.y + item.height),
    })).filter(box => box.x2 > box.x1 && box.y2 > box.y1);
    const xs = [...new Set(boxes.flatMap(box => [box.x1, box.x2]))].sort((a, b) => a - b);
    let area = 0;
    for (let i = 1; i < xs.length; i++) {
      const intervals = boxes.filter(box => box.x1 < xs[i] && box.x2 > xs[i - 1]).sort((a, b) => a.y1 - b.y1);
      let height = 0, bottom = 0;
      for (const box of intervals) { height += Math.max(0, box.y2 - Math.max(bottom, box.y1)); bottom = Math.max(bottom, box.y2); }
      area += (xs[i] - xs[i - 1]) * height;
    }
    return area;
  }
  function finishAttempt(status) {
    if (!active || active.finishedAt != null) return;
    active.status = status;
    active.finishedAt = now();
    active.environmentAtEnd = environment();
    clearTimeout(requestTimer); clearTimeout(rafTimer);
    if (raf1Id != null) cancelAnimationFrame(raf1Id);
    if (raf2Id != null) cancelAnimationFrame(raf2Id);
    active.resolve();
  }
  function observeRaf(attempt) {
    if (attempt.rafStarted || active !== attempt) return;
    attempt.rafStarted = true;
    attempt.environmentAtFlip = environment();
    rafTimer = setTimeout(() => finishAttempt('matched-raf-timeout'), 500);
    raf1Id = requestAnimationFrame(() => {
      if (active !== attempt) return;
      attempt.raf1At = now(); event('raf-1', {}, attempt.raf1At);
      raf2Id = requestAnimationFrame(() => {
        if (active !== attempt) return;
        attempt.raf2At = now(); event('raf-2', {}, attempt.raf2At);
        finishAttempt('matched');
      });
    });
  }
  function matchFrame(item) {
    if (!active || active.target || !item.complete) return;
    if (item.headerOffset == null || item.headerOffset < active.receiveFence) return;
    if (item.coverage < 0.95) return;
    active.target = item;
    event('target-fbu', { frame: item.id });
    if (item.flipEndAt != null) observeRaf(active);
  }

  try {
    ws.onmessage = function(message) {
      const at = now(), bytes = message.data.byteLength;
      const chunk = { id: ++wsId, start: received, end: received + bytes, at };
      chunks.push(chunk); received += bytes;
      if (active) {
        active.wsBytes += bytes; active.wsMessages++;
        if (bytes && active.firstWsAt == null) active.firstWsAt = at;
        event('ws-data', { ws: chunk.id, bytes }, at);
      }
      sampleQueue(bytes); // Queue immediately after noVNC appends this message.
      return originalMessage.call(this, message);
    };
    wrap(ws, 'send', original => function(data) {
      if (sendingProbe && active) {
        active.requestSentAt = now();
        active.receiveFence = received;
        event('request-sent', { bytes: data.byteLength }, active.requestSentAt);
      }
      return original.call(this, data);
    });
    wrap(messages, 'fbUpdateRequest', original => function(socket, incremental, ...geometry) {
      if (socket === sock && incremental && controlled) {
        skippedIncremental++;
        if (active) active.skippedIncremental++;
        event('incremental-skipped');
        return;
      }
      if (socket === sock && !sendingProbe) event(incremental ? 'incremental-sent' : 'other-full-request');
      return original.call(this, socket, incremental, ...geometry);
    });
    wrap(rfb, '_framebufferUpdate', original => function(...args) {
      if (!frame) {
        const beginning = this._FBU.rects === 0;
        frame = { id: ++frameId, headerOffset: beginning ? streamPosition() - 1 : null,
          headerStartAt: beginning ? now() : null, observedAt: now(), startedBeforeProbe: !beginning,
          rectangles: [], rQMax: sock.rQlen(), complete: false };
        allFrames.push(frame);
        event('fbu-start', { frame: frame.id }, frame.observedAt);
      }
      const item = frame;
      touchFrame(item); framebufferDepth++;
      let complete;
      try { complete = original.apply(this, args); } finally { framebufferDepth--; }
      if (complete) {
        item.complete = true; item.endOffset = streamPosition(); item.completedAt = now();
        item.coverage = coveredPixels(item.rectangles) / (framebuffer.width * framebuffer.height);
        lastFbuCompleteAt = item.completedAt;
        event('fbu-complete', { frame: item.id }, item.completedAt);
        frame = null; rect = null; pendingRectHeader = null;
        matchFrame(item);
      }
      return complete;
    });
    wrap(sock, 'rQwait', original => function(label, length, ...rest) {
      const at = now();
      if (framebufferDepth && label === 'rect header' && !pendingRectHeader) {
        pendingRectHeader = { offset: streamPosition(), startedAt: at };
        event('rect-header-start', { frame: frame.id, bytes: length }, at);
      }
      const waiting = original.call(this, label, length, ...rest);
      sampleQueue();
      if (!waiting && framebufferDepth && frame) {
        if (label === 'FBU header') { frame.headerReadyAt = at; event('fbu-header-ready', { frame: frame.id, bytes: length }, at); }
        if (label === 'rect header') pendingRectHeader.readyAt = at;
        if (rect?.encoding === 16 && label === 'ZLib data length') expectingLength = true;
        if (rect?.encoding === 16 && label === 'Zlib data' && rect.payloadReadyAt == null) {
          rect.payloadReadyAt = at;
          rect.payloadEndOffset = rect.payloadOffset + length;
          rect.lastPayloadWsAt = chunkAt(rect.payloadEndOffset - 1)?.at ?? null;
          event('zrle-data-ready', { frame: frame.id, rect: rect.index, bytes: length }, at);
        }
      }
      return waiting;
    });
    wrap(sock, 'rQshift32', original => function(...args) {
      const value = original.apply(this, args);
      if (expectingLength && rect?.encoding === 16) {
        expectingLength = false;
        rect.compressedBytes = value; rect.lengthKnownAt = now(); rect.payloadOffset = streamPosition();
        event('zrle-length-known', { frame: frame.id, rect: rect.index, bytes: value }, rect.lengthKnownAt);
      }
      return value;
    });
    wrap(rfb, '_handleRect', original => function(...args) {
      if (!rect) {
        const { x, y, width, height, encoding } = this._FBU;
        rect = { index: frame.rectangles.length, x, y, width, height, encoding,
          picture: Boolean(this._decoders[encoding]), headerOffset: pendingRectHeader?.offset ?? null,
          headerStartAt: pendingRectHeader?.startedAt ?? null, headerReadyAt: pendingRectHeader?.readyAt ?? now(),
          complete: false, handlerCpuMs: 0 };
        frame.rectangles.push(rect); pendingRectHeader = null;
        // The probe may have attached while this rectangle was waiting for data.
        if (encoding === 16 && this._decoders[16]._length > 0) {
          rect.compressedBytes = this._decoders[16]._length;
          rect.payloadOffset = streamPosition(); rect.lengthKnownBeforeProbe = true;
        }
        event('rect-header-ready', { frame: frame.id, rect: rect.index, bytes: 12 }, rect.headerReadyAt);
      }
      touchFrame(frame);
      const item = rect, start = now();
      const complete = original.apply(this, args);
      item.handlerCpuMs += now() - start;
      if (complete) {
        item.complete = true; item.completedAt = now();
        if (item.decodeStartAt != null) item.decodeEndAt = item.completedAt;
        event('rect-complete', { frame: frame.id, rect: item.index }, item.completedAt);
        rect = null;
      }
      return complete;
    });
    const inflater = rfb._decoders[16]?._inflator;
    if (inflater) wrap(inflater, 'setInput', original => function(data) {
      if (rect?.encoding === 16 && data !== null) {
        rect.decodeStartAt = now();
        event('decode-start', { frame: frame.id, rect: rect.index }, rect.decodeStartAt);
      }
      return original.call(this, data);
    });
    wrap(display, 'flip', original => function(fromQueue) {
      const item = fromQueue ? queuedFlips.shift() : framebufferDepth ? frame : null;
      const queued = this._renderQ.length !== 0 && !fromQueue;
      const start = now();
      if (item) {
        item.flipCallAt ??= start;
        if (queued) queuedFlips.push(item);
        event(queued ? 'flip-queued' : 'flip-start', { frame: item.id }, start);
      }
      const result = original.call(this, fromQueue);
      if (item && !queued) {
        item.flipStartAt = start; item.flipEndAt = now();
        event('flip-end', { frame: item.id }, item.flipEndAt);
        if (active?.target === item) observeRaf(active);
      }
      return result;
    });

    async function request(kind, index) {
      let resolve;
      const complete = new Promise(done => { resolve = done; });
      const attempt = { kind, index, requestSentAt: now(), receiveFence: received, resolve,
        environmentAtRequest: environment(), wsBytes: 0, wsMessages: 0, skippedIncremental: 0,
        rQMax: sock.rQlen(), rQAtRequest: sock.rQlen(), frames: new Map(), timeline: [] };
      attempts.push(attempt); active = attempt; touchFrame(frame);
      requestTimer = setTimeout(() => finishAttempt(rfb._rfbConnectionState === 'connected' ? 'target-timeout' : 'disconnected'), timeoutMs);
      sendingProbe = true;
      try { messages.fbUpdateRequest(sock, false, 0, 0, framebuffer.width, framebuffer.height); }
      finally { sendingProbe = false; }
      await complete;
      active = undefined;
      return attempt;
    }

    const warmup = await request('warmup', 0);
    const drainStartedAt = now();
    let drainEndedAt = drainStartedAt;
    let drained = false;
    if (warmup.target) {
      do {
        drained = now() - lastFbuCompleteAt >= 500 && !frame && sock.rQlen() === 0 && !display.pending();
        if (drained) break;
        await delay(50);
      } while (now() - drainStartedAt < 3000);
      drainEndedAt = now();
      for (let index = 1; index <= samples; index++) {
        const attempt = await request('sample', index);
        if (!attempt.target || rfb._rfbConnectionState !== 'connected') break;
      }
    }

    function serializeAttempt(attempt) {
      const relative = value => value == null ? null : rounded(value - attempt.requestSentAt);
      const interval = (a, b) => a == null || b == null ? null : rounded(b - a);
      function serializeFrame(item) {
        const bytes = rangeStats(item.headerOffset, item.endOffset);
        return {
          id: item.id, complete: item.complete, startedBeforeProbe: item.startedBeforeProbe,
          headerBytesReceivedBeforeRequest: item.headerOffset == null || item.headerOffset < attempt.receiveFence,
          coverage: item.coverage == null ? null : rounded(item.coverage * 100), rQMax: item.rQMax,
          firstWsAtMs: relative(bytes?.firstWsAt), firstWsId: bytes?.firstWsId ?? null,
          lastWsAtMs: relative(bytes?.lastWsAt), bytes: bytes?.bytes ?? null, wsMessages: bytes?.wsMessages ?? null,
          fbuHeaderStartMs: relative(item.headerStartAt), fbuHeaderReadyMs: relative(item.headerReadyAt),
          completeMs: relative(item.completedAt), flipCallMs: relative(item.flipCallAt),
          flipStartMs: relative(item.flipStartAt), flipEndMs: relative(item.flipEndAt),
          rectangles: item.rectangles.map(rectangle => ({
            index: rectangle.index, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
            encoding: rectangle.encoding, complete: rectangle.complete,
            headerStartMs: relative(rectangle.headerStartAt), headerReadyMs: relative(rectangle.headerReadyAt),
            compressedBytes: rectangle.compressedBytes ?? null, lengthKnownBeforeProbe: rectangle.lengthKnownBeforeProbe ?? false,
            lengthKnownMs: relative(rectangle.lengthKnownAt), lastPayloadWsMs: relative(rectangle.lastPayloadWsAt),
            payloadReadyMs: relative(rectangle.payloadReadyAt), decodeStartMs: relative(rectangle.decodeStartAt),
            decodeEndMs: relative(rectangle.decodeEndAt), decodeMs: interval(rectangle.decodeStartAt, rectangle.decodeEndAt),
            handlerCpuMs: rounded(rectangle.handlerCpuMs),
          })),
        };
      }
      const target = attempt.target;
      const targetBytes = target ? rangeStats(target.headerOffset, target.endOffset) : null;
      const zrle = target?.rectangles.filter(item => item.encoding === 16) ?? [];
      const defined = (values, operation) => { const present = values.filter(value => value != null); return present.length ? operation(...present) : null; };
      const lastPayloadAt = defined(zrle.map(item => item.lastPayloadWsAt), Math.max);
      const lastReadyAt = defined(zrle.map(item => item.payloadReadyAt), Math.max);
      const lastDecodeAt = defined(zrle.map(item => item.decodeEndAt), Math.max);
      const wsEvents = attempt.timeline.filter(item => item.type === 'ws-data');
      const keepWs = new Set();
      for (let i = 0; i < Math.min(96, wsEvents.length); i++) keepWs.add(wsEvents[Math.round(i * (wsEvents.length - 1) / Math.max(1, Math.min(96, wsEvents.length) - 1))]);
      return {
        kind: attempt.kind, index: attempt.index, status: attempt.status,
        environmentAtRequest: attempt.environmentAtRequest, environmentAtFlip: attempt.environmentAtFlip ?? null,
        environmentAtEnd: attempt.environmentAtEnd,
        requestSentEpochMs: rounded(performance.timeOrigin + attempt.requestSentAt),
        boundariesMs: { requestSent: 0, firstWsAfterRequest: relative(attempt.firstWsAt),
          targetFirstWs: relative(targetBytes?.firstWsAt), fbuHeaderStart: relative(target?.headerStartAt),
          fbuHeaderReady: relative(target?.headerReadyAt),
          firstRectHeader: relative(target?.rectangles[0]?.headerReadyAt),
          firstZrleLengthKnown: relative(defined(zrle.map(item => item.lengthKnownAt), Math.min)),
          lastZrlePayloadWs: relative(lastPayloadAt), lastZrlePayloadReady: relative(lastReadyAt),
          firstDecodeStart: relative(defined(zrle.map(item => item.decodeStartAt), Math.min)),
          lastDecodeEnd: relative(lastDecodeAt), flipCall: relative(target?.flipCallAt),
          flipStart: relative(target?.flipStartAt), flipEnd: relative(target?.flipEndAt),
          raf1: relative(attempt.raf1At), raf2: relative(attempt.raf2At), finished: relative(attempt.finishedAt) },
        intervalsMs: { requestToTargetFirstWs: interval(attempt.requestSentAt, targetBytes?.firstWsAt),
          targetWsArrivalSpan: interval(targetBytes?.firstWsAt, targetBytes?.lastWsAt),
          lastPayloadArrivalToReady: interval(lastPayloadAt, lastReadyAt),
          zrleDecodeCpu: rounded(zrle.reduce((sum, item) => sum + (item.decodeEndAt == null ? 0 : item.decodeEndAt - item.decodeStartAt), 0)),
          lastDecodeToFlip: interval(lastDecodeAt, target?.flipStartAt),
          flipCpu: interval(target?.flipStartAt, target?.flipEndAt),
          flipToRaf2: interval(target?.flipEndAt, attempt.raf2At),
          requestToRaf2: interval(attempt.requestSentAt, attempt.raf2At) },
        ws: { bytes: attempt.wsBytes, messages: attempt.wsMessages }, rQAtRequest: attempt.rQAtRequest,
        rQMax: attempt.rQMax, skippedIncremental: attempt.skippedIncremental,
        target: target ? serializeFrame(target) : null,
        nonTargetFbus: [...attempt.frames.values()].filter(item => item !== target).map(serializeFrame),
        timelineWsOmitted: wsEvents.length - keepWs.size,
        timeline: attempt.timeline.filter(item => item.type !== 'ws-data' || keepWs.has(item)).map(({ at, ...item }) => ({ ...item, ms: relative(at) })),
      };
    }
    return {
      generatedAt: new Date().toISOString(), mode: controlled ? 'controlled-full-refresh' : 'full-refresh-with-live-incremental',
      framebuffer, controlled, strictIsolation: controlled && drained,
      warmupDrain: { quiet500ms: drained, elapsedMs: rounded(drainEndedAt - drainStartedAt),
        note: 'No FBU completed for 500ms, receive queue empty and no pending display work; capped at 3s.' },
      drainFbus: allFrames.filter(item => item.observedAt >= drainStartedAt && item.observedAt <= drainEndedAt).map(item => ({
        id: item.id, complete: item.complete, coverage: item.coverage == null ? null : rounded(item.coverage * 100),
        headerEpochMs: item.headerStartAt == null ? null : rounded(performance.timeOrigin + item.headerStartAt),
        completeEpochMs: item.completedAt == null ? null : rounded(performance.timeOrigin + item.completedAt),
        rectangles: item.rectangles.map(({ x, y, width, height, encoding, compressedBytes }) => ({ x, y, width, height, encoding, compressedBytes })),
      })),
      requestedSamples: samples, skippedIncremental, connectionStateAtEnd: rfb._rfbConnectionState,
      framesObserved: allFrames.length, results: attempts.map(serializeAttempt),
      meanings: {
        matching: 'First completed post-request FBU covering at least 95% of framebuffer by rectangle union. Pre-request buffered headers and smaller updates are non-target. RFB has no request IDs; warmup/drain plus suppressed incrementals reduce, but cannot prove away all server-side coalescing.',
        firstWsAfterRequest: 'Any first WS data, explicitly unattributed. targetFirstWs is the WS event containing the selected FBU header, mapped by stream byte offsets without reading payload.',
        waiting: 'Request-to-data and WS arrival spans include server capture/encoding, transport, bridge batching, scheduling and any preceding work. They are not pure network RTT.',
        decode: 'ZRLE data-ready is the successful rQwait boundary; decode starts at inflater.setInput and ends when the original rectangle handler returns. Includes synchronous pixel expansion and Canvas writes.',
        raf: 'Two callbacks after actual display.flip submission, bounded to 500ms. A callback is not proof of GPU completion or screen presentation, and this controlled refresh is not mouse-to-photon latency.',
        privacy: 'Only timing, lengths, counters, dimensions, encodings and visibility/focus metadata; no pixels, payloads or private text.' },
    };
  } finally {
    clearTimeout(requestTimer); clearTimeout(rafTimer);
    if (raf1Id != null) cancelAnimationFrame(raf1Id);
    if (raf2Id != null) cancelAnimationFrame(raf2Id);
    ws.onmessage = originalMessage;
    for (const restore of restores.reverse()) restore();
    if (controlled && rfb._rfbConnectionState === 'connected') originalRequest.call(messages, sock, true, 0, 0, rfb._fbWidth, rfb._fbHeight);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const port = args[0] && !args[0].startsWith('--') ? args[0]
    : (await readFile(path.join(process.env.APPDATA, 'MacLink', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
  const outputIndex = args.indexOf('--output');
  const output = path.resolve(outputIndex === -1 ? 'test-results/live-latency.json' : args[outputIndex + 1]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let handle;
  try {
    const page = browser.contexts()[0].pages()[0];
    // Same known first-hook path as encoding-check.mjs; never scan the heap.
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
    console.log('Measuring one warmup and five full refreshes; no input is sent. All instrumentation will be restored.');
    const report = await handle.evaluate(measureLatency, { controlled: !args.includes('--allow-incremental') });
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    for (const result of report.results) console.log(JSON.stringify({ kind: result.kind, index: result.index, status: result.status,
      environment: result.environmentAtRequest, boundariesMs: result.boundariesMs, intervalsMs: result.intervalsMs,
      ws: result.ws, rQMax: result.rQMax, targetFbu: result.target?.id ?? null, nonTargetFbus: result.nonTargetFbus.length }));
    console.log(JSON.stringify({ output, framebuffer: report.framebuffer, strictIsolation: report.strictIsolation, warmupDrain: report.warmupDrain }));
  } finally {
    await handle?.dispose();
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
