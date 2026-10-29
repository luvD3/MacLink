interface KeyboardLock {
  lock(): Promise<void>;
  unlock(): void;
}

interface NavigatorWithKeyboard extends Navigator {
  keyboard?: KeyboardLock;
}

/** Scope application shortcut routing and system-key capture to the remote canvas. */
export function bindRemoteInput(
  target: HTMLElement,
  onFocusChange: (focused: boolean) => void,
): { setViewOnly(value: boolean): void; dispose(): void } {
  const document = target.ownerDocument;
  const view = document.defaultView;
  const keyboard = (view?.navigator as NavigatorWithKeyboard | undefined)?.keyboard;
  let windowFocused = document.hasFocus();
  let focused = false;
  let viewOnly = false;
  let disposed = false;
  let lockRequested = false;
  let lockGeneration = 0;

  function updateLock(): void {
    const wanted = !disposed && focused && document.fullscreenElement !== null && keyboard !== undefined;
    if (wanted === lockRequested) return;
    lockRequested = wanted;
    const generation = ++lockGeneration;
    if (!keyboard) return;
    if (!wanted) {
      keyboard.unlock();
      return;
    }
    // unlock() cancels outstanding requests. Never unlock in a stale promise's
    // completion handler: another canvas focus may already own a newer lock.
    void keyboard.lock().catch((error: unknown) => {
      if (!disposed && generation === lockGeneration && lockRequested) {
        console.warn('无法捕获系统快捷键；普通按键仍会发送到远端。', error);
      }
    });
  }

  function setFocused(value: boolean): void {
    if (focused !== value) {
      focused = value;
      onFocusChange(value);
    }
    updateLock();
  }

  function refresh(): void {
    if (disposed) return;
    setFocused(!viewOnly && windowFocused && document.hasFocus() && target.contains(document.activeElement));
  }

  function focusOut(): void {
    // Browsers update activeElement at different points during focusout.
    queueMicrotask(refresh);
  }

  function windowBlur(): void {
    windowFocused = false;
    setFocused(false);
  }

  function windowFocus(): void {
    windowFocused = true;
    refresh();
  }

  target.addEventListener('focusin', refresh);
  target.addEventListener('focusout', focusOut);
  view?.addEventListener('blur', windowBlur);
  view?.addEventListener('focus', windowFocus);
  document.addEventListener('fullscreenchange', refresh);
  onFocusChange(false);
  refresh();

  return {
    setViewOnly(value: boolean): void {
      viewOnly = value;
      refresh();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('focusin', refresh);
      target.removeEventListener('focusout', focusOut);
      view?.removeEventListener('blur', windowBlur);
      view?.removeEventListener('focus', windowFocus);
      document.removeEventListener('fullscreenchange', refresh);
      setFocused(false);
    },
  };
}
