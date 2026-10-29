// Interactive real-Mac check. Credentials are entered only in the application.
import { _electron as electron } from '@playwright/test';
import path from 'node:path';

const host = process.argv[2];
const transmissionScale = process.argv[3];
if (!host || transmissionScale && !['original', 'half'].includes(transmissionScale)) {
  throw new Error('Usage: node scripts/manual-check.mjs <Mac IP or hostname> [original|half]');
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: path.resolve('out/MacLink-win32-x64/MacLink.exe'),
  args: [],
  env,
});
const page = await application.firstWindow();
await page.waitForFunction(() => Boolean(window.viewer));
const profileName = await page.evaluate(async ({ host, transmissionScale }) => {
  const settings = await window.viewer.loadSettings();
  const existing = settings.connections.find((connection) => connection.host === host);
  if (existing) {
    if (transmissionScale) await window.viewer.saveConnections(settings.connections.map((profile) =>
      profile.id === existing.id ? { ...profile, transmissionScale } : profile));
    return existing.name;
  }
  const name = `Mac · ${host}`;
  await window.viewer.saveConnections([...settings.connections, {
    id: crypto.randomUUID(), name, host, port: 5900, scale: 'fit', transmissionScale: transmissionScale ?? 'original', viewOnly: false,
  }]);
  return name;
}, { host, transmissionScale });
await page.reload();
await page.getByRole('button', { name: new RegExp(profileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
await page.getByTestId('connect').click();
console.log('Client opened. Enter credentials directly in the MacLink window.');

const observation = await Promise.race([
  page.locator('[data-session-state="connected"]').waitFor({ timeout: 10 * 60_000 }).then(() => 'connected'),
  page.locator('[data-session-state="error"]').waitFor({ timeout: 10 * 60_000 }).then(() => 'failed'),
]);
if (observation === 'connected') {
  const display = await page.locator('[data-testid="remote-screen"] canvas').evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpu, memory })));
  console.log(JSON.stringify({ status: 'connected', display, metrics }));
} else {
  console.log('Connection result:', await page.getByRole('alert').allTextContents());
}
// Keep the user's app open; close the window when finished. No screenshots or credentials are collected.
await new Promise((resolve) => application.on('close', resolve));
