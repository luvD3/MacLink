// Import and pass this function to rfbHandle.evaluate(). It is self-contained,
// does not send input/refresh requests, and never scans the JavaScript heap.
export function installInteractionProbe(rfb) {
  if (rfb._rfbConnectionState !== 'connected') throw new Error('No connected RFB session');
  window.__maclinkInteractionProbe?.stop();
  const sock = rfb._sock, ws = sock._websocket, display = rfb._display, messages = rfb.constructor.messages;
  const now = () => performance.now(), origin = performance.timeOrigin;
  const installedAt = now(), limit = 20_000, segments = [], restores = [], observers = new Map();
  let active, marker, frame, rectangle, sending, stopped = false, stoppingScheduled = false;
  let serial = 0, fbuId = 0, rectId = 0, flipId = 0, inputId = 0, records = 0, wsId = 0;
  let received = sock.rQlen(), stopTimer, longTasks;
  const chunks = received ? [{ id: 0, start: 0, end: received, at: null }] : [];
  const oldMessage = ws.onmessage;
  let damage = { firstAt: null, lastAt: null, draws: 0, rectangles: new Set(), frames: new Set() };
  const environment = () => ({ visibility: document.visibilityState, focused: document.hasFocus() });
  const intersects = (a, b) => a && b && a.width > 0 && a.height > 0 &&
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  function record(segment, type, fields = {}, at = now()) {
    if (!segment || stopped) return;
    if (records >= limit) {
      if (!stoppingScheduled) { stoppingScheduled = true; queueMicrotask(() => stop('record-limit')); }
      return;
    }
    records++; segment.events.push({ seq: ++serial, type, at, ...fields });
  }
  function wrap(object, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key), original = object[key];
    object[key] = replacement(original);
    restores.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  }
  const position = () => received - sock.rQlen();
  function streamRange(start, end) {
    if (start == null) return { firstWs: null, lastWs: null, bytes: null };
    const first = chunks.find(chunk => chunk.start <= start && chunk.end > start);
    const last = chunks.find(chunk => chunk.start < end && chunk.end >= end);
    return { firstWs: first ?? null, lastWs: last ?? null, bytes: end - start };
  }
  function takeLongTasks(entries) {
    for (const entry of entries) {
      const segment = [...segments].reverse().find(item => entry.startTime >= item.beginAt && (item.endAt == null || entry.startTime <= item.endAt));
      record(segment, 'longtask', { startAt: entry.startTime, durationMs: entry.duration, deliveredAt: now() });
    }
  }
  function cancelObserver(state, reason) {
    cancelAnimationFrame(state.raf1); if (state.raf2 != null) cancelAnimationFrame(state.raf2);
    clearTimeout(state.timer); observers.delete(state.id);
    if (reason) record(state.segment, 'raf-observation-ended', { flip: state.id, observed: state.count, reason });
  }
  function observeRaf(segment, id, markId) {
    if (observers.size >= 16) { record(segment, 'raf-observer-limit', { flip: id }); return; }
    const state = { id, segment, count: 0 };
    state.timer = setTimeout(() => cancelObserver(state, '500ms-timeout'), 500);
    state.raf1 = requestAnimationFrame(timestamp => {
      state.count = 1; record(segment, 'raf', { flip: id, mark: markId, ordinal: 1, animationTimestamp: timestamp, ...environment() });
      state.raf2 = requestAnimationFrame(secondTimestamp => {
        state.count = 2; record(segment, 'raf', { flip: id, mark: markId, ordinal: 2, animationTimestamp: secondTimestamp, ...environment() });
        cancelObserver(state);
      });
    });
    observers.set(id, state);
  }
  function readMarker(item) {
    const startAt = now(), roi = item.data.roi;
    try {
      // Read only a small, separate CPU canvas. Never call getImageData() on
      // noVNC's backbuffer or target canvas, which can change their GPU path.
      item.context.drawImage(display._backbuffer, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);
      const pixels = item.context.getImageData(0, 0, roi.width, roi.height).data;
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
      return { hash: (hash >>> 0).toString(16).padStart(8, '0'), startAt, endAt: now() };
    } catch (error) { return { error: error?.name ?? 'readback-error', startAt, endAt: now() }; }
  }
  function finish(reason = 'finished') {
    if (!active) return segments.at(-1) ?? null;
    longTasks?.takeRecords && takeLongTasks(longTasks.takeRecords());
    const segment = active;
    for (const state of [...observers.values()]) if (state.segment === segment) cancelObserver(state, reason);
    segment.endAt = now(); segment.endEnvironment = environment(); segment.reason = reason;
    active = null; marker = null;
    return segment;
  }
  function stop(reason = 'stopped') {
    if (!stopped) {
      finish(reason); stopped = true; clearTimeout(stopTimer); longTasks?.disconnect();
      for (const state of [...observers.values()]) cancelObserver(state);
      for (const type of inputTypes) document.removeEventListener(type, input, true);
      ws.onmessage = oldMessage; for (const restore of restores.reverse()) restore();
    }
    return { installedAt, timeOrigin: origin, stoppedAt: now(), reason, records, limit, segments };
  }
  function begin(label, roi = { x: 0, y: 0, width: rfb._fbWidth, height: rfb._fbHeight }) {
    if (stopped) throw new Error('Probe stopped; install a new probe');
    if (active) finish('next-segment');
    active = { id: segments.length + 1, label: String(label).slice(0, 80), roi: { ...roi }, beginAt: now(), timeOrigin: origin,
      framebuffer: { width: rfb._fbWidth, height: rfb._fbHeight }, environment: environment(), events: [], marks: [],
      limitations: 'ROI overlap and hash change are candidate responses, not causal proof. Unchanged redraws/animations and already-in-flight frames remain possible. rAF is not GPU/display completion.' };
    segments.push(active); marker = null;
    damage = { firstAt: null, lastAt: null, draws: 0, rectangles: new Set(), frames: new Set() };
    if (frame) { frame.segments.add(active); record(active, 'fbu-already-open', { fbu: frame.id, headerAt: frame.headerAt, offset: frame.offset }); }
    return { segment: active.id, beginAt: active.beginAt, timeOrigin: origin, expiresAt: installedAt + 60_000 };
  }
  function mark(id, roi = active?.roi) {
    if (!active || stopped) throw new Error('Call begin() before mark()');
    if (!roi || !(roi.width > 0 && roi.width <= 128 && roi.height > 0 && roi.height <= 64)) throw new Error('Visual mark ROI must fit 128×64 remote pixels');
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(roi.width); canvas.height = Math.ceil(roi.height);
    const data = { id: String(id).slice(0, 80), roi: { ...roi }, samples: 0, totalReadbackMs: 0, hashAlgorithm: 'fnv1a32', causalProof: false };
    marker = { data, segment: active, context: canvas.getContext('2d', { willReadFrequently: true }) };
    const baseline = readMarker(marker);
    Object.assign(data, { baselineHash: baseline.hash ?? null, baselineAt: baseline.endAt,
      baselineReadbackMs: baseline.endAt - baseline.startAt, error: baseline.error ?? null });
    active.marks.push(data); record(active, 'mark-baseline', { ...data }, baseline.endAt);
    return { ...data }; // Root sends input only after this baseline has completed.
  }
  const inputTypes = ['keydown', 'keyup', 'wheel', ...('PointerEvent' in window
    ? ['pointerdown', 'pointerup', 'pointermove'] : ['mousedown', 'mouseup', 'mousemove'])];
  function input(event) {
    const moveOrUp = ['pointermove', 'pointerup', 'mousemove', 'mouseup'].includes(event.type);
    if (moveOrUp && !event.isTrusted) return; // Exclude noVNC's capture-proxy clones.
    const onCanvas = event.target === rfb._canvas || rfb._canvas.contains(event.target);
    const capturedDrag = moveOrUp && event.isTrusted && (rfb._mouseButtonMask & 7) !== 0;
    if (!active || (!onCanvas && !capturedDrag)) return;
    const at = now();
    record(active, 'dom-input', { input: ++inputId, kind: event.type, eventTimeStamp: event.timeStamp,
      handlerAt: at, eventToHandlerMs: at - event.timeStamp, trusted: event.isTrusted }, at);
  }
  for (const type of inputTypes) document.addEventListener(type, input, { capture: true, passive: true });
  for (const name of ['keyEvent', 'QEMUExtendedKeyEvent', 'pointerEvent']) if (typeof messages[name] === 'function') {
    wrap(messages, name, original => function(socket, ...args) {
      if (socket !== sock || !active) return original.call(this, socket, ...args);
      const previous = sending, segment = active;
      sending = { kind: name, input: inputId, segment };
      record(segment, 'rfb-input-send', { kind: name, latestDomInput: inputId });
      try { return original.call(this, socket, ...args); } finally { sending = previous; }
    });
  }
  wrap(ws, 'send', original => function(data) {
    if (sending) record(sending.segment, 'ws-input-send', { kind: sending.kind, latestDomInput: sending.input, bytes: data.byteLength });
    return original.call(this, data);
  });
  ws.onmessage = function(event) {
    const bytes = event.data.byteLength, at = now(), chunk = { id: ++wsId, start: received, end: received + bytes, at };
    chunks.push(chunk); received += bytes;
    record(active, 'ws-data', { ws: chunk.id, bytes, startOffset: chunk.start, endOffset: chunk.end, queuedBytesAfterAppend: sock.rQlen() + bytes }, at);
    if (chunks.length >= limit && !stoppingScheduled) { stoppingScheduled = true; queueMicrotask(() => stop('ws-record-limit')); }
    return oldMessage.call(this, event);
  };
  wrap(rfb, '_framebufferUpdate', original => function(...args) {
    if (!frame) {
      frame = { id: ++fbuId, headerAt: now(), offset: this._FBU.rects === 0 ? position() - 1 : null, segments: new Set() };
      record(active, 'fbu-start', { fbu: frame.id, offset: frame.offset }, frame.headerAt);
    }
    if (active) frame.segments.add(active);
    const complete = original.apply(this, args);
    if (complete) {
      const item = frame, end = position(); frame = null;
      for (const segment of item.segments) record(segment, 'fbu-complete', { fbu: item.id, headerAt: item.headerAt,
        startOffset: item.offset, endOffset: end, ...streamRange(item.offset, end) });
    }
    return complete;
  });
  wrap(rfb, '_handleDataRect', original => function(...args) {
    const { x, y, width, height, encoding } = this._FBU;
    rectangle ??= { id: ++rectId, fbu: frame?.id ?? null, firstAttemptAt: now(), cpuMs: 0, x, y, width, height, encoding };
    const item = rectangle, start = now(), complete = original.apply(this, args);
    item.cpuMs += now() - start;
    if (complete) {
      record(active, 'pixel-rectangle', { ...item, completedAt: now(), roiIntersects: intersects(item, active?.roi),
        candidateResponse: intersects(item, active?.roi), causalProof: false });
      rectangle = null;
    }
    return complete;
  });
  wrap(display, '_damage', original => function(x, y, width, height) {
    const result = original.call(this, x, y, width, height);
    if (active && intersects({ x, y, width, height }, active.roi)) {
      const at = now(); damage.firstAt ??= at; damage.lastAt = at; damage.draws++;
      if (rectangle) damage.rectangles.add(rectangle.id);
      if (frame) damage.frames.add(frame.id);
    }
    return result;
  });
  wrap(display, 'flip', original => function(fromQueue) {
    const segment = active, bounds = this._damageBounds;
    const box = { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
    const queued = this._renderQ.length !== 0 && !fromQueue, at = now(), result = original.call(this, fromQueue);
    if (!segment) return result;
    const id = ++flipId, endAt = now(), intersectsRoi = intersects(box, segment.roi);
    const pixels = !queued && intersectsRoi && damage.rectangles.size > 0;
    record(segment, 'flip', { flip: id, fbu: frame?.id ?? null, queued, damage: box, roiIntersects: intersectsRoi,
      candidatePixels: pixels, pixelRectangles: [...damage.rectangles], damageFbus: [...damage.frames],
      firstDamageAt: damage.firstAt, lastDamageAt: damage.lastAt, intersectingDraws: damage.draws, endAt, flipCpuMs: endAt - at }, at);
    let changedMark = null;
    if (!queued && marker?.segment === segment && !marker.data.error && marker.data.changedAt == null && intersects(box, marker.data.roi)) {
      const sample = readMarker(marker), data = marker.data;
      data.samples++; data.totalReadbackMs += sample.endAt - sample.startAt;
      record(segment, 'visual-hash', { mark: data.id, flip: id, fbu: frame?.id ?? null, hash: sample.hash ?? null,
        startedAt: sample.startAt, completedAt: sample.endAt, readbackMs: sample.endAt - sample.startAt, error: sample.error ?? null });
      if (sample.error) data.error = sample.error;
      else if (sample.hash !== data.baselineHash) {
        Object.assign(data, { changedAt: sample.endAt, changedHash: sample.hash, flip: id, fbu: frame?.id ?? null,
          flipAt: at, latestDomInput: inputId }); changedMark = data.id;
        record(segment, 'visual-change', { ...data, observation: 'first changed ROI hash; causal link requires external verification' }, sample.endAt);
      }
    }
    if (!queued) {
      if (pixels || changedMark) observeRaf(segment, id, changedMark);
      damage = { firstAt: null, lastAt: null, draws: 0, rectangles: new Set(), frames: new Set() };
    }
    return result;
  });
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    longTasks = new PerformanceObserver(list => takeLongTasks(list.getEntries())); longTasks.observe({ type: 'longtask' });
  }
  const disconnected = () => stop('disconnected');
  rfb.addEventListener('disconnect', disconnected, { once: true });
  restores.push(() => rfb.removeEventListener('disconnect', disconnected));
  stopTimer = setTimeout(() => stop('60s-timeout'), 60_000);
  window.__maclinkInteractionProbe = { begin, mark, finish, stop };
  return { installed: true, installedAt, timeOrigin: origin, maxDurationMs: 60_000, maxRecords: limit,
    markMaxSize: { width: 128, height: 64 }, methods: ['begin(label, roi)', 'mark(id, roi)', 'finish()', 'stop()'] };
}
