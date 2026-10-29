import { contextBridge, ipcRenderer } from 'electron';
import type { TransportEvent, ViewerApi } from './shared/types';

const api: ViewerApi = {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveConnections: (connections) => ipcRenderer.invoke('settings:save', connections),
  openTransport: (target) => ipcRenderer.invoke('transport:open', target),
  closeTransport: (id) => ipcRenderer.invoke('transport:close', id),
  onTransportEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TransportEvent) => listener(value);
    ipcRenderer.on('transport:event', handler);
    return () => ipcRenderer.removeListener('transport:event', handler);
  },
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  setRemoteFocused: (focused) => ipcRenderer.send('window:remote-focus', focused),
  setFullscreen: (enabled) => ipcRenderer.invoke('window:fullscreen', enabled),
  onFullscreenChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, enabled: boolean) => listener(enabled);
    ipcRenderer.on('window:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', handler);
  },
  getVersion: () => ipcRenderer.invoke('app:version'),
};

contextBridge.exposeInMainWorld('viewer', api);
