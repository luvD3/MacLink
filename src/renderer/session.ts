import type { RFBEventMap } from '@novnc/novnc';
import RFB from './vnc/pipelined-rfb';
import { ClipboardSync } from './clipboard-sync';
import { bindRemoteInput } from './remote-input';
import { decoderBackend, prepareDecoder } from './vnc/inflator';
import type {
  ConnectionProfile,
  CredentialField,
  ScaleMode,
  SessionSnapshot,
  Shortcut,
  TransmissionScale,
  TransportEvent,
  TransportInfo,
  ViewerApi,
  ViewerError,
} from '../shared/types';

const CONNECTION_TIMEOUT_MS = 20_000;
const TRANSMISSION_TIMEOUT_MS = 5_000;
const CREDENTIAL_FIELDS: CredentialField[] = ['username', 'password', 'target'];
// Mac VNC convention used by RealVNC/Remmina; verify against the target macOS.
const COMMAND = { keysym: 0xffe9, code: 'AltLeft' };
const SHORTCUT_KEYS: Record<Shortcut, { keysym: number; code: string }> = {
  copy: { keysym: 0x63, code: 'KeyC' },
  paste: { keysym: 0x76, code: 'KeyV' },
  cut: { keysym: 0x78, code: 'KeyX' },
  selectAll: { keysym: 0x61, code: 'KeyA' },
  spotlight: { keysym: 0x20, code: 'Space' },
  commandTab: { keysym: 0xff09, code: 'Tab' },
  escape: { keysym: 0xff1b, code: 'Escape' },
};

interface ConnectionAttempt {
  transport?: TransportInfo;
  rfb?: RFB;
  scale: ScaleMode;
  transmissionScale: TransmissionScale;
  originalSize?: Readonly<{ width: number; height: number }>;
  viewOnly: boolean;
  connected: boolean;
  clipboard?: ClipboardSync;
  input?: ReturnType<typeof bindRemoteInput>;
  timer?: ReturnType<typeof setTimeout>;
  transmissionTimer?: ReturnType<typeof setTimeout>;
  cancel(): void;
  releaseKeys(): void;
  removeListeners: Array<() => void>;
}

function initialSnapshot(): SessionSnapshot {
  return {
    phase: 'idle',
    desktopName: '',
    credentialFields: [],
    clipboardNotice: '',
    clipboardSync: true,
    remoteFocused: false,
    transmissionScale: { requested: 'original', supported: false, pending: false, width: 0, height: 0 },
  };
}

export class ViewerSession {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeTransport: () => void;
  private active?: ConnectionAttempt;
  private disposed = false;
  private clipboardEnabled = true;

  constructor(private readonly api: ViewerApi) {
    this.unsubscribeTransport = api.onTransportEvent((event) => this.handleTransportEvent(event));
  }

  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  async connect(profile: ConnectionProfile, target: HTMLElement): Promise<void> {
    if (this.disposed) return;
    this.releaseActive();

    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); });
    const attempt: ConnectionAttempt = {
      scale: profile.scale,
      transmissionScale: profile.transmissionScale,
      viewOnly: profile.viewOnly,
      connected: false,
      cancel,
      releaseKeys: () => {},
      removeListeners: [],
    };
    this.active = attempt;
    this.snapshot = { ...initialSnapshot(), clipboardSync: this.clipboardEnabled };
    this.startTimeout(attempt);
    this.update({
      phase: 'connecting',
      transmissionScale: { ...this.snapshot.transmissionScale, requested: profile.transmissionScale },
    });

    try {
      // Cancellation releases the caller immediately. If IPC finishes later,
      // its bridge is closed without constructing a stale viewer.
      const opening = this.api.openTransport({ host: profile.host, port: profile.port }).then((transport) => {
        if (this.active !== attempt) {
          this.closeTransport(transport.id);
          return undefined;
        }
        // Own the bridge immediately, even while WASM preparation is pending.
        attempt.transport = transport;
        return transport;
      });
      const prepared = await Promise.race([Promise.all([opening, prepareDecoder()]), cancelled]);
      const transport = prepared?.[0];
      if (!transport) return;
      if (this.active !== attempt) return;
      const rfb = new RFB(target, transport.url, { shared: true });
      target.dataset.decoder = decoderBackend();
      attempt.rfb = rfb;
      rfb.scaleViewport = attempt.scale === 'fit';
      rfb.clipViewport = false;
      rfb.resizeSession = false;
      rfb.viewOnly = attempt.viewOnly;
      rfb.focusOnClick = true;
      // Keep a local pointer visible when macOS supplies no cursor shape.
      // noVNC automatically uses the server cursor again when one arrives.
      rfb.showDotCursor = true;
      // Compression 6 improved the tested 4K Mac session. These are server
      // preferences; quality applies to JPEG and has no effect on ZRLE.
      rfb.compressionLevel = 6;
      rfb.qualityLevel = 4;
      rfb.background = 'transparent';

      this.listen(attempt, 'connect', () => {
        attempt.connected = true;
        attempt.originalSize = rfb.framebufferSize;
        this.clearTimeout(attempt);
        this.releaseKeysOnFocusChange(attempt, target);
        this.update({
          phase: 'connected', credentialFields: [], error: undefined,
          transmissionScale: {
            requested: attempt.transmissionScale, supported: rfb.supportsTransmissionScale,
            pending: false, ...attempt.originalSize,
          },
        });
        this.setTransmissionScale(attempt.transmissionScale);
        this.configureClipboard(attempt);
        attempt.input = bindRemoteInput(target, (focused) => {
          this.api.setRemoteFocused(focused);
          this.update({ remoteFocused: focused });
          if (focused) attempt.clipboard?.refresh();
        });
        attempt.input.setViewOnly(attempt.viewOnly);
      });
      this.listen(attempt, 'framebuffersize', (event) => {
        // ServerInit may report its size before connect; the connect handler
        // reads that initial size and owns the baseline for this connection.
        if (!attempt.connected) return;
        const { width, height } = event.detail;
        const confirmed = this.matchesTransmissionScale(attempt, width, height);
        if (confirmed) this.clearTransmissionTimeout(attempt);
        const current = this.snapshot.transmissionScale;
        this.update({ transmissionScale: {
          ...current, width, height,
          pending: confirmed ? false : current.pending,
          error: confirmed ? undefined : current.error,
        } });
      });
      this.listen(attempt, 'credentialsrequired', (event) => {
        const fields = event.detail.types;
        if (fields.length === 0 || fields.some((field) => !CREDENTIAL_FIELDS.includes(field as CredentialField))) {
          this.fail(attempt, { code: 'unsupported-auth', message: '服务器要求的认证方式暂不受支持。请检查 Mac 的屏幕共享设置。' });
          return;
        }
        // Waiting for a person is not a failed network handshake.
        this.clearTimeout(attempt);
        this.update({ phase: 'authenticating', credentialFields: fields as CredentialField[], error: undefined });
      });
      this.listen(attempt, 'securityfailure', (event) => {
        const reason = event.detail.reason;
        const unsupported = !!reason && /unsupported|not supported|no supported|no matching/i.test(reason);
        this.fail(attempt, {
          code: unsupported ? 'unsupported-auth' : 'authentication',
          message: reason
            ? `认证未通过：${reason}`
            : '认证未通过。请检查所填凭据以及 Mac 的屏幕共享访问权限。',
        });
      });
      this.listen(attempt, 'serververification', () => {
        this.fail(attempt, {
          code: 'unsupported-auth',
          message: '此服务器要求额外的身份确认，当前版本尚不支持。请使用 Mac 自带的屏幕共享服务。',
        });
      });
      this.listen(attempt, 'disconnect', () => {
        // noVNC has already finished teardown when it emits this event.
        attempt.rfb = undefined;
        this.fail(attempt, this.disconnectionError(attempt));
      });
      this.listen(attempt, 'desktopname', (event) => this.update({ desktopName: event.detail.name }));
      this.listen(attempt, 'clipboard', (event) => {
        this.update({
          clipboardNotice: attempt.clipboard ? '已收到远端文本。' : '已收到远端文本，自动同步已暂停。',
        });
        attempt.clipboard?.receive(event.detail.text);
      });
    } catch (error) {
      if (this.active !== attempt) return;
      const message = error instanceof Error ? error.message : String(error);
      this.fail(attempt, {
        code: message.includes('地址无效') ? 'invalid-address' : 'network',
        message: message.includes('地址无效') ? message : `无法建立连接：${message}`,
      });
    }
  }

  disconnect(): void {
    if (this.disposed) return;
    this.releaseActive();
    this.update({ phase: 'disconnected', credentialFields: [], error: undefined });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseActive();
    this.unsubscribeTransport();
    this.listeners.clear();
    this.snapshot = { ...this.snapshot, phase: 'disconnected', credentialFields: [], error: undefined };
  }

  submitCredentials(credentials: Partial<Record<CredentialField, string>>): void {
    const attempt = this.active;
    if (!attempt?.rfb || this.snapshot.phase !== 'authenticating') return;
    const fields = this.snapshot.credentialFields;
    if (fields.some((field) => credentials[field] === undefined)) return;

    // Forward only what this server requested; never keep credentials in state.
    const requested = Object.fromEntries(fields.map((field) => [field, credentials[field]]));
    this.startTimeout(attempt);
    this.update({ phase: 'connecting', credentialFields: [] });
    attempt.rfb.sendCredentials(requested);
  }

  setScale(scale: ScaleMode): void {
    if (!this.active) return;
    this.active.scale = scale;
    if (this.active.rfb) this.active.rfb.scaleViewport = scale === 'fit';
  }

  setTransmissionScale(value: TransmissionScale): void {
    const attempt = this.active;
    if (!attempt) return;
    const previous = attempt.transmissionScale;
    attempt.transmissionScale = value;
    const current = this.snapshot.transmissionScale;
    const rfb = attempt.rfb;
    if (!attempt.connected || !rfb) {
      this.update({ transmissionScale: { ...current, requested: value } });
      return;
    }
    const supported = rfb.supportsTransmissionScale;
    if (supported && previous === value && !current.error &&
        (current.pending || this.matchesTransmissionScale(attempt, current.width, current.height))) return;

    this.clearTransmissionTimeout(attempt);
    const next = { ...current, requested: value, supported, pending: false, error: undefined };
    if (!supported) {
      this.update({ transmissionScale: {
        ...next, error: value === 'half' ? '此服务器不支持半尺寸传输。' : undefined,
      } });
      return;
    }

    // Reverting a pending request still needs a new server acknowledgement,
    // even when the last received framebuffer happens to have the old size.
    this.update({ transmissionScale: { ...next, pending: true } });
    attempt.transmissionTimer = setTimeout(() => {
      attempt.transmissionTimer = undefined;
      if (this.active === attempt) this.update({ transmissionScale: {
        ...this.snapshot.transmissionScale, pending: false,
        error: '未收到传输尺寸确认，当前会话继续使用已收到的画面尺寸。',
      } });
    }, TRANSMISSION_TIMEOUT_MS);
    if (!rfb.setTransmissionScale(value)) {
      this.clearTransmissionTimeout(attempt);
      this.update({ transmissionScale: {
        ...this.snapshot.transmissionScale, pending: false, error: '传输尺寸请求未发送，当前会话仍可使用。',
      } });
    }
  }

  private matchesTransmissionScale(attempt: ConnectionAttempt, width: number, height: number): boolean {
    const original = attempt.originalSize!;
    return attempt.transmissionScale === 'original'
      ? width === original.width && height === original.height
      : Math.abs(width - original.width / 2) <= 0.5 && Math.abs(height - original.height / 2) <= 0.5;
  }

  private clearTransmissionTimeout(attempt: ConnectionAttempt): void {
    if (attempt.transmissionTimer !== undefined) clearTimeout(attempt.transmissionTimer);
    attempt.transmissionTimer = undefined;
  }

  setViewOnly(viewOnly: boolean): void {
    if (!this.active) return;
    if (viewOnly) this.active.releaseKeys();
    this.active.viewOnly = viewOnly;
    if (this.active.rfb) this.active.rfb.viewOnly = viewOnly;
    this.active.input?.setViewOnly(viewOnly);
    this.configureClipboard(this.active);
  }

  setClipboardSync(enabled: boolean): void {
    this.clipboardEnabled = enabled;
    this.update({ clipboardSync: enabled, clipboardNotice: enabled ? '自动同步已开启。' : '自动同步已暂停。' });
    if (this.active) this.configureClipboard(this.active);
  }

  focus(): void {
    if (this.active?.connected) this.active.rfb?.focus();
  }

  sendShortcut(shortcut: Shortcut): void {
    const attempt = this.active;
    if (!attempt?.rfb || !attempt.connected || attempt.viewOnly) return;
    const rfb = attempt.rfb;
    const key = SHORTCUT_KEYS[shortcut];
    if (shortcut !== 'escape') rfb.sendKey(COMMAND.keysym, COMMAND.code, true);
    rfb.sendKey(key.keysym, key.code, true);
    rfb.sendKey(key.keysym, key.code, false);
    if (shortcut !== 'escape') rfb.sendKey(COMMAND.keysym, COMMAND.code, false);
    rfb.focus();
  }

  private sendClipboard(attempt: ConnectionAttempt, text: string): void {
    // noVNC exposes no public Unicode-clipboard capability. Its legacy path
    // replaces characters outside ISO-8859-1 with '?', so do not send them.
    if (/[^\u0000-\u00ff]/u.test(text)) {
      this.update({ clipboardNotice: '未发送：当前版本仅发送 Latin-1 文本，暂不支持中文或表情，以免内容变成问号。' });
      return;
    }
    attempt.rfb!.clipboardPasteFrom(text);
    this.update({ clipboardNotice: '本机文本已同步到 Mac。' });
  }

  private configureClipboard(attempt: ConnectionAttempt): void {
    const enabled = attempt.connected && this.clipboardEnabled && !attempt.viewOnly;
    if (!enabled) {
      attempt.clipboard?.dispose();
      attempt.clipboard = undefined;
    } else if (!attempt.clipboard) {
      attempt.clipboard = new ClipboardSync(this.api, (text) => this.sendClipboard(attempt, text), () => {
        if (this.active !== attempt) return;
        this.clipboardEnabled = false;
        attempt.clipboard = undefined;
        this.update({ clipboardSync: false, clipboardNotice: '无法访问本机剪贴板，自动同步已暂停，可手动重新开启。' });
      });
    }
  }

  private listen<K extends keyof RFBEventMap>(
    attempt: ConnectionAttempt,
    type: K,
    handler: (event: RFBEventMap[K]) => void,
  ): void {
    const rfb = attempt.rfb!;
    const listener = (event: RFBEventMap[K]) => {
      if (this.active === attempt) handler(event);
    };
    rfb.addEventListener(type, listener);
    attempt.removeListeners.push(() => rfb.removeEventListener(type, listener as EventListener));
  }

  private handleTransportEvent(event: TransportEvent): void {
    const attempt = this.active;
    if (!attempt || attempt.transport?.id !== event.id) return;
    // A final RFB securityfailure can still be queued in the browser when the
    // main process observes a clean WebSocket close. Let noVNC drain its ordered
    // messages and emit disconnect; otherwise the auth error gets overwritten.
    if (event.type === 'closed' && attempt.rfb) return;
    this.fail(attempt, event.error ?? this.disconnectionError(attempt));
  }

  private releaseKeysOnFocusChange(attempt: ConnectionAttempt, target: HTMLElement): void {
    const held = new Map<string, { target: EventTarget; key: string; code: string; location: number }>();
    const keyDown = (event: KeyboardEvent) => {
      if (attempt.viewOnly || !event.code || event.code === 'Unidentified' || !event.target) return;
      held.set(event.code, { target: event.target, key: event.key, code: event.code, location: event.location });
    };
    const keyUp = (event: KeyboardEvent) => { held.delete(event.code); };
    const release = () => {
      const pressed = [...held.values()];
      held.clear();
      for (const key of pressed) {
        // Re-enter noVNC through the canvas DOM event so its own key tracker and
        // AltGr handling are cleared too. sendKey() alone would leave them stale.
        key.target.dispatchEvent(new KeyboardEvent('keyup', {
          key: key.key, code: key.code, location: key.location, bubbles: true, cancelable: true,
        }));
      }
    };
    // noVNC already handles window blur; clear our independent tracker after its
    // listener has run, including after viewOnly has reattached that listener.
    const windowBlur = () => { queueMicrotask(() => held.clear()); };
    const view = target.ownerDocument.defaultView;
    target.addEventListener('keydown', keyDown, { capture: true });
    target.addEventListener('keyup', keyUp, { capture: true });
    target.addEventListener('focusout', release);
    view?.addEventListener('blur', windowBlur);
    attempt.releaseKeys = release;
    attempt.removeListeners.push(() => {
      target.removeEventListener('keydown', keyDown, { capture: true });
      target.removeEventListener('keyup', keyUp, { capture: true });
      target.removeEventListener('focusout', release);
      view?.removeEventListener('blur', windowBlur);
    });
  }

  private disconnectionError(attempt: ConnectionAttempt): ViewerError {
    return attempt.connected
      ? { code: 'remote-disconnected', message: '远端连接已断开。可以重新连接。' }
      : { code: 'network', message: 'VNC 连接未能完成。请检查网络、Mac 的屏幕共享和认证设置；服务器未提供具体原因。' };
  }

  private startTimeout(attempt: ConnectionAttempt): void {
    this.clearTimeout(attempt);
    attempt.timer = setTimeout(() => {
      if (this.active === attempt) {
        this.fail(attempt, { code: 'network', message: '连接超时。请检查 Mac 地址、网络和屏幕共享设置后重试。' });
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  private clearTimeout(attempt: ConnectionAttempt): void {
    if (attempt.timer !== undefined) clearTimeout(attempt.timer);
    attempt.timer = undefined;
  }

  private fail(attempt: ConnectionAttempt, error: ViewerError): void {
    if (this.active !== attempt) return;
    this.releaseActive();
    this.update({ phase: 'error', credentialFields: [], error });
  }

  private releaseActive(): void {
    const attempt = this.active;
    if (!attempt) return;
    this.active = undefined;
    this.clearTimeout(attempt);
    this.clearTransmissionTimeout(attempt);
    this.snapshot = { ...this.snapshot, transmissionScale: { ...this.snapshot.transmissionScale, pending: false } };
    attempt.cancel();
    attempt.releaseKeys();
    attempt.clipboard?.dispose();
    attempt.input?.dispose();
    for (const remove of attempt.removeListeners) remove();
    attempt.rfb?.disconnect();
    if (attempt.transport) this.closeTransport(attempt.transport.id);
  }

  private closeTransport(id: string): void {
    // IPC can reject while the app is closing. Keep teardown rejection at this
    // asynchronous resource boundary, without changing a newer session's state.
    void this.api.closeTransport(id).catch(() => {
      console.warn('本机连接桥未能完成关闭。');
    });
  }

  private update(change: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}
