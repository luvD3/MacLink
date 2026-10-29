import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile, TransportEvent, TransportInfo, ViewerApi } from '../src/shared/types';

const { MockRFB, prepareDecoder } = vi.hoisted(() => {
  class MockRFB extends EventTarget {
    static instances: MockRFB[] = [];
    scaleViewport = false;
    clipViewport = false;
    resizeSession = false;
    viewOnly = false;
    focusOnClick = false;
    showDotCursor = false;
    qualityLevel = 6;
    compressionLevel = 2;
    background = '';
    framebufferSize = { width: 3840, height: 2160 };
    supportsTransmissionScale = true;
    setTransmissionScale = vi.fn((_value: 'original' | 'half') => true);
    disconnect = vi.fn();
    sendCredentials = vi.fn();
    sendKey = vi.fn();
    clipboardPasteFrom = vi.fn();
    focus = vi.fn();
    blur = vi.fn();
    removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject | null) => {
      super.removeEventListener(type, listener);
    });

    constructor(readonly target: HTMLElement, readonly url: string, readonly options: object) {
      super();
      MockRFB.instances.push(this);
    }

    emit(type: string, detail?: unknown): void {
      if (type === 'framebuffersize') this.framebufferSize = detail as { width: number; height: number };
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }
  return { MockRFB, prepareDecoder: vi.fn(async () => {}) };
});

vi.mock('../src/renderer/vnc/pipelined-rfb', () => ({ default: MockRFB }));
vi.mock('../src/renderer/vnc/inflator', () => ({ prepareDecoder, decoderBackend: () => 'wasm' }));

import { ViewerSession } from '../src/renderer/session';

const profile: ConnectionProfile = {
  id: 'mac', name: '工作 Mac', host: 'mac.local', port: 5900, scale: 'fit', transmissionScale: 'original', viewOnly: false,
};
const viewerWindow = new EventTarget();
const viewerDocument = Object.assign(new EventTarget(), {
  defaultView: viewerWindow, activeElement: null as EventTarget | null, fullscreenElement: null,
  hasFocus: () => true,
});
const target = Object.assign(new EventTarget(), {
  ownerDocument: viewerDocument,
  dataset: {},
  contains: (element: EventTarget | null) => element === target,
}) as unknown as HTMLElement;
const sessions: ViewerSession[] = [];

class TestKeyboardEvent extends Event {
  readonly key: string;
  readonly code: string;
  readonly location: number;
  constructor(type: string, init: KeyboardEventInit = {}) {
    super(type, init);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.location = init.location ?? 0;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const transportListeners = new Set<(event: TransportEvent) => void>();
  const api: ViewerApi = {
    loadSettings: vi.fn(async () => ({ version: 1 as const, connections: [] })),
    saveConnections: vi.fn(async () => {}),
    openTransport: vi.fn(async () => ({ id: 'bridge-1', url: 'ws://127.0.0.1:1234/session' })),
    closeTransport: vi.fn(async () => {}),
    onTransportEvent: vi.fn((listener) => {
      transportListeners.add(listener);
      return () => { transportListeners.delete(listener); };
    }),
    readClipboard: vi.fn(async () => ''),
    writeClipboard: vi.fn(async () => {}),
    setRemoteFocused: vi.fn(),
    setFullscreen: vi.fn(async () => {}),
    onFullscreenChange: vi.fn(() => () => {}),
    getVersion: vi.fn(async () => '0.1.0'),
  };
  const session = new ViewerSession(api);
  sessions.push(session);
  return {
    session,
    api,
    emitTransport: (event: TransportEvent) => transportListeners.forEach((listener) => listener(event)),
    transportListenerCount: () => transportListeners.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('KeyboardEvent', TestKeyboardEvent);
  MockRFB.instances.length = 0;
  prepareDecoder.mockReset().mockResolvedValue(undefined);
  viewerDocument.activeElement = null;
});

afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ViewerSession', () => {
  it('exposes stable snapshots and subscribes only until unsubscribed', async () => {
    const { session } = setup();
    const idle = session.getSnapshot();
    expect(session.getSnapshot()).toBe(idle);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    await session.connect(profile, target);
    expect(session.getSnapshot()).not.toBe(idle);
    expect(session.getSnapshot().phase).toBe('connecting');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    MockRFB.instances[0].emit('connect');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().phase).toBe('connected');
    expect(vi.getTimerCount()).toBe(1); // Only the connected clipboard watcher remains.
  });

  it('opens the requested transport without preloading credentials or resizing the Mac', async () => {
    const { session, api } = setup();
    await session.connect({ ...profile, scale: 'actual', viewOnly: true }, target);
    const rfb = MockRFB.instances[0];
    expect(api.openTransport).toHaveBeenCalledWith({ host: 'mac.local', port: 5900 });
    expect(rfb.options).toEqual({ shared: true });
    expect(rfb.target).toBe(target);
    expect(rfb.url).toBe('ws://127.0.0.1:1234/session');
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.scaleViewport).toBe(false);
    expect(rfb.resizeSession).toBe(false);
    expect(rfb.clipViewport).toBe(false);
    expect(rfb.showDotCursor).toBe(true);
    expect(rfb.compressionLevel).toBe(6);
    expect(rfb.qualityLevel).toBe(4);

    session.setScale('fit');
    session.setViewOnly(false);
    expect(rfb.scaleViewport).toBe(true);
    expect(rfb.viewOnly).toBe(false);
    rfb.emit('desktopname', { name: 'MacBook Pro' });
    expect(session.getSnapshot().desktopName).toBe('MacBook Pro');
  });

  it('requests only the server-required credentials and never puts secrets in state', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    session.submitCredentials({ password: 'before-request' });
    expect(rfb.sendCredentials).not.toHaveBeenCalled();

    rfb.emit('credentialsrequired', { types: ['username', 'password'] });
    expect(session.getSnapshot()).toMatchObject({ phase: 'authenticating', credentialFields: ['username', 'password'] });
    session.submitCredentials({ username: 'alice' });
    expect(rfb.sendCredentials).not.toHaveBeenCalled();
    session.submitCredentials({ username: 'alice', password: 'secret', target: 'not-requested' });
    expect(rfb.sendCredentials).toHaveBeenCalledWith({ username: 'alice', password: 'secret' });
    expect(session.getSnapshot()).toMatchObject({ phase: 'connecting', credentialFields: [] });
    expect(JSON.stringify(session.getSnapshot())).not.toContain('secret');
    rfb.emit('connect');
    expect(session.getSnapshot().phase).toBe('connected');
  });

  it('waits for user credentials without timing out, then bounds the resumed handshake', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit('credentialsrequired', { types: ['password'] });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.getSnapshot().phase).toBe('authenticating');
    expect(vi.getTimerCount()).toBe(0);
    session.submitCredentials({ password: '' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'network' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps explicit authentication errors when later disconnect events arrive', async () => {
    const { session, emitTransport } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('securityfailure', { status: 1, reason: 'Invalid password' });
    rfb.emit('disconnect', { clean: false });
    emitTransport({ id: 'bridge-1', type: 'closed' });
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'authentication' } });
    expect(session.getSnapshot().error?.message).toContain('Invalid password');
    expect(rfb.disconnect).toHaveBeenCalledOnce();
  });

  it('allows the final authentication failure to arrive after a bare bridge-close event', async () => {
    const { session, emitTransport } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    emitTransport({ id: 'bridge-1', type: 'closed' });
    expect(rfb.disconnect).not.toHaveBeenCalled();
    rfb.emit('securityfailure', { status: 1, reason: 'Invalid password' });
    rfb.emit('disconnect', { clean: false });
    expect(session.getSnapshot().error?.code).toBe('authentication');
  });

  it.each([
    ['credentialsrequired', { types: ['token'] }],
    ['serververification', { type: 'RSA' }],
    ['securityfailure', { status: 1, reason: 'Unsupported authentication method' }],
  ])('reports a known unsupported authentication requirement from %s', async (event, detail) => {
    const { session } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit(event as string, detail);
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'unsupported-auth' } });
  });

  it('does not invent an authentication diagnosis from an opaque handshake disconnect', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit('disconnect', { clean: false });
    expect(session.getSnapshot().error?.code).toBe('network');
    expect(session.getSnapshot().error?.message).toContain('服务器未提供具体原因');
  });

  it('distinguishes remote disconnects after a successful connection', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    rfb.emit('disconnect', { clean: true });
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'remote-disconnected' } });
    expect(rfb.disconnect).not.toHaveBeenCalled();
  });

  it('preserves transport errors and ignores unrelated bridge events', async () => {
    const { session, emitTransport } = setup();
    await session.connect(profile, target);
    emitTransport({ id: 'other-bridge', type: 'closed' });
    expect(session.getSnapshot().phase).toBe('connecting');
    const error = { code: 'invalid-address' as const, message: '找不到这个主机。' };
    emitTransport({ id: 'bridge-1', type: 'error', error });
    expect(session.getSnapshot().error).toEqual(error);
  });

  it('maps address validation errors across the Electron IPC error wrapper', async () => {
    const { session, api } = setup();
    vi.mocked(api.openTransport).mockRejectedValue(new Error("Error invoking remote method 'transport:open': Error: 地址无效：请输入主机名。"));
    await session.connect(profile, target);
    expect(session.getSnapshot().error?.code).toBe('invalid-address');
    expect(MockRFB.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending opening immediately and closes a late bridge without reviving it', async () => {
    const { session, api } = setup();
    const pending = deferred<TransportInfo>();
    vi.mocked(api.openTransport).mockReturnValue(pending.promise);
    const connecting = session.connect(profile, target);
    session.disconnect();
    await connecting;
    expect(session.getSnapshot().phase).toBe('disconnected');
    pending.resolve({ id: 'late', url: 'ws://127.0.0.1:4321/late' });
    await Promise.resolve();
    expect(api.closeTransport).toHaveBeenCalledWith('late');
    expect(MockRFB.instances).toHaveLength(0);
    expect(session.getSnapshot().phase).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a bridge opening that never resolves', async () => {
    const { session, api } = setup();
    vi.mocked(api.openTransport).mockReturnValue(new Promise(() => {}));
    const connecting = session.connect(profile, target);
    await vi.advanceTimersByTimeAsync(20_000);
    await connecting;
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: { code: 'network' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes an already-open bridge when cancelled during decoder preparation', async () => {
    const { session, api } = setup();
    const preparing = deferred<void>();
    prepareDecoder.mockReturnValueOnce(preparing.promise);
    const connecting = session.connect(profile, target);
    await Promise.resolve();

    session.disconnect();
    await connecting;
    expect(api.closeTransport).toHaveBeenCalledExactlyOnceWith('bridge-1');
    expect(MockRFB.instances).toHaveLength(0);

    preparing.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(MockRFB.instances).toHaveLength(0);
    expect(session.getSnapshot().phase).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles bridge failure while decoder preparation is still pending', async () => {
    const { session, api, emitTransport } = setup();
    const preparing = deferred<void>();
    prepareDecoder.mockReturnValueOnce(preparing.promise);
    const connecting = session.connect(profile, target);
    await Promise.resolve();
    const error = { code: 'network' as const, message: 'Bridge attach timeout' };

    emitTransport({ id: 'bridge-1', type: 'error', error });
    await connecting;
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error });
    expect(api.closeTransport).toHaveBeenCalledExactlyOnceWith('bridge-1');
    preparing.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(MockRFB.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supersedes pending and established sessions without letting old events win', async () => {
    const { session, api, emitTransport } = setup();
    const pending = deferred<TransportInfo>();
    vi.mocked(api.openTransport)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ id: 'bridge-2', url: 'ws://127.0.0.1:1234/two' })
      .mockResolvedValueOnce({ id: 'bridge-3', url: 'ws://127.0.0.1:1234/three' });
    const firstConnect = session.connect(profile, target);
    await session.connect({ ...profile, host: 'second.local' }, target);
    await firstConnect;
    pending.resolve({ id: 'bridge-1', url: 'ws://127.0.0.1:1234/one' });
    await Promise.resolve();
    expect(MockRFB.instances).toHaveLength(1);
    const second = MockRFB.instances[0];
    second.emit('connect');

    await session.connect({ ...profile, host: 'third.local' }, target);
    second.emit('connect');
    second.emit('securityfailure', { status: 1 });
    emitTransport({ id: 'bridge-2', type: 'closed' });
    expect(session.getSnapshot().phase).toBe('connecting');
    MockRFB.instances[1].emit('connect');
    expect(session.getSnapshot().phase).toBe('connected');
    expect(second.disconnect).toHaveBeenCalledOnce();
    expect(second.removeEventListener).toHaveBeenCalled();
    expect(api.closeTransport).toHaveBeenCalledWith('bridge-1');
    expect(api.closeTransport).toHaveBeenCalledWith('bridge-2');
  });

  it('disposes subscriptions, timers, and connections exactly once', async () => {
    const { session, api, transportListenerCount } = setup();
    const listener = vi.fn();
    session.subscribe(listener);
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    listener.mockClear();
    session.dispose();
    session.dispose();
    rfb.emit('connect');
    await session.connect(profile, target);
    expect(listener).not.toHaveBeenCalled();
    expect(transportListenerCount()).toBe(0);
    expect(rfb.disconnect).toHaveBeenCalledOnce();
    expect(api.closeTransport).toHaveBeenCalledOnce();
    expect(MockRFB.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leak teardown rejection into a later connection', async () => {
    const { session, api } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(api.closeTransport).mockRejectedValue(new Error('IPC unavailable'));
    await session.connect(profile, target);
    session.disconnect();
    await session.connect(profile, target);
    MockRFB.instances[1].emit('connect');
    expect(session.getSnapshot().phase).toBe('connected');
    expect(session.getSnapshot().error).toBeUndefined();
  });

  it('accepts Latin-1 clipboard text and explicitly refuses lossy Unicode sending', async () => {
    const { session, api } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(api.readClipboard).mockResolvedValue('Café\nHello');
    await vi.advanceTimersByTimeAsync(250);
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('Café\nHello');
    vi.mocked(api.readClipboard).mockResolvedValue('你好 🐈');
    await vi.advanceTimersByTimeAsync(250);
    expect(session.getSnapshot().clipboardNotice).toContain('未发送');
    expect(session.getSnapshot().clipboardNotice).toContain('中文');
    expect(rfb.clipboardPasteFrom).toHaveBeenCalledOnce();
    rfb.emit('clipboard', { text: '来自 Mac 的文本' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.writeClipboard).toHaveBeenCalledWith('来自 Mac 的文本');
  });

  it('blocks shortcut and clipboard output in view-only mode', async () => {
    const { session, api } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    session.setViewOnly(true);
    session.sendShortcut('copy');
    vi.mocked(api.readClipboard).mockResolvedValue('Hello');
    await vi.advanceTimersByTimeAsync(250);
    expect(rfb.sendKey).not.toHaveBeenCalled();
    expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled();
    expect(api.readClipboard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses both clipboard directions and keeps the choice on reconnect', async () => {
    const { session, api } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit('connect');
    session.setClipboardSync(false);
    MockRFB.instances[0].emit('clipboard', { text: 'ignored' });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.writeClipboard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await session.connect(profile, target);
    MockRFB.instances[1].emit('connect');
    expect(session.getSnapshot().clipboardSync).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    session.setClipboardSync(true);
    await vi.advanceTimersByTimeAsync(0);
    MockRFB.instances[1].emit('clipboard', { text: 'new copy' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.writeClipboard).toHaveBeenCalledWith('new copy');
    session.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports clipboard access failure without disconnecting the desktop', async () => {
    const { session, api } = setup();
    vi.mocked(api.readClipboard).mockRejectedValue(new Error('Clipboard locked'));
    await session.connect(profile, target);
    MockRFB.instances[0].emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', clipboardSync: false });
    expect(session.getSnapshot().clipboardNotice).toContain('无法访问');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes application shortcuts only while the remote canvas has focus', async () => {
    const { session, api } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit('connect');
    viewerDocument.activeElement = target;
    target.dispatchEvent(new Event('focusin'));
    expect(session.getSnapshot().remoteFocused).toBe(true);
    expect(api.setRemoteFocused).toHaveBeenLastCalledWith(true);
    viewerWindow.dispatchEvent(new Event('blur'));
    expect(api.setRemoteFocused).toHaveBeenLastCalledWith(false);
    viewerWindow.dispatchEvent(new Event('focus'));
    expect(api.setRemoteFocused).toHaveBeenLastCalledWith(true);
    session.disconnect();
    expect(session.getSnapshot().remoteFocused).toBe(false);
    expect(api.setRemoteFocused).toHaveBeenLastCalledWith(false);
  });

  it('returns focus to an established remote desktop only', async () => {
    const { session } = setup();
    session.focus();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    session.focus();
    expect(rfb.focus).not.toHaveBeenCalled();
    rfb.emit('connect');
    session.focus();
    expect(rfb.focus).toHaveBeenCalledOnce();
    session.disconnect();
    session.focus();
    expect(rfb.focus).toHaveBeenCalledOnce();
  });

  it('replays key releases through the original DOM target when focus moves to a toolbar', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit('connect');
    const received: Array<[string, string, number]> = [];
    const onKeyUp = (event: KeyboardEvent) => received.push([event.key, event.code, event.location]);
    target.addEventListener('keyup', onKeyUp);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftRight', location: 2 }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA' }));
    target.dispatchEvent(new Event('focusout'));
    target.dispatchEvent(new Event('focusout'));
    target.removeEventListener('keyup', onKeyUp);
    expect(received).toEqual([['Shift', 'ShiftRight', 2], ['A', 'KeyA', 0]]);
  });

  it('does not replay keys that were already released or handled by noVNC window blur', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    MockRFB.instances[0].emit('connect');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', location: 1 }));
    viewerWindow.dispatchEvent(new Event('blur'));
    await Promise.resolve();
    const onKeyUp = vi.fn();
    target.addEventListener('keyup', onKeyUp);
    target.dispatchEvent(new Event('focusout'));
    target.removeEventListener('keyup', onKeyUp);
    expect(onKeyUp).not.toHaveBeenCalled();
  });

  it('releases held keys before view-only disables noVNC key sending', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', location: 1 }));
    const states: boolean[] = [];
    const onKeyUp = () => states.push(rfb.viewOnly);
    target.addEventListener('keyup', onKeyUp);
    session.setViewOnly(true);
    target.removeEventListener('keyup', onKeyUp);
    expect(states).toEqual([false]);
    expect(rfb.viewOnly).toBe(true);
  });

  it.each([
    ['copy', 0x63, 'KeyC'],
    ['paste', 0x76, 'KeyV'],
    ['cut', 0x78, 'KeyX'],
    ['selectAll', 0x61, 'KeyA'],
    ['spotlight', 0x20, 'Space'],
    ['commandTab', 0xff09, 'Tab'],
  ] as const)('sends and releases both Command and the %s shortcut key', async (shortcut, keysym, code) => {
    const { session } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    session.sendShortcut(shortcut);
    expect(rfb.sendKey.mock.calls).toEqual([
      [0xffe9, 'AltLeft', true],
      [keysym, code, true],
      [keysym, code, false],
      [0xffe9, 'AltLeft', false],
    ]);
  });

  it('sends Escape without a Command modifier', async () => {
    const { session } = setup();
    session.sendShortcut('escape');
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    session.sendShortcut('escape');
    expect(rfb.sendKey).not.toHaveBeenCalled();
    rfb.emit('connect');
    session.sendShortcut('escape');
    expect(rfb.sendKey.mock.calls).toEqual([[0xff1b, 'Escape', true], [0xff1b, 'Escape', false]]);
  });
});

describe('transmission scale', () => {
  it('uses the initial server framebuffer as the original size without resizing the Mac', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('framebuffersize', { width: 2560, height: 1440 });
    expect(session.getSnapshot().transmissionScale.width).toBe(0);
    rfb.emit('connect');
    expect(session.getSnapshot().transmissionScale).toEqual({
      requested: 'original', supported: true, pending: false, width: 2560, height: 1440,
    });
    expect(rfb.setTransmissionScale).not.toHaveBeenCalled();
    expect(rfb.resizeSession).toBe(false);
  });

  it('applies the saved preference and waits for actual size before confirming', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    expect(rfb.setTransmissionScale).not.toHaveBeenCalled();
    rfb.emit('connect');
    expect(rfb.setTransmissionScale).toHaveBeenCalledExactlyOnceWith('half');
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'half', supported: true, pending: true, width: 3840, height: 2160,
    });
    session.setTransmissionScale('half');
    session.setScale('actual');
    expect(rfb.setTransmissionScale).toHaveBeenCalledOnce();
    expect(rfb.scaleViewport).toBe(false);
    rfb.emit('framebuffersize', { width: 1920, height: 1080 });
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'half', pending: false, width: 1920, height: 1080, error: undefined,
    });
    expect(vi.getTimerCount()).toBe(1); // Clipboard only.
    expect(rfb.resizeSession).toBe(false);
  });

  it('uses the latest preference selected before authentication completes', async () => {
    const { session } = setup();
    await session.connect(profile, target);
    const rfb = MockRFB.instances[0];
    session.setTransmissionScale('half');
    expect(rfb.setTransmissionScale).not.toHaveBeenCalled();
    rfb.emit('connect');
    expect(rfb.setTransmissionScale).toHaveBeenCalledExactlyOnceWith('half');
    expect(session.getSnapshot().transmissionScale.requested).toBe('half');
  });

  it('reports unexpected actual dimensions while keeping confirmation pending', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    rfb.emit('framebuffersize', { width: 2560, height: 1440 });
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'half', pending: true, width: 2560, height: 1440,
    });
    rfb.emit('framebuffersize', { width: 1920, height: 1080 });
    expect(session.getSnapshot().transmissionScale.pending).toBe(false);
  });

  it('withdraws a pending half request without mistaking its late response for confirmation', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    await vi.advanceTimersByTimeAsync(4_000);
    session.setTransmissionScale('original');
    expect(rfb.setTransmissionScale.mock.calls).toEqual([['half'], ['original']]);
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'original', pending: true, width: 3840, height: 2160,
    });
    rfb.emit('framebuffersize', { width: 1920, height: 1080 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'original', pending: true, width: 1920, height: 1080, error: undefined,
    });
    rfb.emit('framebuffersize', { width: 3840, height: 2160 });
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'original', pending: false, width: 3840, height: 2160, error: undefined,
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps the session usable after a confirmation timeout and accepts a late actual size', async () => {
    const { session, api } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', error: undefined });
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'half', pending: false, width: 3840, height: 2160,
    });
    expect(session.getSnapshot().transmissionScale.error).toContain('未收到');
    expect(api.closeTransport).not.toHaveBeenCalled();
    expect(rfb.disconnect).not.toHaveBeenCalled();
    rfb.emit('framebuffersize', { width: 1920, height: 1080 });
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      pending: false, width: 1920, height: 1080, error: undefined,
    });
  });

  it('can retry the same preference after the server did not confirm it', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    rfb.emit('connect');
    await vi.advanceTimersByTimeAsync(5_000);
    session.setTransmissionScale('half');
    expect(rfb.setTransmissionScale).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().transmissionScale).toMatchObject({ pending: true, error: undefined });
  });

  it('reports unsupported half transmission and permits restoring the original preference', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    rfb.supportsTransmissionScale = false;
    rfb.emit('connect');
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', error: undefined });
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'half', supported: false, pending: false, width: 3840, height: 2160,
    });
    expect(session.getSnapshot().transmissionScale.error).toContain('不支持');
    session.setTransmissionScale('original');
    expect(session.getSnapshot().transmissionScale).toMatchObject({
      requested: 'original', supported: false, pending: false, error: undefined,
    });
    expect(rfb.setTransmissionScale).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not leave a timer or disconnect when the adapter cannot send the request', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const rfb = MockRFB.instances[0];
    rfb.setTransmissionScale.mockReturnValue(false);
    rfb.emit('connect');
    expect(session.getSnapshot().phase).toBe('connected');
    expect(session.getSnapshot().transmissionScale.pending).toBe(false);
    expect(session.getSnapshot().transmissionScale.error).toContain('未发送');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('cleans pending confirmation on disconnect and isolates the next connection baseline', async () => {
    const { session } = setup();
    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const old = MockRFB.instances[0];
    old.emit('connect');
    session.disconnect();
    expect(session.getSnapshot().transmissionScale.pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(old.removeEventListener).toHaveBeenCalledWith('framebuffersize', expect.any(Function));

    await session.connect({ ...profile, transmissionScale: 'half' }, target);
    const next = MockRFB.instances[1];
    next.framebufferSize = { width: 2560, height: 1440 };
    next.emit('connect');
    old.emit('framebuffersize', { width: 1920, height: 1080 });
    expect(session.getSnapshot().transmissionScale).toMatchObject({ pending: true, width: 2560, height: 1440 });
    next.emit('framebuffersize', { width: 1280, height: 720 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connected', transmissionScale: {
      requested: 'half', pending: false, width: 1280, height: 720, error: undefined,
    } });
  });

  it.each([{ width: 1280, height: 720 }, { width: 1281, height: 721 }])(
    'accepts either integer rounding of an odd original size: %j', async (half) => {
      const { session } = setup();
      await session.connect({ ...profile, transmissionScale: 'half' }, target);
      const rfb = MockRFB.instances[0];
      rfb.framebufferSize = { width: 2561, height: 1441 };
      rfb.emit('connect');
      rfb.emit('framebuffersize', half);
      expect(session.getSnapshot().transmissionScale).toMatchObject({ pending: false, ...half });
    },
  );
});
