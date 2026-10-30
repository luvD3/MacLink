import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startVncServer } from './rfb-server';
import { createZrleFixture } from '../tests/fixtures/zrle';

let application: ElectronApplication;
let page: Page;
let dataDirectory: string;
let servers: Awaited<ReturnType<typeof startVncServer>>[];
let rendererErrors: string[];

async function launch(extraArgs: string[] = []) {
  const env = { ...process.env, MACLINK_DATA_DIR: dataDirectory } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: path.resolve('out/MacLink-win32-x64/MacLink.exe'), args: extraArgs, env });
  page = await application.firstWindow();
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    // Keep the user's clipboard inside this process, never in test output.
    const items = await clipboard.read();
    (globalThis as unknown as { originalClipboard: Electron.ClipboardItem[] }).originalClipboard = await Promise.all(items.map(async item =>
      new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))),
    ));
  });
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('Renderer:', message.text().replace(/\/session\/[a-f0-9]+/g, '/session/[redacted]'));
    if (message.type() === 'warning' && message.text().includes('无法捕获系统快捷键')) rendererErrors.push(message.text());
  });
  await expect(page.getByTestId('new-connection')).toBeEnabled();
}

async function addConnection(port: number, name = '测试 Mac') {
  await page.getByTestId('new-connection').click();
  await page.getByTestId('connection-name').fill(name);
  await page.getByTestId('connection-host').fill('127.0.0.1');
  await page.getByTestId('connection-port').fill(String(port));
  await page.getByTestId('save-connection').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function revealControls() {
  const size = await page.evaluate(() => ({ width: innerWidth }));
  await page.mouse.move(size.width / 2, 2);
  await expect(page.locator('.toolbar')).toHaveCSS('opacity', '1');
}

async function pauseClipboardBeforeConnecting() {
  // The coordinate tests exercise actual input and rendering, without reading
  // or changing the user's text clipboard when the test session connects.
  await page.evaluate(() => {
    type Session = { setClipboardSync(enabled: boolean): void };
    type Fiber = { memoizedState?: { memoizedState?: Session }; return?: Fiber };
    const shell = document.querySelector('.app-shell')!;
    let fiber = (shell as unknown as Record<string, Fiber>)[Object.keys(shell).find(key => key.startsWith('__reactFiber$'))!];
    while (fiber) {
      const session = fiber.memoizedState?.memoizedState;
      if (typeof session?.setClipboardSync === 'function') { session.setClipboardSync(false); return; }
      fiber = fiber.return!;
    }
    throw new Error('No actual packaged viewer session');
  });
}

test.beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), 'maclink-e2e-'));
  servers = [];
  rendererErrors = [];
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
    console.log('Visible errors:', await page.getByRole('alert').allTextContents());
    await page.screenshot({ path: testInfo.outputPath('failure.png') });
  }
  if (application && page && !page.isClosed()) {
    if (await page.locator('[data-session-state="connected"]').count()) {
      await page.getByTestId('disconnect').evaluate(button => (button as HTMLButtonElement).click());
    }
    await application.evaluate(async ({ clipboard }) => {
      const items = (globalThis as unknown as { originalClipboard?: Electron.ClipboardItem[] }).originalClipboard;
      if (items?.length) await clipboard.write(items);
      else if (items) clipboard.clear();
    });
  }
  await application?.close();
  for (const server of servers) await server.close();
  // This path is the dedicated directory returned by mkdtemp above.
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  expect(rendererErrors).toEqual([]);
});

test('connection editing survives restart and deletion is explicit', async ({}, testInfo) => {
  await launch(['--squirrel-firstrun']);
  await page.screenshot({ path: testInfo.outputPath('welcome.png') });
  await addConnection(5900, '书房的 Mac');
  await page.getByRole('button', { name: '编辑 书房的 Mac', exact: true }).click();
  await page.getByTestId('connection-name').fill('工作室 Mac');
  await page.getByTestId('save-connection').click();
  await expect(page.getByRole('heading', { name: '工作室 Mac', exact: true })).toBeVisible();
  const saved = JSON.parse(await readFile(path.join(dataDirectory, 'connections.json'), 'utf8'));
  expect(saved).toMatchObject({ version: 1, connections: [{ name: '工作室 Mac', port: 5900 }] });
  expect(JSON.stringify(saved)).not.toMatch(/password|credential/i);
  await application.close();
  await launch();
  await expect(page.getByRole('heading', { name: '工作室 Mac', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除 工作室 Mac', exact: true }).click();
  await page.getByRole('button', { name: '删除连接', exact: true }).click();
  await expect(page.getByText('还没有保存的连接')).toBeVisible();
});

test('real noVNC renders 1080p, routes focused shortcuts, and releases connections', async ({}, testInfo) => {
  const server = await startVncServer();
  servers.push(server);
  await launch();
  await page.evaluate(() => {
    const keyboard = (navigator as Navigator & { keyboard: { lock(): Promise<void> } }).keyboard;
    const lock = keyboard.lock.bind(keyboard);
    const state = window as Window & { keyboardLockResults?: string[] };
    state.keyboardLockResults = [];
    keyboard.lock = () => {
      const result = lock();
      void result.then(() => state.keyboardLockResults!.push('locked'), () => state.keyboardLockResults!.push('failed'));
      return result;
    };
  });
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.workspace-header')).toBeHidden();
  await expect(page.locator('.statusbar')).toBeHidden();
  const viewport = await page.getByTestId('remote-screen').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(viewport).toMatchObject({ x: 0, y: 0 });
  // Browser inner dimensions are integer CSS pixels; 150% DPI layout can be fractional.
  expect(Math.abs(viewport.width - viewport.viewportWidth)).toBeLessThan(1);
  expect(Math.abs(viewport.height - viewport.viewportHeight)).toBeLessThan(1);
  await page.keyboard.press('F8');
  await expect(page.getByTestId('session-toolbar')).toHaveCSS('opacity', '1');
  await page.keyboard.press('F8');
  await expect(page.getByTestId('session-toolbar')).toHaveCSS('opacity', '0');
  const canvas = page.getByTestId('remote-screen').locator('canvas');
  await expect(canvas).toHaveAttribute('width', '1920');
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[3])).toBe(255);
  await page.screenshot({ path: testInfo.outputPath('connected.png') });

  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await canvas.evaluate(element => getComputedStyle(element).cursor !== 'none' || [...document.querySelectorAll('canvas')].some(cursor => {
    const style = getComputedStyle(cursor);
    return cursor !== element && style.position === 'fixed' && style.visibility === 'visible' && cursor.width > 0;
  }))).toBe(true);
  await page.keyboard.press('a');
  await expect.poll(() => server.keys.some((key) => key.key === 97 && key.down)).toBe(true);
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-remote-focused', 'true');
  await page.keyboard.press('F8');
  await expect.poll(() => server.keys.slice(-2)).toEqual([{ down: true, key: 0xffc5 }, { down: false, key: 0xffc5 }]);
  await expect(page.getByTestId('session-toolbar')).toHaveCSS('opacity', '0');
  await expect.poll(() => server.pointers.some((event) => Math.abs(event.x - 960) <= 2 && Math.abs(event.y - 540) <= 2)).toBe(true);
  await revealControls();
  await page.getByLabel('Mac 快捷键', { exact: true }).click();
  await page.getByTestId('shortcut-copy').click();
  await expect.poll(() => server.keys.slice(-4)).toEqual([
    { down: true, key: 0xffe9 }, { down: true, key: 99 },
    { down: false, key: 99 }, { down: false, key: 0xffe9 },
  ]);

  await canvas.click();
  await page.keyboard.down('Shift');
  await expect.poll(() => server.keys.at(-1)).toEqual({ down: true, key: 0xffe1 });
  await revealControls();
  await page.getByTestId('clipboard-toggle').click();
  await expect.poll(() => server.keys.at(-1)).toEqual({ down: false, key: 0xffe1 });
  await page.keyboard.up('Shift');
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-remote-focused', 'false');
  await page.getByRole('button', { name: '关闭剪贴板', exact: true }).click();

  await revealControls();
  await page.getByTestId('scale-actual').click();
  await expect(page.getByTestId('scale-actual')).toHaveAttribute('aria-pressed', 'true');
  await revealControls();
  await page.getByTestId('scale-fit').click();
  await revealControls();
  await page.getByTestId('fullscreen-toggle').click();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-remote-focused', 'true');
  await expect.poll(() => page.evaluate(() => (window as Window & { keyboardLockResults?: string[] }).keyboardLockResults)).toEqual(['locked']);
  const screenBounds = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { window: window.getBounds(), display: screen.getDisplayMatching(window.getBounds()).bounds };
  });
  expect(screenBounds.window).toEqual(screenBounds.display);
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
  });
  await expect.poll(() => server.keys.slice(-2)).toEqual([{ down: true, key: 0xffc8 }, { down: false, key: 0xffc8 }]);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await revealControls();
  await page.getByTestId('fullscreen-toggle').click();
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
  await revealControls();
  await page.getByTestId('disconnect').click();
  await expect.poll(() => server.connections).toBe(0);
  for (let i = 0; i < 20; i++) {
    await page.getByTestId('connect').click();
    await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
    await revealControls();
    await page.getByTestId('disconnect').click();
    await expect.poll(() => server.connections).toBe(0);
  }
});

test('text clipboard synchronizes both ways without echo, pauses and stops on disconnect', async () => {
  const server = await startVncServer();
  servers.push(server);
  await launch();
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  await revealControls();
  await page.getByTestId('clipboard-toggle').click();
  await expect(page.getByText('已收到远端文本。', { exact: true })).toBeVisible();
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Hello from the test Mac');
  expect(server.clipboard).toEqual([]);
  await application.evaluate(({ clipboard }) => clipboard.writeText('Windows copy 1'));
  await expect.poll(() => server.clipboard).toEqual(['Windows copy 1']);
  server.sendClipboard('Mac copy 2');
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Mac copy 2');
  // Wait for another local poll by sending the next local value; a remote echo
  // would appear in this exact list before it.
  await application.evaluate(({ clipboard }) => clipboard.writeText('Windows copy 3'));
  await expect.poll(() => server.clipboard).toEqual(['Windows copy 1', 'Windows copy 3']);
  await expect(page.getByTestId('clipboard-sync-toggle')).toBeChecked();
  await expect(page.getByTestId('clipboard-send')).toHaveCount(0);
  await expect(page.getByTestId('clipboard-copy')).toHaveCount(0);
  await application.evaluate(({ clipboard }) => clipboard.writeText('中文测试'));
  await expect(page.getByText(/未发送：当前版本仅发送 Latin-1/)).toBeVisible();
  expect(server.clipboard).toEqual(['Windows copy 1', 'Windows copy 3']);
  await page.getByTestId('clipboard-sync-toggle').uncheck();
  server.sendClipboard('Ignored remote copy');
  await expect(page.getByText('已收到远端文本，自动同步已暂停。')).toBeVisible();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe('中文测试');
  await page.getByTestId('clipboard-sync-toggle').check();
  server.sendClipboard('Mac copy after resume');
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('Mac copy after resume');
  await page.getByRole('button', { name: '关闭剪贴板', exact: true }).click();
  await revealControls();
  await page.getByTestId('disconnect').click();
  await application.evaluate(({ clipboard }) => clipboard.writeText('Local after disconnect'));
  await expect.poll(() => server.connections).toBe(0);
  expect(server.clipboard).toEqual(['Windows copy 1', 'Windows copy 3']);
});

test('remote I-beam and arrow shapes update after typing on the touch cursor path', async () => {
  const server = await startVncServer();
  servers.push(server);
  await launch(['--touch-events=enabled']);
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  const canvas = page.getByTestId('remote-screen').locator('canvas');
  await canvas.click();
  const cursor = page.locator('body > canvas');
  await expect(cursor).toHaveCount(1);
  server.sendCursor('ibeam');
  await expect(cursor).toHaveAttribute('width', '9');
  await expect(cursor).toHaveAttribute('height', '18');
  await page.keyboard.type('testing');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  server.sendCursor('arrow');
  await expect(cursor).toHaveAttribute('width', '17');
  await expect(cursor).toHaveAttribute('height', '23');
  await expect(cursor).toHaveCSS('visibility', 'visible');
  expect(await cursor.evaluate(element => getComputedStyle(element).display)).not.toBe('none');
  await revealControls();
  await page.getByTestId('disconnect').click();
  await expect(cursor).toHaveCount(0);
});

test('VNC password handshake succeeds and credentials are not persisted', async ({}, testInfo) => {
  const server = await startVncServer({ password: 'testpass' });
  servers.push(server);
  await launch();
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('auth-password')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('authentication.png') });
  await page.getByTestId('auth-password').fill('testpass');
  await page.getByTestId('auth-submit').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  expect(server.authenticated).toBe(1);
  expect(await readFile(path.join(dataDirectory, 'connections.json'), 'utf8')).not.toContain('testpass');
  server.disconnect();
  await expect(page.getByRole('alert').filter({ hasText: '远端连接已断开' })).toBeVisible();
});

test('wrong password is reported as authentication failure', async () => {
  const server = await startVncServer({ password: 'testpass' });
  servers.push(server);
  await launch();
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await page.getByTestId('auth-password').fill('wrong');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByRole('alert').filter({ hasText: '认证未通过' })).toBeVisible();
  await expect.poll(() => server.connections).toBe(0);
});

test('cancel a stalled handshake and reconnect without retaining sockets', async () => {
  const server = await startVncServer({ stall: true });
  servers.push(server);
  await launch();
  await addConnection(server.port);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('connect').click();
    await expect.poll(() => server.connections).toBe(1);
    await page.getByTestId('cancel-connect').click();
    await expect.poll(() => server.connections).toBe(0);
  }
});

test('4K desktop pointer coordinates stay correct with Windows scale factor 1.5', async () => {
  const server = await startVncServer({ width: 3840, height: 2160 });
  servers.push(server);
  await launch(['--force-device-scale-factor=1.5']);
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  const canvas = page.getByTestId('remote-screen').locator('canvas');
  await expect(canvas).toHaveAttribute('width', '3840');
  await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[3])).toBe(255);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => server.pointers.some((event) => Math.abs(event.x - 1920) <= 4 && Math.abs(event.y - 1080) <= 4)).toBe(true);
});

for (const dpi of [1, 1.5]) {
  test(`Apple half-size transmission preserves native pointer coordinates at Windows scale ${dpi}`, async () => {
    test.setTimeout(60_000);
    const server = await startVncServer({ width: 3840, height: 2160, appleScaling: true, frameHeaderDelayMs: 35, clipboardText: null });
    servers.push(server);
    await launch([`--force-device-scale-factor=${dpi}`]);
    await pauseClipboardBeforeConnecting();
    expect(await page.evaluate(() => devicePixelRatio)).toBe(dpi);
    await addConnection(server.port);
    await page.getByTestId('connect').click();
    const canvas = () => page.getByTestId('remote-screen').locator('canvas');
    const expectFramebuffer = async (width: number, height: number) => {
      await expect(canvas()).toHaveAttribute('width', String(width));
      await expect(canvas()).toHaveAttribute('height', String(height));
      await expect(page.getByTestId('transmission-status')).toHaveText(`${width} × ${height}`);
      // The gradient's far corner changes after a resize, proving that the
      // new complete frame arrived, not just a DesktopSize announcement.
      await expect.poll(() => canvas().evaluate(element => {
        const target = element as HTMLCanvasElement;
        return [...target.getContext('2d')!.getImageData(target.width - 1, target.height - 1, 1, 1).data];
      })).toEqual([90, 179, 69, 255]);
    };
    const checkPoints = async (mode: 'fit' | 'actual', points: number[][]) => {
      await revealControls();
      await page.getByTestId(`scale-${mode}`).click();
      await expect(page.getByTestId(`scale-${mode}`)).toHaveAttribute('aria-pressed', 'true');
      if (mode === 'actual') {
        await expect.poll(() => canvas().evaluate(element => Math.abs(element.getBoundingClientRect().width - (element as HTMLCanvasElement).width))).toBeLessThan(1);
      }
      for (const [fx, fy] of points) {
        const point = await canvas().evaluate((element, { fx, fy, mode, nativeWidth }) => {
          const target = element as HTMLCanvasElement;
          const screen = target.parentElement!;
          if (mode === 'actual') {
            screen.scrollLeft = target.width * fx - screen.clientWidth / 2;
            screen.scrollTop = target.height * fy - screen.clientHeight / 2;
          }
          const bounds = target.getBoundingClientRect();
          const x = bounds.x + bounds.width * fx, y = bounds.y + bounds.height * fy;
          return { x, y, hitCanvas: document.elementFromPoint(x, y) === target, tolerance: Math.ceil(nativeWidth / bounds.width) + 1 };
        }, { fx, fy, mode, nativeWidth: server.nativeWidth });
        expect(point.hitCanvas).toBe(true);
        const before = server.pointers.length;
        await page.mouse.click(point.x, point.y);
        await expect.poll(() => {
          const events = server.pointers.slice(before);
          const down = events.findIndex(event => event.buttons === 1);
          return down < 0 ? [] : events.slice(down).map(event => event.buttons);
        }).toEqual([1, 0]);
        const events = server.pointers.slice(before);
        const down = events.find(event => event.buttons === 1)!;
        expect(Math.abs(down.x - server.nativeWidth * fx)).toBeLessThanOrEqual(point.tolerance);
        expect(Math.abs(down.y - server.nativeHeight * fy)).toBeLessThanOrEqual(point.tolerance);
        expect(events.at(-1)).toEqual({ ...down, buttons: 0 });
      }
    };

    await expectFramebuffer(3840, 2160);
    // Focus is still local after connecting. F8 pins focus in the toolbar
    // while the first full frame settles; later interactions use edge hover.
    await page.keyboard.press('F8');
    await expect(page.getByTestId('session-toolbar')).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('transmission-scale')).toBeEnabled();
    await page.getByTestId('transmission-scale').selectOption('half');
    await expectFramebuffer(1920, 1080);
    expect(server.scales).toEqual([0.5]);
    const points = [[.1, .15], [.85, .2], [.5, .5], [.2, .8], [.9, .85]];
    await checkPoints('fit', points);
    await checkPoints('actual', points);

    await revealControls();
    await page.getByTestId('transmission-scale').selectOption('original');
    await expectFramebuffer(3840, 2160);
    expect(server.scales).toEqual([0.5, 1]);
    await checkPoints('fit', [[.5, .5], [.85, .8]]);
    await revealControls();
    await page.getByTestId('transmission-scale').selectOption('half');
    await expectFramebuffer(1920, 1080);
    await expect.poll(async () => JSON.parse(await readFile(path.join(dataDirectory, 'connections.json'), 'utf8')).connections[0].transmissionScale).toBe('half');
    await page.getByTestId('disconnect').click();
    await expect.poll(() => server.connections).toBe(0);
    await application.close();

    await launch([`--force-device-scale-factor=${dpi}`]);
    await pauseClipboardBeforeConnecting();
    await page.getByRole('button', { name: '编辑 测试 Mac', exact: true }).click();
    await expect(page.getByTestId('connection-transmission-half')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByTestId('connect').click();
    await expectFramebuffer(1920, 1080);
    await checkPoints('fit', [[.75, .7]]);
    expect(server.scales).toEqual([0.5, 1, 0.5, 0.5]);
    expect(server.versions).toEqual(['RFB 003.008\n', 'RFB 003.008\n']);
    expect(server.clipboard).toEqual([]);
    expect([server.nativeWidth, server.nativeHeight]).toEqual([3840, 2160]);
  });
}

test('wheel distance survives coalescing and half-size transmission at 150% DPI', async () => {
  const server = await startVncServer({ width: 3840, height: 2160, appleScaling: true, clipboardText: null });
  servers.push(server);
  await launch(['--force-device-scale-factor=1.5']);
  await pauseClipboardBeforeConnecting();
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  const canvas = page.getByTestId('remote-screen').locator('canvas');
  await expect(canvas).toHaveAttribute('width', '3840');

  const wheelBatch = async (deltas: number[][], masks: number[], actual = false, heldButtons = 0) => {
    const before = server.pointers.length;
    const point = await canvas.evaluate((element, { deltas, actual, heldButtons }) => {
      const target = element as HTMLCanvasElement, screen = target.parentElement!;
      if (actual) {
        screen.scrollLeft = target.width * .73 - screen.clientWidth / 2;
        screen.scrollTop = target.height * .62 - screen.clientHeight / 2;
      }
      const bounds = target.getBoundingClientRect();
      const clientX = bounds.x + bounds.width * .73, clientY = bounds.y + bounds.height * .62;
      for (const [deltaX, deltaY] of deltas) target.dispatchEvent(new WheelEvent('wheel', {
        clientX, clientY, deltaX, deltaY, deltaMode: 0, buttons: heldButtons, bubbles: true, cancelable: true,
      }));
      return { hitCanvas: document.elementFromPoint(clientX, clientY) === target, tolerance: Math.ceil(3840 / bounds.width) + 1 };
    }, { deltas, actual, heldButtons });
    expect(point.hitCanvas).toBe(true);
    await expect.poll(() => server.pointers.slice(before).map(event => event.buttons)).toEqual(masks);
    for (const event of server.pointers.slice(before)) {
      expect(Math.abs(event.x - 3840 * .73)).toBeLessThanOrEqual(point.tolerance);
      expect(Math.abs(event.y - 2160 * .62)).toBeLessThanOrEqual(point.tolerance);
    }
  };
  const pairs = (button: number, count: number, held = 0) => Array.from({ length: count }, () => [button | held, held]).flat();

  await wheelBatch([[0, 300]], pairs(16, 6));
  await wheelBatch(Array.from({ length: 5 }, () => [0, -120]), pairs(8, 12));
  await wheelBatch(Array.from({ length: 10 }, () => [0, 5]), pairs(16, 1));
  await wheelBatch([[-100, 150]], [...pairs(32, 2), ...pairs(16, 3)]);
  await wheelBatch([[0, 100]], pairs(16, 2, 4), false, 2); // DOM right button maps to RFB mask 4.
  await canvas.dispatchEvent('mouseup', { button: 2, buttons: 0 });
  await expect.poll(() => server.pointers.at(-1)?.buttons).toBe(0);

  await page.keyboard.press('F8');
  await expect(page.getByTestId('session-toolbar')).toHaveCSS('opacity', '1');
  await page.getByTestId('transmission-scale').selectOption('half');
  await expect(canvas).toHaveAttribute('width', '1920');
  await expect(page.getByTestId('transmission-status')).toHaveText('1920 × 1080');
  await wheelBatch([[0, 300]], pairs(16, 6));
  await revealControls();
  await page.getByTestId('scale-actual').click();
  await expect.poll(() => canvas.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(1920);
  await wheelBatch([[0, -300]], pairs(8, 6), true);

  await revealControls();
  await page.locator('.toolbar-view-only input').check();
  const beforeViewOnly = server.pointers.filter(event => event.buttons & 120).length;
  await canvas.dispatchEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true });
  await page.locator('.toolbar-view-only input').uncheck();
  // Wait for a subsequent wheel command over the same ordered TCP connection.
  await wheelBatch([[0, 50]], pairs(16, 1), true);
  expect(server.pointers.filter(event => event.buttons & 120).length - beforeViewOnly).toBe(1);
});

test('pending drag sends the final scaled position before release and is cancelled on disconnect', async () => {
  const server = await startVncServer({ width: 3840, height: 2160 });
  servers.push(server);
  await launch(['--force-device-scale-factor=1.5']);
  await addConnection(server.port);
  await page.getByTestId('connect').click();
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
  const canvas = page.getByTestId('remote-screen').locator('canvas');
  await expect(canvas).toHaveAttribute('width', '3840');
  await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[3])).toBe(255);

  const gesture = (action: 'release' | 'disconnect') => page.evaluate(action => {
    type ActualRfb = { _mouseMoveTimer: number | null; _mouseLastMoveTime: number };
    type Fiber = { memoizedState?: { memoizedState?: { active?: { rfb?: ActualRfb } } }; return?: Fiber };
    const shell = document.querySelector('.app-shell')!;
    let fiber = (shell as unknown as Record<string, Fiber>)[Object.keys(shell).find(key => key.startsWith('__reactFiber$'))!];
    let rfb: ActualRfb | undefined;
    while (fiber && !rfb) { rfb = fiber.memoizedState?.memoizedState?.active?.rfb; fiber = fiber.return!; }
    if (!rfb) throw new Error('No actual packaged RFB session');
    const target = document.querySelector('[data-testid="remote-screen"] canvas') as HTMLCanvasElement;
    const box = target.getBoundingClientRect();
    const dispatch = (type: string, x: number, y: number, buttons: number) => {
      const receiver = type === 'mousedown' || buttons === 0 && type === 'mousemove' ? target
        : document.getElementById('noVNC_mouse_capture_elem') ?? target;
      receiver.dispatchEvent(new MouseEvent(type, { clientX: box.x + box.width * x, clientY: box.y + box.height * y,
        button: 0, buttons, bubbles: true, cancelable: true }));
    };
    const originalNow = Date.now, originalClear = window.clearTimeout;
    const tick = Math.max(originalNow(), rfb._mouseLastMoveTime + 100);
    let pending: number | null = null, cancelled = false;
    // Freeze only this synchronous task: the real noVNC handlers and timer are
    // used, without depending on a loaded renderer completing within 8 ms.
    Date.now = () => tick;
    window.clearTimeout = id => { if (id === pending) cancelled = true; originalClear(id); };
    try {
      dispatch('mousemove', .25, .4, 0);
      dispatch('mousedown', .25, .4, 1);
      dispatch('mousemove', .4, .55, 1);
      dispatch('mousemove', .625, .65, 1);
      pending = rfb._mouseMoveTimer;
      if (action === 'release') dispatch('mouseup', .625, .65, 0);
      else {
        (document.querySelector('[data-testid="disconnect"]') as HTMLButtonElement).click();
        // Release the DOM capture after the normal UI has removed noVNC's
        // handlers. This must not send another pointer event after disconnect.
        dispatch('mouseup', .625, .65, 0);
      }
      return { hadPending: pending !== null, cancelled, pendingAfter: rfb._mouseMoveTimer !== null,
        expectedX: target.width * .625, expectedY: target.height * .65 };
    } finally { Date.now = originalNow; window.clearTimeout = originalClear; }
  }, action);

  const firstPointer = server.pointers.length;
  const release = await gesture('release');
  expect(release).toMatchObject({ hadPending: true, cancelled: true, pendingAfter: false });
  await expect.poll(() => server.pointers.slice(firstPointer).length).toBe(4);
  const released = server.pointers.slice(firstPointer);
  expect(released.map(event => event.buttons)).toEqual([0, 1, 1, 0]);
  expect(released[2]).toEqual({ ...released[3], buttons: 1 });
  expect(Math.abs(released[3].x - release.expectedX)).toBeLessThanOrEqual(3);
  expect(Math.abs(released[3].y - release.expectedY)).toBeLessThanOrEqual(3);
  await page.waitForTimeout(40);
  expect(server.pointers.slice(firstPointer)).toEqual(released);

  const disconnect = await gesture('disconnect');
  // Upstream clears the timeout without nulling its stored numeric handle.
  expect(disconnect).toMatchObject({ hadPending: true, cancelled: true });
  await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'disconnected');
  await expect.poll(() => server.connections).toBe(0);
  const afterDisconnect = [...server.pointers];
  await page.waitForTimeout(40);
  expect(server.pointers).toEqual(afterDisconnect);
});

test('packaged WASM pipelines fragmented 4K ZRLE frames with exact pixels across reconnects', async () => {
  const frames = await createZrleFixture({ width: 3840, height: 2160, frames: 3 });
  const expected = createHash('sha256').update(frames.at(-1)!.expectedRgba).digest('hex');
  const server = await startVncServer({ width: 3840, height: 2160, zrleFrames: frames, frameHeaderDelayMs: 150 });
  servers.push(server);
  await launch();
  await addConnection(server.port);
  for (let connection = 1; connection <= 3; connection++) {
    const earlyRequestsBefore = server.requestsWhileFrameSending;
    await page.getByTestId('connect').click();
    await expect(page.locator('[data-session-state]')).toHaveAttribute('data-session-state', 'connected');
    await expect(page.getByTestId('remote-screen')).toHaveAttribute('data-decoder', 'wasm');
    // The attribute changes only after WasmInflator's constructor succeeds,
    // so this catches duplicate module IDs, not just WASM compilation failures.
    await expect.poll(() => server.framebufferRequests).toBe(connection * 4);
    // Prove prefetch happens on every connection. Some later headers can arrive
    // while the renderer is still busy, so not every request must beat the timer.
    expect(server.requestsWhileFrameSending).toBeGreaterThan(earlyRequestsBefore);
    await expect.poll(() => page.getByTestId('remote-screen').locator('canvas').evaluate(async element => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
      return [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
    })).toBe(expected);
    await revealControls();
    await page.getByTestId('disconnect').click();
    await expect.poll(() => server.connections).toBe(0);
  }
});

test('corrupt configuration is preserved and disables writes', async () => {
  const filename = path.join(dataDirectory, 'connections.json');
  await writeFile(filename, '{broken');
  const env = { ...process.env, MACLINK_DATA_DIR: dataDirectory } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: path.resolve('out/MacLink-win32-x64/MacLink.exe'), args: [], env });
  page = await application.firstWindow();
  await expect(page.getByRole('alert')).toContainText('配置未被覆盖');
  await expect(page.getByTestId('new-connection')).toBeDisabled();
  expect(await readFile(filename, 'utf8')).toBe('{broken');
});
