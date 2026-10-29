import { randomUUID, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection, isIP, type Socket } from 'node:net';
import { domainToASCII } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { TransportEvent, TransportInfo, ViewerError } from '../shared/types';

interface Target { host: string; port: number }
interface TransportOptions { attachTimeoutMs?: number; connectTimeoutMs?: number }
interface Bridge {
  id: string;
  server: Server;
  webSockets: WebSocketServer;
  client?: WebSocket;
  tcp?: Socket;
  attachTimer?: NodeJS.Timeout;
  connectTimer?: NodeJS.Timeout;
  claimed: boolean;
  finished: boolean;
  shutdown?: Promise<void>;
}

const HIGH_WATER_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function parseTarget(target: Target): Target {
  if (!target || typeof target.host !== 'string' || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error('地址无效：请输入主机名或 IP，以及 1–65535 之间的端口。');
  }
  const host = target.host.trim().replace(/^\[([^\]]+)\]$/, '$1');
  const ascii = isIP(host) ? host : domainToASCII(host);
  if (!ascii || /[\s/\\@?#]/.test(host) || (!isIP(host) && !/^[a-zA-Z0-9_.-]+$/.test(ascii))) {
    throw new Error('地址无效：这里只填写主机名或 IP，不包含 vnc:// 或端口。');
  }
  return { host: ascii, port: target.port };
}

function networkError(error: NodeJS.ErrnoException): ViewerError {
  if (error.code === 'ENOTFOUND') return { code: 'invalid-address', message: '找不到这个主机，请检查 Mac 的地址。' };
  if (error.code === 'ECONNREFUSED') return { code: 'network', message: 'Mac 拒绝了连接，请检查屏幕共享和端口设置。' };
  if (error.code === 'ETIMEDOUT') return { code: 'network', message: '连接超时，请检查网络和 Mac 是否在线。' };
  return { code: 'network', message: `网络连接失败：${error.message}` };
}

function asBuffer(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/** One authenticated loopback bridge per session; the bridge never interprets RFB. */
export class TransportManager {
  private current?: Bridge;
  private generation = 0;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly onEvent: (event: TransportEvent) => void,
    private readonly allowedOrigins: readonly string[] = ['null'],
    private readonly options: TransportOptions = {},
  ) {}

  open(input: Target): Promise<TransportInfo> {
    const target = parseTarget(input);
    const generation = ++this.generation;
    return this.enqueue(async () => {
      if (this.current) await this.shutdown(this.current);
      if (generation !== this.generation) throw new Error('连接已取消。');

      const server = createServer((_request, response) => { response.writeHead(404, { Connection: 'close' }).end(); });
      const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER_BYTES, perMessageDeflate: false });
      const bridge: Bridge = { id: randomUUID(), server, webSockets, claimed: false, finished: false };
      const path = `/session/${randomBytes(32).toString('hex')}`;
      this.current = bridge;

      server.on('upgrade', (request, socket, head) => {
        if (bridge.finished || bridge.claimed || request.url !== path || !this.allowedOrigins.includes(request.headers.origin ?? '')) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy());
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
          bridge.claimed = true;
          clearTimeout(bridge.attachTimer);
          this.attach(bridge, client, target);
        });
      });

      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { void this.shutdown(bridge); reject(error); };
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
      });
      server.on('error', (error) => this.fail(bridge, networkError(error)));
      if (generation !== this.generation) {
        await this.shutdown(bridge);
        throw new Error('连接已取消。');
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('本机连接桥启动失败。');
      bridge.attachTimer = setTimeout(() => this.fail(bridge, { code: 'network', message: '连接窗口未能启动，请重试。' }), this.options.attachTimeoutMs ?? 10_000);
      return { id: bridge.id, url: `ws://127.0.0.1:${address.port}${path}` };
    });
  }

  close(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.current?.id === id) await this.shutdown(this.current);
    });
  }

  dispose(): Promise<void> {
    ++this.generation;
    return this.enqueue(async () => {
      if (this.current) await this.shutdown(this.current);
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(action);
    // One failed operation must not prevent the user from reconnecting.
    this.operations = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private attach(bridge: Bridge, client: WebSocket, target: Target): void {
    bridge.client = client;
    const tcp = createConnection(target);
    bridge.tcp = tcp;
    tcp.setNoDelay(true);
    bridge.connectTimer = setTimeout(() => this.fail(bridge, { code: 'network', message: '连接超时，请检查网络和 Mac 是否在线。' }), this.options.connectTimeoutMs ?? 10_000);
    tcp.once('connect', () => clearTimeout(bridge.connectTimer));
    tcp.on('error', (error) => this.fail(bridge, networkError(error)));
    // Queue the WebSocket close after any final RFB failure/disconnect message.
    tcp.once('close', () => { if (!bridge.finished) client.close(); });
    client.on('error', (error) => this.fail(bridge, networkError(error)));
    client.once('close', () => this.closed(bridge));

    let clientPaused = false;
    tcp.on('drain', () => {
      if (clientPaused && !bridge.finished) { clientPaused = false; client.resume(); }
    });
    client.on('message', (data, binary) => {
      if (bridge.finished) return;
      if (!binary) { this.fail(bridge, { code: 'network', message: '连接桥收到非二进制数据。' }); return; }
      const chunk = asBuffer(data);
      if (tcp.writableLength + chunk.length > MAX_BUFFER_BYTES) {
        this.fail(bridge, { code: 'network', message: '远端接收过慢，连接已停止以避免积压。' });
        return;
      }
      if (!tcp.write(chunk)) { clientPaused = true; client.pause(); }
    });
    tcp.on('data', (chunk: Buffer) => {
      if (bridge.finished) return;
      client.send(chunk, { binary: true }, (error) => {
        if (error) { this.fail(bridge, networkError(error)); return; }
        if (!bridge.finished && client.bufferedAmount < HIGH_WATER_BYTES) tcp.resume();
      });
      if (client.bufferedAmount >= HIGH_WATER_BYTES) tcp.pause();
    });
  }

  private fail(bridge: Bridge, error: ViewerError): void {
    if (bridge.finished) return;
    void this.shutdown(bridge);
    this.onEvent({ id: bridge.id, type: 'error', error });
  }

  private closed(bridge: Bridge): void {
    if (bridge.finished) return;
    void this.shutdown(bridge);
    this.onEvent({ id: bridge.id, type: 'closed' });
  }

  private shutdown(bridge: Bridge): Promise<void> {
    if (bridge.shutdown) return bridge.shutdown;
    bridge.finished = true;
    clearTimeout(bridge.attachTimer);
    clearTimeout(bridge.connectTimer);
    bridge.tcp?.destroy();
    bridge.client?.terminate();
    bridge.shutdown = Promise.all([
      new Promise<void>((resolve) => bridge.webSockets.close(() => resolve())),
      new Promise<void>((resolve) => {
        bridge.server.close(() => resolve());
        bridge.server.closeAllConnections();
      }),
    ]).then(() => { if (this.current === bridge) this.current = undefined; });
    return bridge.shutdown;
  }
}
