import UpstreamRFB from '@maclink/novnc-rfb';
import { clientToElement } from '@maclink/novnc-element';
import type { TransmissionScale } from '../../shared/types';

const DRAG_MOVE_DELAY = 8;
const WHEEL_STEP = 50;
const WHEEL_LINE_HEIGHT = 19;
type FramebufferSize = Readonly<{ width: number; height: number }>;
type Bounds = { left: number; top: number; right: number; bottom: number };

// AppleScroll wire layout adapted from Screon (MIT), revision 08e60a7c.
// See third-party/Screon/LICENSE and docs/DECODER.md for provenance.
function appleScroll(deltaX: number, deltaY: number, x: number, y: number): Uint8Array {
  const bytes = new Uint8Array(58);
  const data = new DataView(bytes.buffer);
  bytes[0] = 0x17;
  data.setUint16(2, 54);
  data.setUint16(4, 1);
  data.setUint16(6, 11);
  for (const [axis, delta] of [deltaX, deltaY].entries()) {
    // Apple's parallel line fields use ten points per line. The point delta
    // itself is unchanged; this is a unit conversion, not a speed multiplier.
    data.setInt16(8 + axis * 2, Math.max(-32768, Math.min(32767, Math.trunc(delta / 10))));
    data.setInt32(14 + axis * 4, Math.max(-2147483648, Math.min(2147483647, Math.trunc(delta * 65536 / 10))));
    data.setInt32(26 + axis * 4, delta);
  }
  // Continuous point scrolling. DOM events do not expose Apple's phase or
  // momentum fields: leave them zero instead of inventing gestures/inertia.
  data.setUint32(50, 2);
  data.setUint16(54, x);
  data.setUint16(56, y);
  return bytes;
}

// Used only while replacing a resized framebuffer. Subtracting covered bounds
// prevents overlapping rectangles from being counted twice as a complete image.
function subtractCoveredBounds(uncovered: Bounds[], covered: Bounds): Bounds[] {
  return uncovered.flatMap((area) => {
    const left = Math.max(area.left, covered.left);
    const top = Math.max(area.top, covered.top);
    const right = Math.min(area.right, covered.right);
    const bottom = Math.min(area.bottom, covered.bottom);
    if (left >= right || top >= bottom) return [area];
    const remaining: Bounds[] = [];
    if (area.top < top) remaining.push({ ...area, bottom: top });
    if (bottom < area.bottom) remaining.push({ ...area, top: bottom });
    if (area.left < left) remaining.push({ left: area.left, top, right: left, bottom });
    if (right < area.right) remaining.push({ left: right, top, right: area.right, bottom });
    return remaining;
  });
}

/** Keep noVNC's parsers while adapting update scheduling, Apple scaling and input. */
export default class PipelinedRFB extends UpstreamRFB {
  private pipelineEnabled = true;
  private earlyRequest: { width: number; height: number } | undefined;
  private readingFramebufferUpdate = false;
  private appleServer = false;
  private scrollRemainderX = 0;
  private scrollRemainderY = 0;
  private originalFramebufferSize: FramebufferSize | undefined;
  private queuedScale: TransmissionScale | undefined;
  private awaitingScale: TransmissionScale | undefined;
  private transmissionScaleRequested = false;
  private halfSizeCoordinates = false;
  private scaleResizeInFrame = false;
  private fullRefreshInFlight = false;
  private refreshUncovered: Bounds[] = [];

  override get supportsTransmissionScale(): boolean { return this.appleServer; }

  override get framebufferSize(): FramebufferSize {
    return { width: this._fbWidth, height: this._fbHeight };
  }

  override setTransmissionScale(scale: TransmissionScale): boolean {
    if (!this.appleServer || this._rfbConnectionState !== 'connected') return false;
    // The session deduplicates unchanged preferences. An explicit call here
    // must also work as a retry, or as cancellation of a pending half request.
    this.queuedScale = scale;
    if (!this.readingFramebufferUpdate) this.sendQueuedScale();
    return true;
  }

  protected override _negotiateProtocolVersion(): boolean | void {
    if (!this._sock.rQwait('version', 12)) {
      this.appleServer = String.fromCharCode(...this._sock.rQpeekBytes(12)) === 'RFB 003.889\n';
    }
    // Keep upstream's 3.8 negotiation; do not enter Apple's extended handshake.
    return super._negotiateProtocolVersion();
  }

  protected override _resize(width: number, height: number): void {
    super._resize(width, height);
    this.originalFramebufferSize ??= this.framebufferSize;
    const actualScale = this.matchesScaleSize('half', width, height) ? 'half' :
      this.matchesScaleSize('original', width, height) ? 'original' : undefined;
    if (this.transmissionScaleRequested && actualScale) {
      // Replies to half -> original -> half may all be in flight. Once Apple
      // scaling is requested, coordinates follow actual known dimensions,
      // independently of which earlier reply matched the latest preference.
      this.halfSizeCoordinates = actualScale === 'half';
      if (actualScale === this.awaitingScale) this.awaitingScale = undefined;
      this.scaleResizeInFrame = true;
      this.pipelineEnabled = true;
    } else if (!this.matchesScaleSize('half', width, height)) {
      this.halfSizeCoordinates = false;
    }
    this.dispatchEvent(new CustomEvent('framebuffersize', { detail: this.framebufferSize }));
  }

  protected override _disconnect(): void {
    this._accumulatedWheelDeltaX = this._accumulatedWheelDeltaY = 0;
    this.scrollRemainderX = this.scrollRemainderY = 0;
    this.queuedScale = this.awaitingScale = undefined;
    this.transmissionScaleRequested = false;
    this.earlyRequest = undefined;
    this.readingFramebufferUpdate = false;
    this.halfSizeCoordinates = false;
    this.scaleResizeInFrame = this.fullRefreshInFlight = false;
    this.refreshUncovered = [];
    super._disconnect();
  }

  private matchesScaleSize(scale: TransmissionScale, width: number, height: number): boolean {
    const original = this.originalFramebufferSize!;
    if (scale === 'original') return width === original.width && height === original.height;
    return (width === Math.floor(original.width / 2) || width === Math.ceil(original.width / 2)) &&
      (height === Math.floor(original.height / 2) || height === Math.ceil(original.height / 2));
  }

  private sendQueuedScale(): boolean {
    if (!this.queuedScale || this.fullRefreshInFlight ||
        this._rfbConnectionState !== 'connected') return false;
    const scale = this.queuedScale;
    this.queuedScale = undefined;
    this.awaitingScale = scale;
    this.transmissionScaleRequested = true;
    const message = new Uint8Array(10);
    message[0] = 8;
    new DataView(message.buffer).setFloat64(2, scale === 'half' ? 0.5 : 1, false);
    this._sock.sQpushBytes(message);
    this._sock.flush();
    // A static desktop still needs a request to deliver DesktopSize. This one
    // uses the last confirmed bounds; subsequent requests use _resize's bounds.
    UpstreamRFB.messages.fbUpdateRequest(this._sock, true, 0, 0, this._fbWidth, this._fbHeight);
    return true;
  }

  protected override _sendMouse(x: number, y: number, mask: number): void {
    if (!this.halfSizeCoordinates) {
      super._sendMouse(x, y, mask);
      return;
    }
    if (this._rfbConnectionState !== 'connected' || this._viewOnly) return;
    if (mask & 0x8000) throw new Error('Illegal mouse button mask (mask: ' + mask + ')');
    const { x: remoteX, y: remoteY } = this.remotePointerPosition(x, y);
    if (this._extendedPointerEventSupported && (mask & 0x7f80)) {
      UpstreamRFB.messages.extendedPointerEvent(this._sock, remoteX, remoteY, mask);
    } else {
      UpstreamRFB.messages.pointerEvent(this._sock, remoteX, remoteY, mask);
    }
  }

  private remotePointerPosition(x: number, y: number): { x: number; y: number } {
    const size = this.halfSizeCoordinates ? this.originalFramebufferSize! : this.framebufferSize;
    // absX/Y already account for local fit scaling and the scrolled viewport.
    return {
      x: Math.max(0, Math.min(size.width - 1, Math.floor(this._display.absX(x) * size.width / this._fbWidth))),
      y: Math.max(0, Math.min(size.height - 1, Math.floor(this._display.absY(y) * size.height / this._fbHeight))),
    };
  }

  protected override _handleMouseMove(x: number, y: number): void {
    if (!(this._mouseButtonMask & 7)) {
      super._handleMouseMove(x, y);
      return;
    }
    this._mousePos = { x, y };
    if (this._mouseMoveTimer == null) {
      const elapsed = Date.now() - this._mouseLastMoveTime;
      if (elapsed > DRAG_MOVE_DELAY) {
        this._sendMouse(x, y, this._mouseButtonMask);
        this._mouseLastMoveTime = Date.now();
      } else {
        // Reuse upstream's timer so button events flush it and disconnect
        // clears it. Its delayed handler sends the latest coordinates.
        this._mouseMoveTimer = setTimeout(() => this._handleDelayedMouseMove(), DRAG_MOVE_DELAY - elapsed);
      }
    }
  }

  protected override _handleWheel(event: WheelEvent): void {
    if (this._rfbConnectionState !== 'connected' || this._viewOnly) {
      this._accumulatedWheelDeltaX = this._accumulatedWheelDeltaY = 0;
      this.scrollRemainderX = this.scrollRemainderY = 0;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = clientToElement(event.clientX, event.clientY, this._canvas);
    const buttons = UpstreamRFB._convertButtonMask(event.buttons);
    const mode = event.deltaMode;
    if (this.appleServer && mode === 0) {
      // Chromium supplies Windows wheel/precision-touchpad movement in CSS
      // pixels. Forward that distance as Mac points, without gain or timing
      // rules. Apple and DOM use opposite signs for both scroll axes.
      this.scrollRemainderX -= event.deltaX;
      this.scrollRemainderY -= event.deltaY;
      const deltaX = Math.trunc(this.scrollRemainderX), deltaY = Math.trunc(this.scrollRemainderY);
      this.scrollRemainderX -= deltaX;
      this.scrollRemainderY -= deltaY;
      if (deltaX === 0 && deltaY === 0) return;
      // Flush a pending move and preserve held buttons, without wheel bits.
      this._handleMouseButton(position.x, position.y, buttons);
      const remote = this.remotePointerPosition(position.x, position.y);
      this._sock.sQpushBytes(appleScroll(deltaX, deltaY, remote.x, remote.y));
      this._sock.flush();
      return;
    }
    const unitX = mode === 2 ? this._screen.clientWidth : mode === 1 ? WHEEL_LINE_HEIGHT : 1;
    const unitY = mode === 2 ? this._screen.clientHeight : mode === 1 ? WHEEL_LINE_HEIGHT : 1;

    // A coalesced DOM event may contain several wheel steps. Consume all of
    // them and retain sub-step motion instead of dropping it after one click.
    const sendSteps = (delta: number, negativeMask: number, positiveMask: number): number => {
      const steps = Math.trunc(delta / WHEEL_STEP);
      const wheelMask = steps < 0 ? negativeMask : positiveMask;
      for (let step = 0; step < Math.abs(steps); step++) {
        this._handleMouseButton(position.x, position.y, buttons | wheelMask);
        this._handleMouseButton(position.x, position.y, buttons);
      }
      return delta - steps * WHEEL_STEP;
    };
    this._accumulatedWheelDeltaX = sendSteps(this._accumulatedWheelDeltaX + event.deltaX * unitX, 32, 64);
    this._accumulatedWheelDeltaY = sendSteps(this._accumulatedWheelDeltaY + event.deltaY * unitY, 8, 16);
  }

  protected override _normalMsg(): boolean {
    const socket = this._sock;
    if (this._FBU.rects === 0 && socket.rQpeek8() !== 0) {
      return super._normalMsg();
    }
    if (this._FBU.rects === 0) socket.rQshift8();

    const complete = this._framebufferUpdate();
    if (complete) {
      this.readingFramebufferUpdate = false;
      const requested = this.earlyRequest;
      this.earlyRequest = undefined;
      const resized = requested !== undefined &&
        (requested.width !== this._fbWidth || requested.height !== this._fbHeight);
      const scaleResized = this.scaleResizeInFrame;
      this.scaleResizeInFrame = false;
      // Unexpected resizes retain upstream scheduling. Expected transmission
      // resizes keep the pipeline after their complete replacement image.
      if (resized && !scaleResized) this.pipelineEnabled = false;
      if (this.fullRefreshInFlight && this.refreshUncovered.length === 0) {
        this.fullRefreshInFlight = false;
      }
      if (this._rfbConnectionState !== 'connected') return complete;
      const sentScale = this.sendQueuedScale();
      if (sentScale) return complete;
      if (scaleResized && !this.awaitingScale) {
        // macOS can resize without invalidating all its pixels. Keep all
        // incremental requests paused until this replacement image completes;
        // an early true request can otherwise supersede the false request.
        this.fullRefreshInFlight = true;
        this.refreshUncovered = [{ left: 0, top: 0, right: this._fbWidth, bottom: this._fbHeight }];
        UpstreamRFB.messages.fbUpdateRequest(socket, false, 0, 0, this._fbWidth, this._fbHeight);
      } else if (!this._enabledContinuousUpdates && !this.fullRefreshInFlight &&
          (!requested || resized)) {
        UpstreamRFB.messages.fbUpdateRequest(socket, true, 0, 0, this._fbWidth, this._fbHeight);
      }
    }
    return complete;
  }

  protected override _framebufferUpdate(): boolean {
    this.readingFramebufferUpdate = true;
    if (this.pipelineEnabled && !this.queuedScale && !this.awaitingScale && !this.fullRefreshInFlight &&
        !this.earlyRequest && this._FBU.rects === 0 &&
        this._rfbConnectionState === 'connected' && !this._enabledContinuousUpdates &&
        !this._pendingRemoteResize && !this._display.pending() &&
        !this._sock.rQwait('FBU header', 3)) {
      const header = this._sock.rQpeekBytes(3, false);
      if ((header[1] << 8 | header[2]) > 0) {
        // Set before sending and retain across incomplete decoder calls.
        this.earlyRequest = { width: this._fbWidth, height: this._fbHeight };
        UpstreamRFB.messages.fbUpdateRequest(this._sock, true, 0, 0, this._fbWidth, this._fbHeight);
      }
    }
    return super._framebufferUpdate();
  }

  protected override _handleDataRect(): boolean {
    const complete = super._handleDataRect();
    if (complete && this.fullRefreshInFlight && this._FBU.encoding !== 1 &&
        this._FBU.x + this._FBU.width <= this._fbWidth &&
        this._FBU.y + this._FBU.height <= this._fbHeight) {
      // Cover only completed pixel rectangles, excluding CopyRect. Cursor and
      // DesktopSize pseudo-rectangles never enter this upstream decoder path.
      this.refreshUncovered = subtractCoveredBounds(this.refreshUncovered, {
        left: this._FBU.x, top: this._FBU.y,
        right: this._FBU.x + this._FBU.width,
        bottom: this._FBU.y + this._FBU.height,
      });
    }
    return complete;
  }
}
