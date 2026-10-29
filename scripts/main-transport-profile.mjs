// Inspect the existing Electron main process. Records byte counts and timing only.
// Usage: node scripts/main-transport-profile.mjs <inspector-port> [duration-ms] [output.json]
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const port = Number(process.argv[2]);
const durationMs = Number(process.argv[3] ?? 30_000);
const outputFile = process.argv[4] ?? 'test-results/main-transport-profile.json';
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 120_000) {
  throw new Error('Usage: main-transport-profile.mjs <inspector-port> [duration-ms: 1000..120000] [output.json]');
}

// Self-contained: this function is evaluated in the running main process.
function profileTransport(durationMs) {
  const key = Symbol.for('maclink.transportTimingProfile');
  if (globalThis[key]) throw new Error('A transport timing profile is already active');
  const { performance, monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks');
  const sockets = process._getActiveHandles().filter(handle => handle.constructor?.name === 'Socket');
  const bridges = sockets.map(socket => {
    const symbol = Object.getOwnPropertySymbols(socket).find(symbol => symbol.description === 'websocket');
    return symbol && socket[symbol].readyState === 1 ? { socket, ws: socket[symbol] } : null;
  }).filter(Boolean);
  if (bridges.length !== 1) throw new Error('Expected exactly one active WebSocket bridge');
  const { socket: localSocket, ws } = bridges[0];
  const upstream = sockets.filter(socket => socket !== localSocket && socket.remoteAddress && socket.remotePort && !socket.destroyed);
  if (upstream.length !== 1) throw new Error('Expected exactly one active remote TCP socket');
  const tcp = upstream[0];

  const LIMIT = 60_000;
  const rows = [];
  const clientRows = [];
  const pauseRows = [];
  const sendDurations = [];
  const dispatchDurations = [];
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const originalSend = ws.send;
  const ownSend = Object.getOwnPropertyDescriptor(ws, 'send');
  const initialTcpRead = tcp.bytesRead;
  const initialTcpWritten = tcp.bytesWritten;
  const initialLocalWritten = localSocket.bytesWritten;
  const cpuStart = process.cpuUsage();
  const utilizationStart = performance.eventLoopUtilization();
  const start = performance.now();
  const epoch = time => performance.timeOrigin + time;
  const startedAtMs = epoch(start);
  let active = true;
  let currentRow = null;
  let currentReceived = start;
  let pauseStarted = tcp.isPaused() ? start : null;
  let pauseCount = 0;
  let pauseMs = 0;
  let longestPauseMs = 0;
  let receiveCount = 0;
  let receiveBytes = 0;
  let minChunk = Infinity;
  let maxChunk = 0;
  let sendCount = 0;
  let sendCompleted = 0;
  let sendErrors = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let clientMessages = 0;
  let clientBytes = 0;
  let maxQueue = ws.bufferedAmount;
  let maxTcpReadable = tcp.readableLength;
  let timer;
  let resolveReport;
  const report = new Promise(resolve => { resolveReport = resolve; });

  function receive(chunk) {
    currentReceived = performance.now();
    receiveCount++;
    receiveBytes += chunk.length;
    minChunk = Math.min(minChunk, chunk.length);
    maxChunk = Math.max(maxChunk, chunk.length);
    maxTcpReadable = Math.max(maxTcpReadable, tcp.readableLength);
    // The existing bridge synchronously sends this chunk to WebSocket next.
    currentRow = rows.length < LIMIT ? [epoch(currentReceived), chunk.length, null, null, null] : null;
    if (currentRow) rows.push(currentRow);
  }

  function send(data, options, callback) {
    const submitted = performance.now();
    const row = currentRow;
    currentRow = null;
    sendCount++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    maxQueue = Math.max(maxQueue, this.bufferedAmount);
    if (dispatchDurations.length < LIMIT) dispatchDurations.push(submitted - currentReceived);
    if (row) row[2] = epoch(submitted);
    const result = originalSend.call(this, data, options, function(error) {
      if (active) {
        const completed = performance.now();
        sendCompleted++;
        inFlight--;
        if (error) sendErrors++;
        if (sendDurations.length < LIMIT) sendDurations.push(completed - submitted);
        if (row) row[3] = epoch(completed);
        maxQueue = Math.max(maxQueue, ws.bufferedAmount);
      }
      return callback?.call(this, error);
    });
    const queued = this.bufferedAmount;
    maxQueue = Math.max(maxQueue, queued);
    if (row) row[4] = queued;
    return result;
  }

  function clientMessage(data) {
    clientMessages++;
    clientBytes += data.length;
    if (clientRows.length < LIMIT) clientRows.push([epoch(performance.now()), data.length]);
  }

  function paused() {
    pauseCount++;
    if (pauseStarted === null) pauseStarted = performance.now();
  }

  function recordPause(end) {
    if (pauseStarted === null) return;
    const elapsed = end - pauseStarted;
    pauseMs += elapsed;
    longestPauseMs = Math.max(longestPauseMs, elapsed);
    if (pauseRows.length < LIMIT) pauseRows.push([epoch(pauseStarted), elapsed]);
    pauseStarted = null;
  }

  function resumed() { recordPause(performance.now()); }
  function closed() { finish('connection-closed'); }
  function distribution(values) {
    if (!values.length) return { samples: 0, mean: null, p50: null, p95: null, p99: null, max: null };
    const sorted = values.slice().sort((a, b) => a - b);
    const at = percentile => sorted[Math.ceil(percentile * sorted.length) - 1];
    return { samples: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
  }

  function finish(reason) {
    if (!active) return;
    active = false;
    const end = performance.now();
    const cpu = process.cpuUsage(cpuStart);
    const utilization = performance.eventLoopUtilization(utilizationStart);
    const loopDelay = { min: eventLoop.min / 1e6, mean: eventLoop.mean / 1e6, p50: eventLoop.percentile(50) / 1e6, p95: eventLoop.percentile(95) / 1e6, p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 };
    eventLoop.disable();
    clearTimeout(timer);
    tcp.removeListener('data', receive);
    tcp.removeListener('pause', paused);
    tcp.removeListener('resume', resumed);
    tcp.removeListener('close', closed);
    ws.removeListener('message', clientMessage);
    ws.removeListener('close', closed);
    if (ws.send === send) {
      if (ownSend) Object.defineProperty(ws, 'send', ownSend);
      else delete ws.send;
    }
    delete globalThis[key];
    recordPause(end);
    const elapsedMs = end - start;
    resolveReport({
      schemaVersion: 1,
      startedAtMs,
      stoppedAtMs: epoch(end),
      reason,
      summary: {
        elapsedMs,
        tcpReceive: { chunks: receiveCount, bytes: receiveBytes, mibPerSecond: receiveBytes / 1048576 / (elapsedMs / 1000), minChunkBytes: receiveCount ? minChunk : null, meanChunkBytes: receiveCount ? receiveBytes / receiveCount : null, maxChunkBytes: maxChunk, maxReadableBytes: maxTcpReadable, socketBytesReadDelta: tcp.bytesRead - initialTcpRead },
        wsSend: { calls: sendCount, completed: sendCompleted, errors: sendErrors, pendingAtStop: inFlight, maxInFlight, maxBufferedBytes: maxQueue, bufferedBytesAtStop: ws.bufferedAmount, socketBytesWrittenDelta: localSocket.bytesWritten - initialLocalWritten, dispatchDelayMs: distribution(dispatchDurations), callbackDelayMs: distribution(sendDurations) },
        clientMessages: { count: clientMessages, bytes: clientBytes, remoteSocketBytesWrittenDelta: tcp.bytesWritten - initialTcpWritten },
        tcpPause: { count: pauseCount, totalMs: pauseMs, longestMs: longestPauseMs },
        eventLoop: { delayMs: loopDelay, utilization: utilization.utilization, activeMs: utilization.active, idleMs: utilization.idle },
        cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
        omittedRows: { tcp: receiveCount - rows.length, client: clientMessages - clientRows.length },
      },
      tcpColumns: ['receivedAtMs', 'bytes', 'wsSubmittedAtMs', 'wsCompletedAtMs', 'wsBufferedBytesAfterSend'],
      tcp: rows,
      clientColumns: ['receivedAtMs', 'bytes'],
      client: clientRows,
      pauseColumns: ['startedAtMs', 'durationMs'],
      pauses: pauseRows,
    });
  }

  globalThis[key] = { stop: () => finish('stopped') };
  tcp.prependListener('data', receive);
  tcp.on('pause', paused);
  tcp.on('resume', resumed);
  tcp.once('close', closed);
  ws.prependListener('message', clientMessage);
  ws.once('close', closed);
  ws.send = send;
  eventLoop.enable();
  timer = setTimeout(() => finish('duration'), durationMs);
  return report;
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(target => target.type === 'node');
if (!target) throw new Error('No Node inspector target found');
const inspector = new WebSocket(target.webSocketDebuggerUrl);
await once(inspector, 'open');
let sequence = 0;
const pending = new Map();
inspector.on('message', raw => {
  const message = JSON.parse(raw);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error) call.reject(new Error(message.error.message));
  else call.resolve(message.result);
});

function call(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timed out')); }, durationMs + 15_000);
    pending.set(id, { resolve, reject, timer });
    inspector.send(JSON.stringify({ id, method, params }));
  });
}

try {
  console.log(JSON.stringify({ status: 'sampling', durationMs }));
  const response = await call('Runtime.evaluate', {
    expression: `(${profileTransport.toString()})(${durationMs})`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? 'Main-process profiling failed');
  const report = response.result.value;
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'complete', outputFile, startedAtMs: report.startedAtMs, stoppedAtMs: report.stoppedAtMs, reason: report.reason, summary: report.summary }));
} finally {
  inspector.close();
  await once(inspector, 'close');
}
