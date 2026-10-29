import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const port = Number(process.argv[2]);
const seconds = Number(process.argv[3] ?? 20);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('Profiler.enable');
const prototype = await cdp.send('Runtime.evaluate', { expression: 'WebSocket.prototype' });
const sockets = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
const measuring = cdp.send('Runtime.callFunctionOn', {
  objectId: sockets.objects.objectId,
  functionDeclaration: `function(seconds) {
    const sockets = this.filter(socket => socket.readyState === 1);
    return new Promise(resolve => {
      let bytes = 0, messages = 0, sentBytes = 0, sentMessages = 0;
      const receive = event => { bytes += event.data.byteLength ?? event.data.size ?? 0; messages++; };
      const sends = sockets.map(socket => socket.send);
      for (const socket of sockets) {
        socket.addEventListener('message', receive);
        const send = socket.send;
        socket.send = function(data) { sentBytes += data.byteLength ?? data.size ?? 0; sentMessages++; return send.call(this, data); };
      }
      setTimeout(() => {
        sockets.forEach((socket, i) => { socket.removeEventListener('message', receive); socket.send = sends[i]; });
        resolve({ bytes, messages, sentBytes, sentMessages, sockets: sockets.length });
      }, seconds * 1000);
    });
  }`,
  arguments: [{ value: seconds }], awaitPromise: true, returnByValue: true,
});
const before = await cdp.send('Performance.getMetrics');
await cdp.send('Profiler.start');
if (process.argv.includes('--move')) {
  const box = await page.locator('[data-testid="remote-screen"] canvas').boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(box.x + box.width / 2 + Math.sin(i / 4) * 100, box.y + box.height / 2 + Math.cos(i / 4) * 100);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const { result: { value: network } } = await measuring;
const { profile } = await cdp.send('Profiler.stop');
const after = await cdp.send('Performance.getMetrics');
const sum = {};
for (const node of profile.nodes) {
  if (node.hitCount) sum[node.callFrame.functionName || '(anonymous)'] = (sum[node.callFrame.functionName || '(anonymous)'] ?? 0) + node.hitCount;
}
const beforeValues = Object.fromEntries(before.metrics.map((metric) => [metric.name, metric.value]));
const deltas = Object.fromEntries(after.metrics.filter(({ name }) => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].includes(name)).map(({ name, value }) => [name, value - beforeValues[name]]));
const canvas = await page.locator('[data-testid="remote-screen"] canvas').evaluate((canvas) => ({ width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, cursor: getComputedStyle(canvas).cursor }));
const result = { seconds, receivedMiB: network.bytes / 1024 / 1024, networkMessages: network.messages, sentBytes: network.sentBytes, sentMessages: network.sentMessages, activeSockets: network.sockets, deltas, canvas, profileSamples: Object.entries(sum).sort((a, b) => b[1] - a[1]).slice(0, 15) };
await mkdir('test-results', { recursive: true });
await writeFile('test-results/live-performance.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await cdp.detach();
await browser.close();
