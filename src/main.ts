import { app, BrowserWindow, clipboard, dialog, ipcMain, powerMonitor } from 'electron';
import path from 'node:path';
import { ConfigStore } from './main/config-store';
import { TransportManager } from './main/transport';

// An alternate data directory also lets integration tests run without touching user profiles.
if (process.env.MACLINK_DATA_DIR) app.setPath('userData', process.env.MACLINK_DATA_DIR);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window: BrowserWindow | undefined;
  let transport: TransportManager | undefined;

  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  app.whenReady().then(async () => {
    const settings = new ConfigStore(path.join(app.getPath('userData'), 'connections.json'));
    const origins = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? [new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin]
      : ['file://'];

    window = new BrowserWindow({
      title: 'MacLink',
      width: 1320,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: '#f5f6f3',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    window.removeMenu();
    let remoteFocused = false;
    let localFullscreenKey = false;
    const setRemoteFocused = (focused: boolean) => {
      remoteFocused = focused;
      window?.webContents.setIgnoreMenuShortcuts(focused);
    };

    transport = new TransportManager((event) => {
      if (!window?.isDestroyed()) window?.webContents.send('transport:event', event);
    }, origins);

    // Every privileged command is restricted to this application's top-level frame.
    const handle = (channel: string, action: (...args: any[]) => unknown) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('不允许的应用请求');
        }
        return action(...args);
      });
    };
    handle('settings:load', () => settings.load());
    handle('settings:save', (connections) => settings.save(connections));
    handle('transport:open', (target) => transport!.open(target));
    handle('transport:close', (id) => transport!.close(id));
    handle('clipboard:read', () => clipboard.readText());
    handle('clipboard:write', (text) => {
      if (typeof text !== 'string') throw new Error('剪贴板内容必须是文本');
      return clipboard.writeText(text);
    });
    ipcMain.on('window:remote-focus', (event, focused: boolean) => {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) return;
      setRemoteFocused(focused === true && window.isFocused());
    });
    handle('window:fullscreen', (enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('无效的窗口状态');
      window!.setFullScreen(enabled);
    });
    handle('app:version', () => app.getVersion());

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('before-input-event', (event, input) => {
      if (input.key !== 'F11') return;
      if (input.type === 'keyUp') {
        if (localFullscreenKey) event.preventDefault();
        localFullscreenKey = false;
        return;
      }
      if (input.isAutoRepeat) {
        if (localFullscreenKey) event.preventDefault();
        return;
      }
      if (remoteFocused || input.control || input.alt || input.meta || input.shift) return;
      event.preventDefault();
      localFullscreenKey = true;
      window!.setFullScreen(!window!.isFullScreen());
    });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const ownFrame = contents === window?.webContents && details.isMainFrame;
      callback(!!ownFrame && (permission === 'fullscreen' || (permission === 'keyboardLock' && remoteFocused)));
    });
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => {
      const ownFrame = contents === window?.webContents && details.isMainFrame;
      return !!ownFrame && (permission === 'fullscreen' || (permission === 'keyboardLock' && remoteFocused));
    });
    window.on('blur', () => { setRemoteFocused(false); localFullscreenKey = false; });
    window.on('enter-full-screen', () => window?.webContents.send('window:fullscreen-changed', true));
    window.on('leave-full-screen', () => window?.webContents.send('window:fullscreen-changed', false));
    window.on('ready-to-show', () => window?.show());
    const stopTransport = () => {
      remoteFocused = false;
      void transport!.dispose().catch((error: unknown) => console.error('Transport cleanup failed:', error));
    };
    window.webContents.on('render-process-gone', stopTransport);
    powerMonitor.on('suspend', stopTransport);
    window.on('closed', () => { stopTransport(); window = undefined; });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
  }).catch((error: unknown) => {
    dialog.showErrorBox('MacLink 启动失败', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });

  app.on('window-all-closed', () => app.quit());
}
