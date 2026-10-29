import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindRemoteInput } from '../src/renderer/remote-input';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const bindings: Array<{ dispose(): void }> = [];

function fixture(withKeyboard = true) {
  const keyboard = { lock: vi.fn(async () => {}), unlock: vi.fn() };
  const view = Object.assign(new EventTarget(), { navigator: withKeyboard ? { keyboard } : {} });
  const canvas = {} as Element;
  const editor = {} as Element;
  const document = Object.assign(new EventTarget(), {
    defaultView: view,
    activeElement: editor,
    fullscreenElement: null as Element | null,
    hasFocus: vi.fn(() => true),
  });
  const target = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (element: unknown) => element === canvas,
  });
  const onFocusChange = vi.fn();
  const binding = bindRemoteInput(target as unknown as HTMLElement, onFocusChange);
  bindings.push(binding);
  function focusRemote() { document.activeElement = canvas; target.dispatchEvent(new Event('focusin')); }
  async function focusLocal() {
    // activeElement is deliberately still the old element during focusout.
    target.dispatchEvent(new Event('focusout'));
    document.activeElement = editor;
    await Promise.resolve();
  }
  function fullscreen(enabled: boolean) {
    document.fullscreenElement = enabled ? canvas : null;
    document.dispatchEvent(new Event('fullscreenchange'));
  }
  return { keyboard, view, document, target, canvas, editor, onFocusChange, binding, focusRemote, focusLocal, fullscreen };
}

afterEach(() => {
  bindings.splice(0).forEach((binding) => binding.dispose());
  vi.restoreAllMocks();
});

describe('remote input focus', () => {
  it('starts local, reports remote focus, and leaves local text editing untouched', async () => {
    const f = fixture();
    expect(f.onFocusChange.mock.calls).toEqual([[false]]);
    f.focusRemote();
    expect(f.onFocusChange.mock.calls).toEqual([[false], [true]]);
    expect(f.keyboard.lock).not.toHaveBeenCalled();
    await f.focusLocal();
    expect(f.onFocusChange.mock.calls).toEqual([[false], [true], [false]]);
    expect(f.keyboard.unlock).not.toHaveBeenCalled();
  });

  it('captures system keys only while HTML fullscreen and the remote canvas are both active', async () => {
    const f = fixture();
    f.fullscreen(true);
    expect(f.keyboard.lock).not.toHaveBeenCalled();
    f.focusRemote();
    expect(f.keyboard.lock).toHaveBeenCalledOnce();
    f.target.dispatchEvent(new Event('focusin'));
    expect(f.keyboard.lock).toHaveBeenCalledOnce();
    await f.focusLocal();
    expect(f.keyboard.unlock).toHaveBeenCalledOnce();
    f.focusRemote();
    expect(f.keyboard.lock).toHaveBeenCalledTimes(2);
    f.fullscreen(false);
    expect(f.keyboard.unlock).toHaveBeenCalledTimes(2);
    expect(f.onFocusChange).toHaveBeenLastCalledWith(true);
  });

  it('releases immediately on window blur even if the DOM still reports canvas focus', () => {
    const f = fixture();
    f.fullscreen(true);
    f.focusRemote();
    f.view.dispatchEvent(new Event('blur'));
    expect(f.onFocusChange).toHaveBeenLastCalledWith(false);
    expect(f.keyboard.unlock).toHaveBeenCalledOnce();
    f.target.dispatchEvent(new Event('focusin'));
    expect(f.onFocusChange).toHaveBeenLastCalledWith(false);
    f.view.dispatchEvent(new Event('focus'));
    expect(f.onFocusChange).toHaveBeenLastCalledWith(true);
    expect(f.keyboard.lock).toHaveBeenCalledTimes(2);
  });

  it('does not capture when document.hasFocus is false and restores after focus returns', () => {
    const f = fixture();
    f.document.hasFocus.mockReturnValue(false);
    f.focusRemote();
    f.fullscreen(true);
    expect(f.onFocusChange.mock.calls).toEqual([[false]]);
    f.document.hasFocus.mockReturnValue(true);
    f.view.dispatchEvent(new Event('focus'));
    expect(f.onFocusChange).toHaveBeenLastCalledWith(true);
    expect(f.keyboard.lock).toHaveBeenCalledOnce();
  });

  it('releases for view-only mode and re-evaluates the actual focus when control resumes', async () => {
    const f = fixture();
    f.fullscreen(true);
    f.focusRemote();
    f.binding.setViewOnly(true);
    expect(f.onFocusChange).toHaveBeenLastCalledWith(false);
    expect(f.keyboard.unlock).toHaveBeenCalledOnce();
    await f.focusLocal();
    f.binding.setViewOnly(false);
    expect(f.onFocusChange).toHaveBeenLastCalledWith(false);
    expect(f.keyboard.lock).toHaveBeenCalledOnce();
    f.focusRemote();
    expect(f.keyboard.lock).toHaveBeenCalledTimes(2);
  });

  it('does not let an old lock completion or rejection release a newer lock', async () => {
    const f = fixture();
    const old = deferred();
    const current = deferred();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.keyboard.lock.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    f.fullscreen(true);
    f.focusRemote();
    await f.focusLocal();
    f.focusRemote();
    old.reject(new Error('old request cancelled'));
    current.resolve();
    await Promise.resolve();
    expect(f.keyboard.unlock).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    expect(f.onFocusChange).toHaveBeenLastCalledWith(true);
  });

  it('warns only for the current failed permission request without changing ordinary input focus', async () => {
    const f = fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.keyboard.lock.mockRejectedValueOnce(new Error('permission denied'));
    f.fullscreen(true);
    f.focusRemote();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledOnce();
    expect(f.onFocusChange).toHaveBeenLastCalledWith(true);
    expect(f.keyboard.unlock).not.toHaveBeenCalled();
  });

  it('disposes listeners, releases focus, and ignores a queued focusout or late rejection', async () => {
    const f = fixture();
    const pending = deferred();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.keyboard.lock.mockReturnValueOnce(pending.promise);
    f.fullscreen(true);
    f.focusRemote();
    f.target.dispatchEvent(new Event('focusout'));
    f.binding.dispose();
    expect(f.onFocusChange).toHaveBeenLastCalledWith(false);
    expect(f.keyboard.unlock).toHaveBeenCalledOnce();
    const count = f.onFocusChange.mock.calls.length;
    f.focusRemote();
    f.fullscreen(true);
    f.view.dispatchEvent(new Event('focus'));
    pending.reject(new Error('cancelled during disconnect'));
    await Promise.resolve();
    expect(f.onFocusChange).toHaveBeenCalledTimes(count);
    expect(f.keyboard.lock).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('continues ordinary focus routing if Keyboard Lock is unavailable', () => {
    const f = fixture(false);
    f.fullscreen(true);
    f.focusRemote();
    expect(f.onFocusChange).toHaveBeenLastCalledWith(true);
    expect(f.keyboard.lock).not.toHaveBeenCalled();
    f.binding.dispose();
    expect(f.onFocusChange).toHaveBeenLastCalledWith(false);
  });
});
