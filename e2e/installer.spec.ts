import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('obsolete installer event exits without starting the viewer or writing connection settings', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'maclink-installer-'));
  const env: NodeJS.ProcessEnv = { ...process.env, MACLINK_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('out/MacLink-win32-x64/MacLink.exe'), ['--squirrel-obsolete'], {
    env, windowsHide: true, stdio: 'ignore', timeout: 10_000,
  });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(exitCode).toBe(0);
    // Electron itself may create shader caches before app.quit().
    expect(await readdir(dataDirectory)).not.toContain('connections.json');
  } finally {
    // This directory is created exclusively for the test above.
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
