import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Handle Squirrel's short-lived setup process before normal application startup. */
export function handleInstallerEvent(event = process.argv[1]): boolean {
  if (event === '--squirrel-obsolete') {
    app.quit();
    return true;
  }

  const command = event === '--squirrel-install' || event === '--squirrel-updated'
    ? '--createShortcut'
    : event === '--squirrel-uninstall' ? '--removeShortcut' : undefined;
  if (!command) return false;

  const updater = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  const child = spawn(updater, [command, path.basename(process.execPath)], { windowsHide: true });
  // Wait for shortcut creation/removal instead of exiting after an arbitrary delay.
  child.once('error', () => app.exit(1));
  child.once('exit', (code) => app.exit(code ?? 1));
  return true;
}
