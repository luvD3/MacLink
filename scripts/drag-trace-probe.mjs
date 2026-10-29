// Self-contained temporary probe for rfbHandle.evaluate(installDragTrace, roi).
// It sends no input and records only coordinates/timing, never pixel arrays.
// If layered over another probe, stop the newest probe first (LIFO).
export function installDragTrace(rfb, roi) {
  if (rfb._rfbConnectionState !== 'connected') throw new Error('No connected RFB session');
  if (!roi || !(roi.width > 0 && roi.width <= 128 && roi.height > 0 && roi.height <= 64)) throw new Error('ROI must fit 128×64 remote pixels');
  window.__maclinkDragTrace?.stop();
  roi = { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
  const sock = rfb._sock, ws = sock._websocket, display = rfb._display, messages = rfb.constructor.messages;
  const now = () => performance.now(), timeOrigin = performance.timeOrigin, installedAt = now();
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(roi.width); canvas.height = Math.ceil(roi.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const segments = [], restores = [], limit = 15_000;
  let active, currentPhase, lastSend = null, lastDom = null, sending, stopped = false, stopScheduled = false, timer, count = 0;
  let restoreWarnings = [];
  const environment = () => ({ visibility: document.visibilityState, focused: document.hasFocus() });
  const intersects = box => box.width > 0 && box.height > 0 && box.x < roi.x + roi.width &&
    box.x + box.width > roi.x && box.y < roi.y + roi.height && box.y + box.height > roi.y;
  function record(type, data, at = now()) {
    if (!active || stopped) return;
    if (count >= limit) {
      if (!stopScheduled) { stopScheduled = true; queueMicrotask(() => stop('record-limit')); }
      return;
    }
    count++; active.events.push({ type, phase: currentPhase?.id ?? null, at, ...data });
  }
  function wrap(object, key, make) {
    const original = object[key], descriptor = Object.getOwnPropertyDescriptor(object, key), wrapped = make(original);
    let restored = false;
    object[key] = wrapped;
    restores.push(() => {
      if (restored) return;
      if (object[key] !== wrapped) { restoreWarnings.push(key); return; }
      if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];
      restored = true;
    });
  }
  function centroid() {
    const startedAt = now();
    try {
      // The primary/backbuffer canvas is never read with getImageData().
      context.drawImage(display._backbuffer, roi.x, roi.y, roi.width, roi.height, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let redPixels = 0, sumX = 0, sumY = 0;
      for (let y = 0, offset = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++, offset += 4) {
        const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        if (r > 180 && g >= 40 && g <= 140 && b >= 30 && b <= 140) { redPixels++; sumX += x; sumY += y; }
      }
      const sampledAt = now();
      return { centerX: redPixels ? roi.x + sumX / redPixels : null, centerY: redPixels ? roi.y + sumY / redPixels : null,
        redPixels, startedAt, sampledAt, readbackMs: sampledAt - startedAt };
    } catch (error) { return { centerX: null, centerY: null, redPixels: 0, startedAt, sampledAt: now(), readbackMs: now() - startedAt, error: error?.name ?? 'readback-error' }; }
  }
  function finish(reason = 'finished') {
    if (!active) return segments.at(-1) ?? null;
    const result = active; result.finishedAt = now(); result.reason = reason; result.endEnvironment = environment();
    active = null; currentPhase = null; return result;
  }
  function stop(reason = 'stopped') {
    if (!stopped) {
      finish(reason); stopped = true; clearTimeout(timer);
      for (const type of inputTypes) document.removeEventListener(type, input, true);
      rfb.removeEventListener('disconnect', disconnected);
    }
    restoreWarnings = []; for (const restore of [...restores].reverse()) restore();
    return { installedAt, stoppedAt: now(), timeOrigin, reason, roi, records: count, restoreWarnings, segments };
  }
  function begin(label) {
    if (stopped) throw new Error('Probe stopped; install a new probe');
    if (active) finish('next-segment');
    active = { id: segments.length + 1, label: String(label).slice(0, 80), beganAt: now(), timeOrigin, roi,
      framebuffer: { width: rfb._fbWidth, height: rfb._fbHeight }, environment: environment(), phases: [], events: [],
      limitation: 'Red centroid is a visual position observation. Position matching is external; flip/readback do not prove display presentation. Readback adds the recorded probe overhead.' };
    segments.push(active); currentPhase = null;
    return { segment: active.id, beganAt: active.beganAt, timeOrigin, expiresAt: installedAt + 60_000, lastSend };
  }
  function phase(id) {
    if (!active || stopped) throw new Error('Call begin() before phase()');
    const baseline = centroid();
    currentPhase = { id: String(id).slice(0, 80), startedAt: now(), baseline,
      initialPointer: lastSend ? { ...lastSend } : null, initialDom: lastDom ? { ...lastDom } : null };
    active.phases.push(currentPhase); record('phase', { baseline, initialPointer: currentPhase.initialPointer }, currentPhase.startedAt);
    return currentPhase; // Baseline work finishes before root drives this sweep.
  }
  const inputTypes = ['PointerEvent' in window ? 'pointermove' : 'mousemove', 'mousedown', 'mouseup'];
  function input(event) {
    const moveOrUp = ['pointermove', 'pointerup', 'mousemove', 'mouseup'].includes(event.type);
    if (moveOrUp && !event.isTrusted) return; // Exclude noVNC's capture-proxy clones.
    const onCanvas = event.target === rfb._canvas || rfb._canvas.contains(event.target);
    const capturedDrag = moveOrUp && event.isTrusted && (rfb._mouseButtonMask & 7) !== 0;
    if (stopped || (!onCanvas && !capturedDrag)) return;
    const handlerAt = now();
    lastDom = { kind: event.type, clientX: event.clientX, clientY: event.clientY, buttons: event.buttons,
      eventTimeStamp: event.timeStamp, handlerAt, eventToHandlerMs: handlerAt - event.timeStamp, trusted: event.isTrusted };
    record('dom-pointer', lastDom, handlerAt);
  }
  for (const type of inputTypes) document.addEventListener(type, input, { capture: true, passive: true });
  for (const name of ['pointerEvent', 'extendedPointerEvent']) if (typeof messages[name] === 'function') {
    wrap(messages, name, original => function(socket, x, y, mask) {
      if (socket !== sock || stopped) return original.call(this, socket, x, y, mask);
      const previous = sending; sending = { x, y, mask, messageAt: now(), format: name };
      try { return original.call(this, socket, x, y, mask); } finally { sending = previous; }
    });
  }
  wrap(ws, 'send', original => function(data) {
    if (sending && !stopped) {
      lastSend = { ...sending, at: now(), bytes: data.byteLength };
      record('pointer-send', lastSend, lastSend.at);
    }
    return original.call(this, data);
  });
  wrap(display, 'flip', original => function(fromQueue) {
    if (!active || stopped) return original.call(this, fromQueue);
    const bounds = this._damageBounds, box = { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
    const queued = this._renderQ.length !== 0 && !fromQueue, flipAt = now(), result = original.call(this, fromQueue), flipEndAt = now();
    if (!queued && intersects(box)) {
      const red = centroid();
      record('red-centroid', { flipAt, flipEndAt, flipCpuMs: flipEndAt - flipAt, damage: box, ...red,
        lastSentPointer: lastSend ? { ...lastSend } : null }, red.sampledAt);
    }
    return result;
  });
  const disconnected = () => stop('disconnected');
  rfb.addEventListener('disconnect', disconnected, { once: true });
  timer = setTimeout(() => stop('60s-timeout'), 60_000);
  window.__maclinkDragTrace = { begin, phase, finish, stop, captureLastSend: () => lastSend ? { ...lastSend } : null };
  return { installed: true, installedAt, timeOrigin, roi, maxDurationMs: 60_000, maxRecords: limit,
    methods: ['begin(label)', 'phase(id)', 'finish()', 'stop()', 'captureLastSend()'], stopOrder: 'Newest probe first (LIFO); inspect restoreWarnings.' };
}
