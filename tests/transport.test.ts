import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { TransportManager } from '../src/main/transport';
import type { TransportEvent } from '../src/shared/types';

const servers: Server[] = [];
const sockets = new Set<Socket>();
const managers: TransportManager[] = [];
const clients: WebSocket[] = [];

async function tcpServer(handler: (socket: Socket) => void = (socket) => { socket.pipe(socket); }) {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { server, port: address.port };
}

function manager(events: TransportEvent[] = [], attachTimeoutMs = 1000) {
  const result = new TransportManager((event) => events.push(event), ['null'], { attachTimeoutMs, connectTimeoutMs: 1000 });
  managers.push(result);
  return result;
}

async function client(url: string, origin = 'null') {
  const socket = new WebSocket(url, { origin });
  clients.push(socket);
  await once(socket, 'open');
  return socket;
}

afterEach(async () => {
  for (const socket of clients.splice(0)) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await Promise.all(managers.splice(0).map((item) => item.dispose()));
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('TransportManager', () => {
  it('binds only loopback and forwards exact binary bytes in both directions', async () => {
    const { port } = await tcpServer();
    const info = await manager().open({ host: '127.0.0.1', port });
    expect(new URL(info.url).hostname).toBe('127.0.0.1');
    const ws = await client(info.url);
    const received = once(ws, 'message');
    const bytes = Buffer.from([0, 255, 13, 10, 123, 200]);
    ws.send(bytes);
    expect((await received)[0]).toEqual(bytes);
  });

  it('rejects wrong tokens and browser origins without consuming the valid session', async () => {
    const { port } = await tcpServer();
    const info = await manager().open({ host: '127.0.0.1', port });
    await expect(client(`${info.url}-wrong`)).rejects.toThrow('403');
    await expect(client(info.url, 'https://untrusted.example')).rejects.toThrow('403');
    const ws = await client(info.url);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await expect(client(info.url)).rejects.toThrow('403');
  });

  it('does not connect to the target before an authorized WebSocket attaches', async () => {
    let accepted = 0;
    const { port } = await tcpServer(() => { accepted++; });
    const bridge = manager();
    const info = await bridge.open({ host: '127.0.0.1', port });
    expect(accepted).toBe(0);
    await bridge.close(info.id);
    expect(accepted).toBe(0);
  });

  it('disposes a rejected upgrade even when its peer keeps the connection half open', async () => {
    const bridge = manager();
    const info = await bridge.open({ host: '127.0.0.1', port: 5900 });
    const address = new URL(info.url);
    const raw = createConnection({ host: '127.0.0.1', port: Number(address.port), allowHalfOpen: true });
    sockets.add(raw);
    raw.once('close', () => sockets.delete(raw));
    await once(raw, 'connect');
    const response = once(raw, 'data');
    raw.write('GET /wrong HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: null\r\n\r\n');
    expect((await response)[0].toString()).toContain('403');
    await bridge.dispose();
    raw.destroy();
  });

  it('expires an unclaimed bridge and closes its listening port', async () => {
    const events: TransportEvent[] = [];
    const { port } = await tcpServer();
    const info = await manager(events, 30).open({ host: '127.0.0.1', port });
    await expect.poll(() => events[0]?.type).toBe('error');
    await expect(client(info.url)).rejects.toThrow();
  });

  it('reports a refused TCP connection with a useful network error', async () => {
    const events: TransportEvent[] = [];
    const { server, port } = await tcpServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const info = await manager(events).open({ host: '127.0.0.1', port });
    await client(info.url);
    await expect.poll(() => events[0]?.error?.code).toBe('network');
    expect(events[0]?.error?.message).toContain('拒绝');
  });

  it('delivers the final TCP bytes before signaling a remote disconnect', async () => {
    const events: TransportEvent[] = [];
    const { port } = await tcpServer((socket) => socket.end(Buffer.from('authentication failed')));
    const info = await manager(events).open({ host: '127.0.0.1', port });
    const ws = await client(info.url);
    const received = once(ws, 'message');
    expect((await received)[0].toString()).toBe('authentication failed');
    await expect.poll(() => events[0]?.type).toBe('closed');
    expect(events).toHaveLength(1);
  });

  it('preserves a large stream across TCP chunking and a temporarily slow receiver', async () => {
    const { port } = await tcpServer((socket) => {
      socket.pause();
      setTimeout(() => { socket.pipe(socket); socket.resume(); }, 40);
    });
    const info = await manager().open({ host: '127.0.0.1', port });
    const ws = await client(info.url);
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa7);
    const received = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      let length = 0;
      ws.on('message', (data) => {
        const chunk = data as Buffer;
        chunks.push(chunk);
        length += chunk.length;
        if (length === bytes.length) resolve(Buffer.concat(chunks));
      });
    });
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) ws.send(bytes.subarray(offset, offset + 64 * 1024));
    // Compare bytes natively; deep assertion traversal of a 2 MiB Buffer can
    // consume the whole test timeout even when the transfer finished promptly.
    expect((await received).equals(bytes)).toBe(true);
  });

  it('closes stale sessions and supports repeated reconnects without remote-close noise', async () => {
    const events: TransportEvent[] = [];
    const { port } = await tcpServer();
    const bridge = manager(events);
    for (let index = 0; index < 12; index++) {
      const info = await bridge.open({ host: '127.0.0.1', port });
      const ws = await client(info.url);
      const closed = once(ws, 'close');
      await bridge.close(info.id);
      await closed;
    }
    expect(events).toEqual([]);
    await expect.poll(() => sockets.size).toBe(0);
  });

  it('cancels a queued open when disposed and can subsequently reconnect', async () => {
    const { port } = await tcpServer();
    const bridge = manager();
    const pending = bridge.open({ host: '127.0.0.1', port });
    const rejected = expect(pending).rejects.toThrow('取消');
    await bridge.dispose();
    await rejected;
    const info = await bridge.open({ host: '127.0.0.1', port });
    expect((await client(info.url)).readyState).toBe(WebSocket.OPEN);
  });

  it('validates addresses at the external boundary', () => {
    const bridge = manager();
    for (const host of ['', 'vnc://mac.local', 'mac.local:5900', 'mac\n.local', 'mac.local/path']) {
      expect(() => bridge.open({ host, port: 5900 })).toThrow('地址无效');
    }
    expect(() => bridge.open({ host: 'localhost', port: 65536 })).toThrow('地址无效');
  });
});
