import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardSync } from '../src/renderer/clipboard-sync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const watchers: ClipboardSync[] = [];

function fixture(initial = 'existing local text') {
  let localText = initial;
  const port = {
    readClipboard: vi.fn(async () => localText),
    writeClipboard: vi.fn(async (text: string) => { localText = text; }),
  };
  const send = vi.fn();
  const reportError = vi.fn();
  const start = () => {
    const sync = new ClipboardSync(port, send, reportError);
    watchers.push(sync);
    return sync;
  };
  return { port, send, reportError, start, copyLocal: (text: string) => { localText = text; }, readLocal: () => localText };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  watchers.splice(0).forEach((watcher) => watcher.dispose());
  vi.useRealTimers();
});

describe('ClipboardSync', () => {
  it('establishes a baseline without uploading it, then sends a new local copy once', async () => {
    const f = fixture();
    f.start();
    await settle();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.port.writeClipboard).not.toHaveBeenCalled();
    f.copyLocal('new local copy');
    await vi.advanceTimersByTimeAsync(250);
    expect(f.send.mock.calls).toEqual([['new local copy']]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.send).toHaveBeenCalledOnce();
  });

  it('applies remote text without echo when Windows normalizes LF to CRLF', async () => {
    const f = fixture();
    f.port.writeClipboard.mockImplementation(async (text) => f.copyLocal(text.replace(/\r?\n/g, '\r\n')));
    const sync = f.start();
    await settle();
    sync.receive('Mac line one\nMac line two');
    await settle();
    expect(f.readLocal()).toBe('Mac line one\r\nMac line two');
    await vi.advanceTimersByTimeAsync(500);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.port.writeClipboard).toHaveBeenCalledOnce();
  });

  it('applies a fresh remote copy even if it matches an older cached observation', async () => {
    const f = fixture('same text');
    const sync = f.start();
    await settle();
    f.copyLocal('local text changed between polls');
    sync.receive('same text');
    await settle();
    expect(f.readLocal()).toBe('same text');
    expect(f.port.writeClipboard).toHaveBeenCalledWith('same text');
    await vi.advanceTimersByTimeAsync(250);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('orders a remote write after an in-flight read and does not upload that stale local result', async () => {
    const f = fixture('baseline');
    const sync = f.start();
    await settle();
    const read = deferred<string>();
    f.port.readClipboard.mockImplementationOnce(() => read.promise);
    f.copyLocal('older local copy');
    sync.refresh();
    await settle();
    sync.receive('newer remote copy');
    await settle();
    expect(f.port.writeClipboard).not.toHaveBeenCalled();
    read.resolve('older local copy');
    await settle();
    expect(f.port.writeClipboard).toHaveBeenCalledWith('newer remote copy');
    expect(f.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps only one outstanding read when refreshes and timer ticks overlap', async () => {
    const f = fixture();
    const read = deferred<string>();
    f.port.readClipboard.mockImplementationOnce(() => read.promise);
    const sync = f.start();
    await settle();
    sync.refresh();
    sync.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.port.readClipboard).toHaveBeenCalledOnce();
    read.resolve('initial snapshot');
    await settle();
    expect(f.send).not.toHaveBeenCalled();
  });

  it('serializes rapid remote copies so the latest copy wins even with a slow write', async () => {
    const f = fixture();
    const sync = f.start();
    await settle();
    const firstWrite = deferred<void>();
    f.port.writeClipboard.mockImplementationOnce(async (text) => { await firstWrite.promise; f.copyLocal(text); });
    sync.receive('first');
    await settle();
    sync.receive('second');
    sync.receive('latest');
    sync.refresh();
    await settle();
    expect(f.port.writeClipboard.mock.calls).toEqual([['first']]);
    firstWrite.resolve();
    await settle();
    expect(f.port.writeClipboard.mock.calls).toEqual([['first'], ['second'], ['latest']]);
    expect(f.readLocal()).toBe('latest');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('does not clear either clipboard for empty or file-only text snapshots', async () => {
    const f = fixture('keep this');
    const sync = f.start();
    await settle();
    sync.receive('');
    await settle();
    expect(f.port.writeClipboard).not.toHaveBeenCalled();
    expect(f.readLocal()).toBe('keep this');
    f.copyLocal('');
    await vi.advanceTimersByTimeAsync(250);
    expect(f.send).not.toHaveBeenCalled();
    f.copyLocal('keep this');
    await vi.advanceTimersByTimeAsync(250);
    expect(f.send.mock.calls).toEqual([['keep this']]);
  });

  it('discards pending reads and queued remote writes after disposal', async () => {
    const f = fixture();
    const read = deferred<string>();
    f.port.readClipboard.mockImplementationOnce(() => read.promise);
    const sync = f.start();
    await settle();
    sync.receive('queued remote text');
    sync.dispose();
    read.resolve('pending local text');
    await settle();
    sync.refresh();
    sync.receive('later remote text');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.port.readClipboard).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.port.writeClipboard).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'] as const)('stops and reports only once after a clipboard %s failure', async (failure) => {
    const f = fixture();
    const sync = f.start();
    await settle();
    if (failure === 'read') {
      f.port.readClipboard.mockRejectedValueOnce(new Error('clipboard busy'));
      sync.refresh();
    } else {
      f.port.writeClipboard.mockRejectedValueOnce(new Error('clipboard busy'));
      sync.receive('incoming copy');
    }
    await settle();
    expect(f.reportError).toHaveBeenCalledOnce();
    const reads = f.port.readClipboard.mock.calls.length;
    const writes = f.port.writeClipboard.mock.calls.length;
    sync.refresh();
    sync.receive('ignored after failure');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.port.readClipboard).toHaveBeenCalledTimes(reads);
    expect(f.port.writeClipboard).toHaveBeenCalledTimes(writes);
    expect(f.reportError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
