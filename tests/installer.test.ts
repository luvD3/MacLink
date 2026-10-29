import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ quit: vi.fn(), exit: vi.fn(), spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { quit: mocks.quit, exit: mocks.exit } }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { handleInstallerEvent } from '../src/main/installer';

afterEach(() => vi.resetAllMocks());

describe('Windows installer lifecycle', () => {
  it.each(['--squirrel-firstrun', '--unrelated', ''])('leaves normal startup alone: %s', (event) => {
    expect(handleInstallerEvent(event)).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  it.each([
    ['--squirrel-install', '--createShortcut'],
    ['--squirrel-updated', '--createShortcut'],
    ['--squirrel-uninstall', '--removeShortcut'],
  ])('handles %s and waits for the updater to finish', (event, command) => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    expect(handleInstallerEvent(event)).toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith(
      path.resolve(path.dirname(process.execPath), '..', 'Update.exe'),
      [command, path.basename(process.execPath)],
      { windowsHide: true },
    );
    expect(mocks.exit).not.toHaveBeenCalled();
    child.emit('exit', 0);
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it('exits obsolete versions without touching shortcuts', () => {
    expect(handleInstallerEvent('--squirrel-obsolete')).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it('exits with failure if the updater cannot start', () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    expect(handleInstallerEvent('--squirrel-install')).toBe(true);
    child.emit('error', new Error('Updater missing'));
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });

  it('preserves an updater failure exit code', () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    handleInstallerEvent('--squirrel-uninstall');
    child.emit('exit', 2);
    expect(mocks.exit).toHaveBeenCalledWith(2);
  });
});
