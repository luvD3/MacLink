declare module '@maclink/novnc-zstream' {
  export default class ZStream {
    input: Uint8Array | null;
    next_in: number;
    avail_in: number;
    output: Uint8Array;
    next_out: number;
    avail_out: number;
    msg: string;
  }
}

declare module '@maclink/novnc-rfb' {
  import RFB from '@novnc/novnc';
  interface ReceiveQueue {
    rQpeek8(): number;
    rQshift8(): number;
    rQpeekBytes(length: number, copy?: boolean): Uint8Array;
    rQwait(reason: string, length: number, goback?: number): boolean;
    sQpushBytes(bytes: Uint8Array): void;
    flush(): void;
  }
  export default class UpstreamRFB extends RFB {
    protected _sock: ReceiveQueue;
    protected _FBU: { rects: number; encoding: number | null; x: number; y: number; width: number; height: number };
    protected _display: { pending(): boolean; absX(x: number): number; absY(y: number): number };
    protected _rfbConnectionState: string;
    protected _enabledContinuousUpdates: boolean;
    protected _pendingRemoteResize: boolean;
    protected _fbWidth: number;
    protected _fbHeight: number;
    protected _viewOnly: boolean;
    protected _extendedPointerEventSupported: boolean;
    protected _mouseButtonMask: number;
    protected _mousePos: { x: number; y: number };
    protected _mouseLastMoveTime: number;
    protected _mouseMoveTimer: ReturnType<typeof setTimeout> | null;
    protected _canvas: HTMLCanvasElement;
    protected _screen: HTMLDivElement;
    protected _accumulatedWheelDeltaX: number;
    protected _accumulatedWheelDeltaY: number;
    protected _handleWheel(event: WheelEvent): void;
    protected _handleMouseButton(x: number, y: number, mask: number): void;
    protected _handleMouseMove(x: number, y: number): void;
    protected _handleDelayedMouseMove(): void;
    protected _sendMouse(x: number, y: number, mask: number): void;
    protected _negotiateProtocolVersion(): boolean | void;
    protected _resize(width: number, height: number): void;
    protected _disconnect(): void;
    protected _normalMsg(): boolean;
    protected _framebufferUpdate(): boolean;
    protected _handleDataRect(): boolean;
    static _convertButtonMask(buttons: number): number;
    static messages: {
      fbUpdateRequest(socket: ReceiveQueue, incremental: boolean, x: number, y: number, width: number, height: number): void;
      pointerEvent(socket: ReceiveQueue, x: number, y: number, mask: number): void;
      extendedPointerEvent(socket: ReceiveQueue, x: number, y: number, mask: number): void;
    };
  }
}

declare module '@maclink/novnc-element' {
  export function clientToElement(x: number, y: number, element: HTMLElement): { x: number; y: number };
}

declare module '@maclink/novnc-zlib' {
  import type ZStream from '@maclink/novnc-zstream';
  export function inflateInit(stream: ZStream): number;
  export function inflate(stream: ZStream, flush: number): number;
  export function inflateReset(stream: ZStream): number;
}

declare module '@maclink/novnc-zrle' {
  export default class ZRLEDecoder {
    protected _pixelBuffer: Uint8Array;
    protected _tileBuffer: Uint8Array;
    protected _inflator: {
      setInput(data: Uint8Array | null): void;
      inflate(expected: number): Uint8Array;
      reset(): void;
    };
    protected _readRLELength(): number;
    protected _readPixels(pixels: number): Uint8Array;
    protected _decodePaletteTile(paletteSize: number, tileSize: number, tileWidth: number, tileHeight: number): Uint8Array;
    protected _decodeRLETile(tileSize: number): Uint8Array;
    protected _decodeRLEPaletteTile(paletteSize: number, tileSize: number): Uint8Array;
    protected _getBitsPerPixelInPalette(size: number): number;
    decodeRect(x: number, y: number, width: number, height: number, socket: {
      rQwait(reason: string, length: number): boolean;
      rQshift32(): number;
      rQshiftBytes(length: number, copy?: boolean): Uint8Array;
    }, display: {
      fillRect(x: number, y: number, width: number, height: number, color: ArrayLike<number>, fromQueue?: boolean): void;
      blitImage(x: number, y: number, width: number, height: number, pixels: Uint8Array, offset: number, fromQueue?: boolean): void;
    }, depth: number): boolean;
  }
}
