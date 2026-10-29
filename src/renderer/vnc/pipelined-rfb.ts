import UpstreamRFB from '@maclink/novnc-rfb';
import type { TransmissionScale } from '../../shared/types';

const DRAG_MOVE_DELAY = 8;
type FramebufferSize = Readonly<{ width: number; height: number }>;
type Bounds = { left: number; top: number; right: number; bottom: number };

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

/** Preserve noVNC 1.7's parsers while overlapping update requests and reducing
 * the mouse movement delay during dragging. */
export default class PipelinedRFB extends UpstreamRFB {
  private pipelineEnabled = true;
  private earlyRequest: { width: number; height: number } | undefined;
  private readingFramebufferUpdate = false;
  private appleScaling = false;
  private originalFramebufferSize: FramebufferSize | undefined;
  private queuedScale: TransmissionScale | undefined;
  private awaitingScale: TransmissionScale | undefined;
  private transmissionScaleRequested = false;
  private halfSizeCoordinates = false;
  private scaleResizeInFrame = false;
  private fullRefreshInFlight = false;
  private refreshUncovered: Bounds[] = [];

  override get supportsTransmissionScale(): boolean { return this.appleScaling; }

  override get framebufferSize(): FramebufferSize {
    return { width: this._fbWidth, height: this._fbHeight };
  }

  override setTransmissionScale(scale: TransmissionScale): boolean {
    if (!this.appleScaling || this._rfbConnectionState !== 'connected') return false;
    // The session deduplicates unchanged preferences. An explicit call here
    // must also work as a retry, or as cancellation of a pending half request.
    this.queuedScale = scale;
    if (!this.readingFramebufferUpdate) this.sendQueuedScale();
    return true;
  }

  protected override _negotiateProtocolVersion(): boolean | void {
    if (!this._sock.rQwait('version', 12)) {
      this.appleScaling = String.fromCharCode(...this._sock.rQpeekBytes(12)) === 'RFB 003.889\n';
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
    const original = this.originalFramebufferSize!;
    // absX/Y already account for local fit scaling and the scrolled viewport.
    const remoteX = Math.max(0, Math.min(original.width - 1,
      Math.floor(this._display.absX(x) * original.width / this._fbWidth)));
    const remoteY = Math.max(0, Math.min(original.height - 1,
      Math.floor(this._display.absY(y) * original.height / this._fbHeight)));
    if (this._extendedPointerEventSupported && (mask & 0x7f80)) {
      UpstreamRFB.messages.extendedPointerEvent(this._sock, remoteX, remoteY, mask);
    } else {
      UpstreamRFB.messages.pointerEvent(this._sock, remoteX, remoteY, mask);
    }
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
