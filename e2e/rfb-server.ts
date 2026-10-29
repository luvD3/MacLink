import { createServer, type Socket } from 'node:net';
import { createCipheriv } from 'node:crypto';
import type { CompressedZrleRectangle } from '../tests/fixtures/zrle';

export interface FakeVncOptions {
  width?: number;
  height?: number;
  password?: string;
  rejectAuthentication?: boolean;
  stall?: boolean;
  zrleFrames?: CompressedZrleRectangle[];
  frameHeaderDelayMs?: number;
  appleScaling?: boolean;
  clipboardText?: string | null;
}

export type FakeCursorShape = 'ibeam' | 'arrow';

function writeClipboard(socket: Socket, text: string): void {
  // This fixture uses legacy ServerCutText, whose encoding is Latin-1.
  const data = Buffer.from(text, 'latin1');
  const header = Buffer.alloc(8);
  header[0] = 3;
  header.writeUInt32BE(data.length, 4);
  socket.write(Buffer.concat([header, data]));
}

function cursorUpdate(shape: FakeCursorShape): Buffer {
  const width = shape === 'ibeam' ? 9 : 17;
  const height = shape === 'ibeam' ? 18 : 23;
  const header = Buffer.alloc(16);
  header.writeUInt16BE(1, 2); // One rectangle in a FramebufferUpdate.
  header.writeUInt16BE(4, 4); // Cursor hotspot, not framebuffer coordinates.
  header.writeUInt16BE(shape === 'ibeam' ? 9 : 4, 6);
  header.writeUInt16BE(width, 8);
  header.writeUInt16BE(height, 10);
  header.writeInt32BE(-239, 12); // Cursor pseudo-encoding.
  const pixels = Buffer.alloc(width * height * 4);
  const rowBytes = Math.ceil(width / 8);
  const mask = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const visible = shape === 'ibeam'
        ? (x === 4 && y > 0 && y < height - 1) || ((y === 1 || y === height - 2) && x >= 1 && x <= 7)
        : (y >= 3 && y <= 17 && x >= 3 && x <= 3 + Math.floor((y - 3) * 0.65)) || (y >= 13 && y <= 21 && x >= 6 && x <= 8);
      if (!visible) continue;
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 245;
      mask[y * rowBytes + Math.floor(x / 8)] |= 0x80 >> (x % 8);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** A small RFB 3.8 peer used to test the real noVNC + TCP bridge end to end. */
export async function startVncServer(options: FakeVncOptions = {}) {
  const nativeWidth = options.width ?? 1920;
  const nativeHeight = options.height ?? 1080;
  const keys: { down: boolean; key: number }[] = [];
  const pointers: { buttons: number; x: number; y: number }[] = [];
  const clipboard: string[] = [];
  const scales: number[] = [];
  const versions: string[] = [];
  const sockets = new Set<Socket>();
  const readySockets = new Set<Socket>();
  let authenticated = 0;
  let framebufferRequests = 0;
  let requestsWhileFrameSending = 0;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); readySockets.delete(socket); });
    socket.on('error', () => { /* The viewer deliberately closes sockets in cancellation tests. */ });
    if (options.stall) return;

    let pending = Buffer.alloc(0);
    let stage: 'version' | 'security' | 'password' | 'init' | 'messages' = 'version';
    let sentFrame = false;
    let width = nativeWidth;
    let height = nativeHeight;
    let frameIndex = 0;
    let sendingFrame = false;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    const queuedFrames: Buffer[] = [];
    socket.once('close', () => clearTimeout(frameTimer));
    const drainFrames = () => {
      if (sendingFrame || socket.destroyed || !queuedFrames.length) return;
      const frame = queuedFrames.shift()!;
      if (!options.frameHeaderDelayMs || frame.length <= 16) {
        socket.write(frame);
        drainFrames();
        return;
      }
      sendingFrame = true;
      socket.write(frame.subarray(0, 16));
      frameTimer = setTimeout(() => {
        socket.write(frame.subarray(16));
        sendingFrame = false;
        drainFrames();
      }, options.frameHeaderDelayMs);
    };
    const queueFrame = (frame: Buffer) => { queuedFrames.push(frame); drainFrames(); };
    const challenge = Buffer.from('0123456789abcdef');
    socket.write(options.appleScaling ? 'RFB 003.889\n' : 'RFB 003.008\n');

    const take = (length: number): Buffer | undefined => {
      if (pending.length < length) return undefined;
      const result = pending.subarray(0, length);
      pending = pending.subarray(length);
      return result;
    };
    const failAuth = () => {
      const reason = Buffer.from('Authentication failed');
      const header = Buffer.alloc(8);
      header.writeUInt32BE(1);
      header.writeUInt32BE(reason.length, 4);
      socket.end(Buffer.concat([header, reason]));
    };
    const sendFrame = () => {
      if (options.zrleFrames) {
        const frame = options.zrleFrames[frameIndex++];
        if (!frame) return;
        const header = Buffer.alloc(16);
        header.writeUInt16BE(1, 2);
        header.writeUInt16BE(frame.x, 4);
        header.writeUInt16BE(frame.y, 6);
        header.writeUInt16BE(frame.width, 8);
        header.writeUInt16BE(frame.height, 10);
        header.writeInt32BE(16, 12);
        queueFrame(Buffer.concat([header, frame.wire]));
        return;
      }
      const header = Buffer.alloc(16);
      header.writeUInt16BE(1, 2);
      header.writeUInt16BE(width, 8);
      header.writeUInt16BE(height, 10);
      const pixels = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          // 32bpp little-endian RGBX, matching the client's requested pixel format.
          pixels[offset] = 90;
          pixels[offset + 1] = 110 + Math.floor(y / height * 70);
          pixels[offset + 2] = 20 + Math.floor(x / width * 50);
        }
      }
      queueFrame(Buffer.concat([header, pixels]));
      if (options.clipboardText !== null) {
        // Keep clipboard messages outside any deliberately fragmented frame.
        const text = Buffer.from(options.clipboardText ?? 'Hello from the test Mac', 'latin1');
        const clipboardHeader = Buffer.alloc(8);
        clipboardHeader[0] = 3;
        clipboardHeader.writeUInt32BE(text.length, 4);
        queueFrame(Buffer.concat([clipboardHeader, text]));
      }
    };

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (stage === 'version') {
          const version = take(12);
          if (!version) return;
          versions.push(version.toString('ascii'));
          socket.write(Buffer.from([1, options.password ? 2 : 1]));
          stage = 'security';
        } else if (stage === 'security') {
          if (!take(1)) return;
          if (options.password) {
            socket.write(challenge);
            stage = 'password';
          } else {
            socket.write(Buffer.alloc(4));
            stage = 'init';
          }
        } else if (stage === 'password') {
          const response = take(16);
          if (!response) return;
          const key = Buffer.alloc(8);
          Buffer.from(options.password!, 'latin1').copy(key, 0, 0, 8);
          for (let i = 0; i < key.length; i++) {
            let reversed = 0;
            for (let b = 0; b < 8; b++) reversed |= ((key[i] >> b) & 1) << (7 - b);
            key[i] = reversed;
          }
          // EDE with the same key three times is DES; supported by modern OpenSSL.
          const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
          cipher.setAutoPadding(false);
          const expected = Buffer.concat([cipher.update(challenge), cipher.final()]);
          if (!response.equals(expected) || options.rejectAuthentication) {
            failAuth();
            return;
          }
          socket.write(Buffer.alloc(4));
          stage = 'init';
        } else if (stage === 'init') {
          if (!take(1)) return;
          authenticated++;
          const name = Buffer.from('Test Mac · RFB fixture');
          const init = Buffer.alloc(24);
          init.writeUInt16BE(width);
          init.writeUInt16BE(height, 2);
          init[4] = 32;
          init[5] = 24;
          init[7] = 1;
          init.writeUInt16BE(255, 8);
          init.writeUInt16BE(255, 10);
          init.writeUInt16BE(255, 12);
          init[14] = 16;
          init[15] = 8;
          init.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([init, name]));
          stage = 'messages';
          readySockets.add(socket);
        } else {
          const type = pending[0];
          let length: number;
          if (type === 0) length = 20;
          else if (type === 2) {
            if (pending.length < 4) return;
            length = 4 + pending.readUInt16BE(2) * 4;
          } else if (type === 3) length = 10;
          else if (type === 4) length = 8;
          else if (type === 5) length = 6;
          else if (type === 6) {
            if (pending.length < 8) return;
            length = 8 + pending.readUInt32BE(4);
          } else if (type === 8 && options.appleScaling) length = 10;
          else if (type === 150) length = 10;
          else throw new Error(`Unexpected client RFB message: ${type}`);
          const message = take(length);
          if (!message) return;
          if (type === 3) {
            framebufferRequests++;
            if (sendingFrame) requestsWhileFrameSending++;
            if (options.zrleFrames || !sentFrame) { sentFrame = true; sendFrame(); }
          }
          if (type === 4) keys.push({ down: message[1] === 1, key: message.readUInt32BE(4) });
          if (type === 5) pointers.push({ buttons: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
          if (type === 6) clipboard.push(message.subarray(8).toString('latin1'));
          if (type === 8) {
            if (message[1] !== 0) throw new Error('Apple scaling padding must be zero');
            const scale = message.readDoubleBE(2);
            if (scale !== 0.5 && scale !== 1) throw new Error(`Unexpected Apple scale: ${scale}`);
            scales.push(scale);
            width = nativeWidth * scale;
            height = nativeHeight * scale;
            const desktopSize = Buffer.alloc(16);
            desktopSize.writeUInt16BE(1, 2);
            desktopSize.writeUInt16BE(width, 8);
            desktopSize.writeUInt16BE(height, 10);
            desktopSize.writeInt32BE(-223, 12);
            // A resize is a complete FBU, after the old frame and before new pixels.
            queueFrame(desktopSize);
            sentFrame = true;
            sendFrame();
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port, keys, pointers, clipboard, scales, versions, nativeWidth, nativeHeight,
    get authenticated() { return authenticated; },
    get connections() { return sockets.size; },
    get framebufferRequests() { return framebufferRequests; },
    get requestsWhileFrameSending() { return requestsWhileFrameSending; },
    sendClipboard(text: string) { for (const socket of readySockets) writeClipboard(socket, text); },
    sendCursor(shape: FakeCursorShape) {
      const update = cursorUpdate(shape);
      for (const socket of readySockets) socket.write(update);
    },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
