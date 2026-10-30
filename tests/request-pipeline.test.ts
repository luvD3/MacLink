import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { MockRFB, request, pointer, extendedPointer, clientToElement } = vi.hoisted(() => {
  class Socket {
    data: number[] = [];
    offset = 0;
    writes: Uint8Array[] = [];
    sQpushBytes(bytes: Uint8Array): void { this.writes.push(bytes.slice()); }
    flush(): void { /* A message is recorded above, without a real socket. */ }
    push(...bytes: number[]): void { this.data.push(...bytes); }
    rQpeek8(): number { return this.data[this.offset]; }
    rQshift8(): number { return this.data[this.offset++]; }
    rQpeekBytes(length: number): Uint8Array {
      return Uint8Array.from(this.data.slice(this.offset, this.offset + length));
    }
    rQwait(_reason: string, length: number, goback = 0): boolean {
      if (this.data.length - this.offset >= length) return false;
      this.offset -= goback;
      return true;
    }
  }
  const request = vi.fn();
  const pointer = vi.fn();
  const extendedPointer = vi.fn();
  const clientToElement = vi.fn((x: number, y: number) => ({ x, y }));
  class MockRFB extends EventTarget {
    static messages = { fbUpdateRequest: request, pointerEvent: pointer, extendedPointerEvent: extendedPointer };
    static _convertButtonMask = vi.fn((buttons: number) =>
      (buttons & 1) | ((buttons & 2) << 1) | ((buttons & 4) >> 1) | ((buttons & 24) << 4));
    _sock = new Socket();
    _canvas = {} as HTMLCanvasElement;
    _screen = { clientWidth: 800, clientHeight: 600 };
    _FBU = { rects: 0, encoding: 16, x: 0, y: 0, width: 0, height: 0 };
    _display = { pending: vi.fn(() => false), absX: vi.fn((x: number) => x), absY: vi.fn((y: number) => y) };
    _rfbConnectionState = 'connected';
    _enabledContinuousUpdates = false;
    _pendingRemoteResize = false;
    _fbWidth = 3840;
    _fbHeight = 2160;
    _viewOnly = false;
    _extendedPointerEventSupported = false;
    _mouseButtonMask = 0;
    _mousePos = { x: 0, y: 0 };
    _mouseLastMoveTime = 0;
    _mouseMoveTimer: ReturnType<typeof setTimeout> | null = null;
    _accumulatedWheelDeltaX = 0;
    _accumulatedWheelDeltaY = 0;
    hoverMove = vi.fn();
    delayedMove = vi.fn();
    sendMouse = vi.fn();
    negotiate = vi.fn();
    dataStep = vi.fn(() => true);
    otherMessages: number[] = [];
    frameStep = vi.fn<(rfb: MockRFB) => boolean>();
    _normalMsg(): boolean {
      this.otherMessages.push(this._sock.rQshift8());
      return true;
    }
    _framebufferUpdate(): boolean { return this.frameStep(this); }
    _handleDataRect(): boolean { return this.dataStep(); }
    _negotiateProtocolVersion(): boolean | void {
      if (this._sock.rQwait('version', 12)) return false;
      this.negotiate(this._sock.rQpeekBytes(12));
      this._sock.offset += 12;
    }
    _resize(width: number, height: number): void { this._fbWidth = width; this._fbHeight = height; }
    _disconnect(): void { this._rfbConnectionState = 'disconnected'; }
    _sendMouse(x: number, y: number, mask: number): void { this.sendMouse(x, y, mask); }
    _handleMouseButton(x: number, y: number, mask: number): void {
      this._mouseButtonMask = mask;
      this._sendMouse(x, y, mask);
    }
    _handleMouseMove(x: number, y: number): void { this.hoverMove(x, y); }
    _handleDelayedMouseMove(): void { this.delayedMove(); }
  }
  return { MockRFB, request, pointer, extendedPointer, clientToElement };
});

vi.mock('@maclink/novnc-rfb', () => ({ default: MockRFB }));
vi.mock('@maclink/novnc-element', () => ({ clientToElement }));

import PipelinedRFB from '../src/renderer/vnc/pipelined-rfb';

type Base = InstanceType<typeof MockRFB>;
class TestRFB extends PipelinedRFB {
  constructor() { super({} as HTMLElement, 'ws://fixture'); }
  process(): boolean { return this._normalMsg(); }
  move(x: number, y: number): void { this._handleMouseMove(x, y); }
  wheel(event: WheelEvent): void { this._handleWheel(event); }
  handshake(): boolean | void { return this._negotiateProtocolVersion(); }
  resize(width: number, height: number): void { this._resize(width, height); }
  stop(): void { this._disconnect(); }
  pointer(x: number, y: number, mask = 0): void { this._sendMouse(x, y, mask); }
  dataRect(): boolean { return this._handleDataRect(); }
}

function enqueueFrame(base: Base, rectangles: number): void {
  base._sock.push(0, 0, rectangles >>> 8, rectangles & 255);
}

// The mock parser reports progress selected by each fixture. Rectangle payload
// decoding remains an upstream responsibility, outside this scheduler's tests.
function consumeHeader(base: Base): void {
  const header = base._sock.rQpeekBytes(3);
  base._sock.offset += 3;
  base._FBU.rects = header[1] << 8 | header[2];
}

function finishFrame(base: Base): boolean {
  if (base._FBU.rects === 0) consumeHeader(base);
  base._FBU.rects = 0;
  return true;
}

function setup(rectangles = 1) {
  const viewer = new TestRFB();
  const base = viewer as unknown as Base;
  const order: string[] = [];
  request.mockImplementation(() => { order.push('request'); });
  base.frameStep.mockImplementation((rfb) => {
    order.push('decode');
    return finishFrame(rfb);
  });
  enqueueFrame(base, rectangles);
  return { viewer, base, order };
}

beforeEach(() => {
  request.mockReset();
  pointer.mockReset();
  extendedPointer.mockReset();
  clientToElement.mockClear();
  MockRFB._convertButtonMask.mockClear();
});

describe('framebuffer request pipeline', () => {
  it('requests before decoding and does not request again at completion', () => {
    const { viewer, base, order } = setup();
    expect(viewer.process()).toBe(true);
    expect(order).toEqual(['request', 'decode']);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 3840, 2160);
  });

  it('waits for a complete header without consuming or rewinding it twice', () => {
    const { viewer, base } = setup();
    base._sock.data = [0, 0];
    base.frameStep.mockImplementation((rfb) => {
      if (rfb._sock.rQwait('header', 3, 1)) return false;
      return finishFrame(rfb);
    });
    expect(viewer.process()).toBe(false);
    expect(base._sock.offset).toBe(0);
    expect(request).not.toHaveBeenCalled();
    base._sock.push(0);
    expect(viewer.process()).toBe(false);
    expect(base._sock.offset).toBe(0);
    expect(request).not.toHaveBeenCalled();
    base._sock.push(1);
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(base._sock.offset).toBe(4);
  });

  it('keeps one request through fragmented payloads and multiple rectangles', () => {
    const { viewer, base } = setup(2);
    base.frameStep
      .mockImplementationOnce((rfb) => { consumeHeader(rfb); return false; })
      .mockImplementationOnce(() => false)
      .mockImplementationOnce((rfb) => { rfb._FBU.rects = 1; return false; })
      .mockImplementationOnce((rfb) => { rfb._FBU.rects = 0; return true; });
    expect(viewer.process()).toBe(false);
    expect(viewer.process()).toBe(false);
    expect(viewer.process()).toBe(false);
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(base.otherMessages).toEqual([]);
    enqueueFrame(base, 1);
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses the upstream completion result for a LastRect-terminated update', () => {
    const { viewer, base } = setup(65535);
    base.frameStep
      .mockImplementationOnce((rfb) => { consumeHeader(rfb); return false; })
      .mockImplementationOnce((rfb) => { rfb._FBU.rects = 0; return true; });
    expect(viewer.process()).toBe(false);
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    enqueueFrame(base, 1);
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('requests after an empty update', () => {
    const { viewer, order } = setup(0);
    expect(viewer.process()).toBe(true);
    expect(order).toEqual(['decode', 'request']);
  });

  it('preserves display backpressure and requests after a deferred frame completes', () => {
    const { viewer, base } = setup();
    base._display.pending.mockReturnValue(true);
    base.frameStep.mockImplementationOnce((rfb) => { consumeHeader(rfb); return false; });
    expect(viewer.process()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    base._display.pending.mockReturnValue(false);
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary scheduling while a remote resize is pending', () => {
    const { viewer, base, order } = setup();
    base._pendingRemoteResize = true;
    expect(viewer.process()).toBe(true);
    expect(order).toEqual(['decode', 'request']);
  });

  it('does not issue requests during continuous updates', () => {
    const { viewer, base } = setup();
    base._enabledContinuousUpdates = true;
    expect(viewer.process()).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['connecting', 'disconnecting', 'disconnected'])('does not request while %s', (state) => {
    const { viewer, base } = setup();
    base._rfbConnectionState = state;
    expect(viewer.process()).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not add a request if the connection ends during decoding', () => {
    const { viewer, base } = setup();
    base.frameStep.mockImplementationOnce((rfb) => { consumeHeader(rfb); return false; });
    expect(viewer.process()).toBe(false);
    base._rfbConnectionState = 'disconnected';
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('corrects changed bounds once and returns to ordinary scheduling', () => {
    const { viewer, base, order } = setup();
    base.frameStep.mockImplementationOnce((rfb) => {
      order.push('decode');
      rfb._fbWidth = 2560;
      rfb._fbHeight = 1440;
      return finishFrame(rfb);
    });
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, base._sock, true, 0, 0, 3840, 2160);
    expect(request).toHaveBeenNthCalledWith(2, base._sock, true, 0, 0, 2560, 1440);
    enqueueFrame(base, 1);
    expect(viewer.process()).toBe(true);
    expect(order).toEqual(['request', 'decode', 'request', 'decode', 'request']);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('handles consecutive updates and delegates other messages without consuming their type', () => {
    const { viewer, base } = setup();
    base._sock.push(2); // Bell, handled entirely by the upstream normal parser.
    enqueueFrame(base, 1);
    expect(viewer.process()).toBe(true);
    expect(viewer.process()).toBe(true);
    expect(viewer.process()).toBe(true);
    expect(base.otherMessages).toEqual([2]);
    expect(base.frameStep).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(base._sock.offset).toBe(base._sock.data.length);
  });
});

describe('drag mouse scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([0, 8, 16, 128])('delegates movement with mask %i to the upstream hover path', (mask) => {
    const { viewer, base } = setup();
    base._mouseButtonMask = mask;
    viewer.move(30, 40);
    expect(base.hoverMove).toHaveBeenCalledExactlyOnceWith(30, 40);
    expect(base.sendMouse).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2, 4])('uses an 8 ms interval while ordinary button mask %i is held', (mask) => {
    const { viewer, base } = setup();
    base._mouseButtonMask = mask;
    viewer.move(10, 20);
    expect(base.sendMouse).toHaveBeenCalledExactlyOnceWith(10, 20, mask);
    vi.advanceTimersByTime(2);
    viewer.move(20, 30);
    vi.advanceTimersByTime(5);
    expect(base.delayedMove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(base.delayedMove).toHaveBeenCalledTimes(1);
    expect(base.hoverMove).not.toHaveBeenCalled();
  });

  it('coalesces to the latest coordinates without extending the pending deadline', () => {
    const { viewer, base } = setup();
    base._mouseButtonMask = 1;
    base._mouseLastMoveTime = Date.now();
    const delivered: Array<{ x: number; y: number }> = [];
    base.delayedMove.mockImplementation(() => { delivered.push({ ...base._mousePos }); });
    viewer.move(10, 20);
    vi.advanceTimersByTime(3);
    viewer.move(30, 40);
    vi.advanceTimersByTime(3);
    viewer.move(50, 60);
    expect(vi.getTimerCount()).toBe(1);
    expect(base._mouseMoveTimer).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(delivered).toEqual([{ x: 50, y: 60 }]);
    expect(base.delayedMove).toHaveBeenCalledTimes(1);
    expect(base.sendMouse).not.toHaveBeenCalled();
  });
});

function appleSetup(width = 3840, height = 2160) {
  const fixture = setup();
  fixture.base._sock.data = [...new TextEncoder().encode('RFB 003.889\n')];
  fixture.viewer.handshake();
  fixture.viewer.resize(width, height);
  return fixture;
}

function resizeFrame(viewer: TestRFB, base: Base, width: number, height: number): void {
  enqueueFrame(base, 1);
  base.frameStep.mockImplementationOnce((rfb) => {
    consumeHeader(rfb);
    viewer.resize(width, height);
    rfb._FBU.rects = 0;
    return true;
  });
  expect(viewer.process()).toBe(true);
}

function pixelFrame(viewer: TestRFB, base: Base, width: number, height: number, encoding = 16): void {
  enqueueFrame(base, 1);
  base.frameStep.mockImplementationOnce((rfb) => {
    consumeHeader(rfb);
    Object.assign(rfb._FBU, { x: 0, y: 0, width, height, encoding });
    expect(viewer.dataRect()).toBe(true);
    rfb._FBU.rects = 0;
    return true;
  });
  expect(viewer.process()).toBe(true);
}

describe('Apple transmission scale', () => {
  it.each(['RFB 003.008\n', 'RFB 003.007\n'])('does not infer scaling support from server banner %j', (banner) => {
    const { viewer, base } = setup();
    base._sock.data = [...new TextEncoder().encode(banner)];
    viewer.handshake();
    expect(viewer.supportsTransmissionScale).toBe(false);
    expect(viewer.setTransmissionScale('half')).toBe(false);
    expect(base._sock.writes).toEqual([]);
    expect(base.negotiate).toHaveBeenCalledExactlyOnceWith(new TextEncoder().encode(banner));
  });

  it('records the complete Apple banner without consuming bytes before upstream negotiation', () => {
    const { viewer, base } = setup();
    base._sock.data = [...new TextEncoder().encode('RFB 003.')];
    expect(viewer.handshake()).toBe(false);
    expect(viewer.supportsTransmissionScale).toBe(false);
    expect(base._sock.offset).toBe(0);
    base._sock.push(...new TextEncoder().encode('889\n'));
    viewer.handshake();
    expect(viewer.supportsTransmissionScale).toBe(true);
    expect(base.negotiate).toHaveBeenCalledExactlyOnceWith(new TextEncoder().encode('RFB 003.889\n'));
    expect(base._sock.offset).toBe(12);
  });

  it('exposes only actual framebuffer dimensions and announces each upstream resize', () => {
    const { viewer } = appleSetup();
    const sizes: unknown[] = [];
    viewer.addEventListener('framebuffersize', (event) => { sizes.push(event.detail); });
    expect(viewer.setTransmissionScale('half')).toBe(true);
    expect(viewer.framebufferSize).toEqual({ width: 3840, height: 2160 });
    expect(sizes).toEqual([]);
    viewer.resize(1920, 1080);
    expect(viewer.framebufferSize).toEqual({ width: 1920, height: 1080 });
    expect(sizes).toEqual([{ width: 1920, height: 1080 }]);
  });

  it('sends the verified 10-byte scale factor and a request using the last confirmed bounds', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    viewer.setTransmissionScale('original');
    expect(base._sock.writes.map((bytes) => [...bytes])).toEqual([
      [8, 0, 0x3f, 0xe0, 0, 0, 0, 0, 0, 0],
      [8, 0, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0],
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(base._sock, true, 0, 0, 3840, 2160);
  });

  it('allows an explicit retry of an unconfirmed scale request', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    viewer.setTransmissionScale('half');
    expect(base._sock.writes).toHaveLength(2);
    expect(base._sock.writes[1]).toEqual(base._sock.writes[0]);
    expect(viewer.framebufferSize).toEqual({ width: 3840, height: 2160 });
  });

  it('queues changes until a fragmented update completes and sends only the latest preference', () => {
    const { viewer, base } = appleSetup();
    enqueueFrame(base, 2);
    base.frameStep.mockImplementationOnce((rfb) => { consumeHeader(rfb); return false; });
    expect(viewer.process()).toBe(false);
    viewer.setTransmissionScale('half');
    viewer.setTransmissionScale('original');
    expect(base._sock.writes).toHaveLength(0);
    request.mockClear();
    expect(viewer.process()).toBe(true);
    expect(base._sock.writes).toHaveLength(1);
    expect(new DataView(base._sock.writes[0].buffer).getFloat64(2, false)).toBe(1);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 3840, 2160);
  });

  it('also queues a scale change while only part of the FBU header has arrived', () => {
    const { viewer, base } = appleSetup();
    base._sock.push(0, 0);
    base.frameStep.mockImplementationOnce((rfb) => !rfb._sock.rQwait('header', 3, 1));
    expect(viewer.process()).toBe(false);
    viewer.setTransmissionScale('half');
    expect(base._sock.writes).toHaveLength(0);
    base._sock.push(0, 1);
    expect(viewer.process()).toBe(true);
    expect(base._sock.writes).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('requests a complete image at the new size and withholds incremental requests until it arrives', () => {
    const { viewer, base, order } = appleSetup();
    viewer.setTransmissionScale('half');
    request.mockClear();
    resizeFrame(viewer, base, 1920, 1080);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, false, 0, 0, 1920, 1080);
    request.mockClear();
    // Empty/cursor-only updates and old small data updates cannot release the
    // complete-refresh barrier or overwrite its non-incremental request.
    enqueueFrame(base, 0);
    viewer.process();
    enqueueFrame(base, 1);
    viewer.process();
    pixelFrame(viewer, base, 100, 100);
    expect(request).not.toHaveBeenCalled();
    pixelFrame(viewer, base, 1920, 1080);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 1920, 1080);
    order.length = 0;
    enqueueFrame(base, 1);
    viewer.process();
    expect(order).toEqual(['request', 'decode']);
  });

  it('does not count incomplete decodes, CopyRect, or out-of-bounds stale data as a full refresh', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    request.mockClear();
    pixelFrame(viewer, base, 1920, 1080, 1);
    pixelFrame(viewer, base, 3840, 2160);
    enqueueFrame(base, 1);
    base.frameStep.mockImplementationOnce((rfb) => {
      consumeHeader(rfb);
      Object.assign(rfb._FBU, { x: 0, y: 0, width: 1920, height: 1080, encoding: 16 });
      base.dataStep.mockReturnValueOnce(false);
      expect(viewer.dataRect()).toBe(false);
      return false;
    });
    expect(viewer.process()).toBe(false);
    expect(request).not.toHaveBeenCalled();
    base.frameStep.mockImplementationOnce((rfb) => {
      expect(viewer.dataRect()).toBe(true);
      rfb._FBU.rects = 0;
      return true;
    });
    expect(viewer.process()).toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 1920, 1080);
  });

  it('accepts a complete refresh split across data rectangles in the same update', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    request.mockClear();
    enqueueFrame(base, 2);
    base.frameStep.mockImplementationOnce((rfb) => {
      consumeHeader(rfb);
      Object.assign(rfb._FBU, { x: 0, y: 0, width: 960, height: 1080, encoding: 16 });
      viewer.dataRect();
      rfb._FBU.x = 960;
      viewer.dataRect();
      rfb._FBU.rects = 0;
      return true;
    });
    viewer.process();
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 1920, 1080);
  });

  it('does not mistake overlapping half-screen rectangles for complete coverage', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    request.mockClear();
    enqueueFrame(base, 2);
    base.frameStep.mockImplementationOnce((rfb) => {
      consumeHeader(rfb);
      Object.assign(rfb._FBU, { x: 0, y: 0, width: 960, height: 1080, encoding: 16 });
      viewer.dataRect();
      viewer.dataRect(); // The right half is still missing despite full-area sum.
      rfb._FBU.rects = 0;
      return true;
    });
    viewer.process();
    expect(request).not.toHaveBeenCalled();
    pixelFrame(viewer, base, 1920, 1080);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 1920, 1080);
  });

  it('retains refresh coverage across updates without counting the same half twice', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    request.mockClear();
    pixelFrame(viewer, base, 960, 1080);
    pixelFrame(viewer, base, 960, 1080);
    expect(request).not.toHaveBeenCalled();
    enqueueFrame(base, 1);
    base.frameStep.mockImplementationOnce((rfb) => {
      consumeHeader(rfb);
      Object.assign(rfb._FBU, { x: 960, y: 0, width: 960, height: 1080, encoding: 16 });
      viewer.dataRect();
      rfb._FBU.rects = 0;
      return true;
    });
    viewer.process();
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 1920, 1080);
  });

  it('restores the pipeline after a requested resize even when this FBU already sent an early request', () => {
    const { viewer, base, order } = appleSetup();
    enqueueFrame(base, 1);
    base.frameStep.mockImplementationOnce((rfb) => {
      consumeHeader(rfb);
      viewer.setTransmissionScale('half');
      return false;
    });
    viewer.process();
    viewer.process(); // Send queued scale at the complete old frame boundary.
    resizeFrame(viewer, base, 1920, 1080);
    pixelFrame(viewer, base, 1920, 1080);
    order.length = 0;
    enqueueFrame(base, 1);
    viewer.process();
    expect(order).toEqual(['request', 'decode']);
  });

  it('waits for an active full refresh before sending a new queued scale', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    viewer.setTransmissionScale('original');
    expect(base._sock.writes).toHaveLength(1);
    pixelFrame(viewer, base, 1920, 1080);
    expect(base._sock.writes).toHaveLength(2);
    resizeFrame(viewer, base, 3840, 2160);
    expect(request).toHaveBeenLastCalledWith(base._sock, false, 0, 0, 3840, 2160);
    request.mockClear();
    pixelFrame(viewer, base, 3840, 2160);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 3840, 2160);
  });

  it('clears queued scale work on disconnect', () => {
    const { viewer, base } = appleSetup();
    enqueueFrame(base, 1);
    base.frameStep.mockImplementationOnce((rfb) => { consumeHeader(rfb); return false; });
    viewer.process();
    viewer.setTransmissionScale('half');
    viewer.stop();
    request.mockClear();
    viewer.process();
    expect(viewer.setTransmissionScale('half')).toBe(false);
    expect(base._sock.writes).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('Apple scaled pointer coordinates', () => {
  it('delegates unchanged coordinates until the half-size response is received', () => {
    const { viewer, base } = appleSetup();
    viewer.pointer(100, 200, 1);
    viewer.setTransmissionScale('half');
    viewer.pointer(100, 200, 1);
    expect(base.sendMouse).toHaveBeenCalledTimes(2);
    expect(base.sendMouse).toHaveBeenLastCalledWith(100, 200, 1);
    expect(pointer).not.toHaveBeenCalled();
  });

  it('maps after fit scaling and viewport offsets, retaining ordinary button masks', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    base._display.absX.mockImplementation((x) => x / 0.5 + 100);
    base._display.absY.mockImplementation((y) => y / 0.5 + 50);
    viewer.pointer(50, 25, 4);
    expect(pointer).toHaveBeenCalledExactlyOnceWith(base._sock, 400, 200, 4);
    expect(base.sendMouse).not.toHaveBeenCalled();
  });

  it('uses each actual dimension ratio for odd dimensions and clamps source edges', () => {
    const { viewer, base } = appleSetup(3841, 2161);
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1921, 1080);
    viewer.pointer(1920, 1079);
    expect(pointer).toHaveBeenLastCalledWith(base._sock, Math.floor(1920 * 3841 / 1921), Math.floor(1079 * 2161 / 1080), 0);
    viewer.pointer(-50, 5000);
    expect(pointer).toHaveBeenLastCalledWith(base._sock, 0, 2160, 0);
    viewer.pointer(5000, -50);
    expect(pointer).toHaveBeenLastCalledWith(base._sock, 3840, 0, 0);
  });

  it('maps a late half-size response while original is pending, then restores upstream coordinates', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    viewer.setTransmissionScale('original');
    resizeFrame(viewer, base, 1920, 1080);
    viewer.pointer(100, 200, 1);
    expect(pointer).toHaveBeenCalledExactlyOnceWith(base._sock, 200, 400, 1);
    resizeFrame(viewer, base, 3840, 2160);
    viewer.pointer(100, 200, 1);
    expect(base.sendMouse).toHaveBeenCalledExactlyOnceWith(100, 200, 1);
    expect(request).toHaveBeenLastCalledWith(base._sock, false, 0, 0, 3840, 2160);
  });

  it('follows all actual responses after half -> original -> half are sent before the first acknowledgement', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    viewer.setTransmissionScale('original');
    viewer.setTransmissionScale('half');
    expect(base._sock.writes).toHaveLength(3);
    resizeFrame(viewer, base, 1920, 1080);
    viewer.pointer(100, 200, 1);
    expect(pointer).toHaveBeenLastCalledWith(base._sock, 200, 400, 1);
    resizeFrame(viewer, base, 3840, 2160);
    viewer.pointer(100, 200, 1);
    expect(base.sendMouse).toHaveBeenCalledExactlyOnceWith(100, 200, 1);
    resizeFrame(viewer, base, 1920, 1080);
    viewer.pointer(100, 200, 1);
    expect(pointer).toHaveBeenCalledTimes(2);
    expect(pointer).toHaveBeenLastCalledWith(base._sock, 200, 400, 1);
    expect(request).toHaveBeenLastCalledWith(base._sock, false, 0, 0, 1920, 1080);
    request.mockClear();
    pixelFrame(viewer, base, 1920, 1080);
    expect(request).toHaveBeenCalledExactlyOnceWith(base._sock, true, 0, 0, 1920, 1080);
  });

  it('does not infer coordinate scaling from an unsolicited half-sized desktop', () => {
    const { viewer, base } = appleSetup();
    viewer.resize(1920, 1080);
    viewer.pointer(100, 200);
    expect(base.sendMouse).toHaveBeenCalledExactlyOnceWith(100, 200, 0);
    expect(pointer).not.toHaveBeenCalled();
  });

  it('preserves extended pointer masks and the upstream illegal-mask rejection', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    base._extendedPointerEventSupported = true;
    viewer.pointer(10, 20, 0x100);
    expect(extendedPointer).toHaveBeenCalledExactlyOnceWith(base._sock, 20, 40, 0x100);
    expect(pointer).not.toHaveBeenCalled();
    expect(() => viewer.pointer(10, 20, 0x8000)).toThrow('Illegal mouse button mask');
  });

  it('suppresses scaled pointer events while view-only or disconnected', () => {
    const { viewer, base } = appleSetup();
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    base._viewOnly = true;
    viewer.pointer(10, 20);
    base._viewOnly = false;
    base._rfbConnectionState = 'disconnected';
    viewer.pointer(10, 20);
    expect(pointer).not.toHaveBeenCalled();
    expect(extendedPointer).not.toHaveBeenCalled();
  });
});

describe('wheel distance', () => {
  function event(deltaY: number, options: WheelEventInit = {}): WheelEvent {
    return {
      clientX: 125, clientY: 75, buttons: 0, deltaX: 0, deltaY, deltaMode: 0,
      ...options, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as WheelEvent;
  }

  function masks(base: Base): number[] {
    return base.sendMouse.mock.calls.map((call) => call[2]);
  }

  it('sends all six steps from a 300 pixel event and consumes the local scroll', () => {
    const { viewer, base } = setup();
    const input = event(300);
    viewer.wheel(input);
    expect(masks(base)).toEqual([16, 0, 16, 0, 16, 0, 16, 0, 16, 0, 16, 0]);
    expect(base.sendMouse.mock.calls.every(([x, y]) => x === 125 && y === 75)).toBe(true);
    expect(clientToElement).toHaveBeenCalledExactlyOnceWith(125, 75, base._canvas);
    expect(input.preventDefault).toHaveBeenCalledOnce();
    expect(input.stopPropagation).toHaveBeenCalledOnce();
    expect(base._accumulatedWheelDeltaY).toBe(0);
  });

  it('retains the remainder across five 120 pixel events for twelve steps', () => {
    const { viewer, base } = setup();
    viewer.wheel(event(120));
    expect(base._accumulatedWheelDeltaY).toBe(20);
    viewer.wheel(event(120));
    expect(base._accumulatedWheelDeltaY).toBe(40);
    for (let index = 0; index < 3; index++) viewer.wheel(event(120));
    expect(masks(base)).toEqual(Array.from({ length: 12 }, () => [16, 0]).flat());
    expect(base._accumulatedWheelDeltaY).toBe(0);
  });

  it('accumulates small touchpad events without creating extra steps', () => {
    const { viewer, base } = setup();
    for (let index = 0; index < 9; index++) viewer.wheel(event(5));
    expect(base.sendMouse).not.toHaveBeenCalled();
    viewer.wheel(event(5));
    expect(masks(base)).toEqual([16, 0]);
    expect(base._accumulatedWheelDeltaY).toBe(0);
  });

  it.each([
    { x: 150, y: -100, expected: [64, 0, 64, 0, 64, 0, 8, 0, 8, 0] },
    { x: -100, y: 150, expected: [32, 0, 32, 0, 16, 0, 16, 0, 16, 0] },
  ])('keeps horizontal and vertical directions distinct: $x, $y', ({ x, y, expected }) => {
    const { viewer, base } = setup();
    viewer.wheel(event(y, { deltaX: x }));
    expect(masks(base)).toEqual(expected);
    expect(base._accumulatedWheelDeltaX).toBe(0);
    expect(base._accumulatedWheelDeltaY).toBe(0);
  });

  it('preserves a signed remainder when the scroll direction reverses', () => {
    const { viewer, base } = setup();
    viewer.wheel(event(-120));
    expect(masks(base)).toEqual([8, 0, 8, 0]);
    expect(base._accumulatedWheelDeltaY).toBe(-20);
    viewer.wheel(event(10));
    expect(base.sendMouse).toHaveBeenCalledTimes(4);
    expect(base._accumulatedWheelDeltaY).toBe(-10);
    viewer.wheel(event(-40));
    expect(masks(base)).toEqual([8, 0, 8, 0, 8, 0]);
    expect(base._accumulatedWheelDeltaY).toBe(0);
  });

  it('converts line units with the existing nineteen pixel line height', () => {
    const { viewer, base } = setup();
    viewer.wheel(event(9, { deltaMode: 1 }));
    expect(masks(base)).toEqual([16, 0, 16, 0, 16, 0]);
    expect(base._accumulatedWheelDeltaY).toBe(21);
  });

  it('converts page units using each visible viewport dimension', () => {
    const { viewer, base } = setup();
    // The framebuffer is 4K, while the visible viewport is 800 x 600.
    viewer.wheel(event(1, { deltaX: 1, deltaMode: 2 }));
    expect(masks(base).filter((mask) => mask === 64)).toHaveLength(16);
    expect(masks(base).filter((mask) => mask === 16)).toHaveLength(12);
    expect(masks(base).filter((mask) => mask === 0)).toHaveLength(28);
    expect(base._accumulatedWheelDeltaX).toBe(0);
    expect(base._accumulatedWheelDeltaY).toBe(0);
  });

  it('keeps held mouse buttons in both the wheel press and release', () => {
    const { viewer, base } = setup();
    viewer.wheel(event(100, { buttons: 3 })); // DOM left + right becomes RFB mask 5.
    expect(MockRFB._convertButtonMask).toHaveBeenCalledExactlyOnceWith(3);
    expect(masks(base)).toEqual([21, 5, 21, 5]);
    expect(base._mouseButtonMask).toBe(5);
  });

  it('sends the Apple scroll wire vector with exact point distances and no invented gesture', () => {
    const { viewer, base } = appleSetup();
    const input = event(-25, { deltaX: 40, buttons: 2 });
    viewer.wheel(input);
    // Independent protocol vector: horizontal -40 points, vertical +25 points,
    // line deltas -4/+2, 16.16 deltas -4/+2.5, and native position (125, 75).
    const expected = Buffer.from([
      '170000360001000b',
      'fffc00020000',
      'fffc00000002800000000000',
      'ffffffd80000001900000000',
      '00000000000000000000000000000002',
      '007d004b',
    ].join(''), 'hex');
    expect(base._sock.writes.map(bytes => Buffer.from(bytes))).toEqual([expected]);
    expect(masks(base)).toEqual([4]); // Preserve the held right button, without wheel bits.
    expect(base._mouseButtonMask).toBe(4);
    expect(input.preventDefault).toHaveBeenCalledOnce();
    expect(input.stopPropagation).toHaveBeenCalledOnce();
  });

  it('preserves fast and coalesced Apple scroll distance without adding acceleration', () => {
    const { viewer, base } = appleSetup();
    for (let index = 0; index < 5; index++) viewer.wheel(event(120, { deltaX: -20 }));
    viewer.wheel(event(-600, { deltaX: 100 }));
    const points = base._sock.writes.map(bytes => {
      const data = new DataView(bytes.buffer);
      return [data.getInt32(26), data.getInt32(30)];
    });
    expect(points).toEqual([[20, -120], [20, -120], [20, -120], [20, -120], [20, -120], [-100, 600]]);
    expect(masks(base)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('retains fractional Apple point distances across small events and direction changes', () => {
    const { viewer, base } = appleSetup();
    for (let index = 0; index < 3; index++) viewer.wheel(event(.25, { deltaX: -.25 }));
    expect(base._sock.writes).toEqual([]);
    expect(base.sendMouse).not.toHaveBeenCalled();
    viewer.wheel(event(.25, { deltaX: -.25 }));
    viewer.wheel(event(-.75, { deltaX: .75 }));
    viewer.wheel(event(.25, { deltaX: -.25 }));
    expect(base._sock.writes).toHaveLength(1);
    viewer.wheel(event(-.5, { deltaX: .5 }));
    const points = base._sock.writes.map(bytes => {
      const data = new DataView(bytes.buffer);
      return [data.getInt32(26), data.getInt32(30)];
    });
    expect(points).toEqual([[1, -1], [-1, 1]]);
  });

  it('maps Apple scroll coordinates through the viewport and half transmission without changing distance', () => {
    const { viewer, base } = appleSetup();
    base._display.absX.mockImplementation(x => x * 3 + 17);
    base._display.absY.mockImplementation(y => y * 2 + 23);
    viewer.wheel(event(300));
    const original = base._sock.writes[0];
    viewer.setTransmissionScale('half');
    resizeFrame(viewer, base, 1920, 1080);
    // Local fit/viewport transforms now resolve to half the transmitted
    // coordinates. Both events must still hit the same original Mac position.
    base._display.absX.mockImplementation(x => (x * 3 + 17) / 2);
    base._display.absY.mockImplementation(y => (y * 2 + 23) / 2);
    viewer.wheel(event(300));
    expect(base._sock.writes.at(-1)).toEqual(original);
    const data = new DataView(original.buffer);
    expect([data.getInt32(26), data.getInt32(30)]).toEqual([0, -300]);
    expect([data.getUint16(54), data.getUint16(56)]).toEqual([392, 173]);
    expect(pointer).toHaveBeenCalledExactlyOnceWith(base._sock, 392, 173, 0);
  });

  it.each(['view-only', 'disconnected'])('drops Apple scroll events and fractions while %s', (state) => {
    const { viewer, base } = appleSetup();
    viewer.wheel(event(.75, { deltaX: -.75 }));
    base._viewOnly = state === 'view-only';
    base._rfbConnectionState = state === 'disconnected' ? 'disconnected' : 'connected';
    viewer.wheel(event(300, { deltaX: -100 }));
    base._viewOnly = false;
    base._rfbConnectionState = 'connected';
    viewer.wheel(event(.25, { deltaX: -.25 }));
    expect(base._sock.writes).toEqual([]);
    expect(base.sendMouse).not.toHaveBeenCalled();
    viewer.wheel(event(.75, { deltaX: -.75 }));
    expect(base._sock.writes).toHaveLength(1);
    const data = new DataView(base._sock.writes[0].buffer);
    expect([data.getInt32(26), data.getInt32(30)]).toEqual([1, -1]);
  });

  it('clears Apple point fractions on disconnect even without another wheel event', () => {
    const { viewer, base } = appleSetup();
    viewer.wheel(event(.75, { deltaX: -.75 }));
    viewer.stop();
    base._rfbConnectionState = 'connected';
    viewer.wheel(event(.25, { deltaX: -.25 }));
    expect(base._sock.writes).toEqual([]);
    expect(base.sendMouse).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 1, delta: 9, steps: 3 },
    { mode: 2, delta: 1, steps: 12 },
  ])('retains the discrete fallback for non-pixel Apple events with mode $mode', ({ mode, delta, steps }) => {
    const { viewer, base } = appleSetup();
    viewer.wheel(event(delta, { deltaMode: mode }));
    expect(base._sock.writes).toEqual([]);
    expect(masks(base)).toEqual(Array.from({ length: steps }, () => [16, 0]).flat());
  });

  it.each(['view-only', 'disconnected'])('drops events and residual movement while %s', (state) => {
    const { viewer, base } = setup();
    viewer.wheel(event(30, { deltaX: -20 }));
    base._viewOnly = state === 'view-only';
    base._rfbConnectionState = state === 'disconnected' ? 'disconnected' : 'connected';
    viewer.wheel(event(300, { deltaX: 100 }));
    expect(base.sendMouse).not.toHaveBeenCalled();
    expect(base._accumulatedWheelDeltaX).toBe(0);
    expect(base._accumulatedWheelDeltaY).toBe(0);
    base._viewOnly = false;
    base._rfbConnectionState = 'connected';
    viewer.wheel(event(20));
    expect(base.sendMouse).not.toHaveBeenCalled();
  });

  it('clears both accumulated axes when disconnecting', () => {
    const { viewer, base } = setup();
    viewer.wheel(event(40, { deltaX: -30 }));
    viewer.stop();
    expect(base._accumulatedWheelDeltaX).toBe(0);
    expect(base._accumulatedWheelDeltaY).toBe(0);
    expect(base.sendMouse).not.toHaveBeenCalled();
  });
});
