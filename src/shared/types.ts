export type ScaleMode = 'fit' | 'actual';
export type TransmissionScale = 'original' | 'half';

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  scale: ScaleMode;
  transmissionScale: TransmissionScale;
  viewOnly: boolean;
}

export interface Settings {
  version: 1;
  connections: ConnectionProfile[];
}

export type ErrorCode = 'invalid-address' | 'network' | 'authentication' | 'unsupported-auth' | 'remote-disconnected' | 'configuration';
export interface ViewerError { code: ErrorCode; message: string }
export interface TransportInfo { id: string; url: string }
export interface TransportEvent { id: string; type: 'closed' | 'error'; error?: ViewerError }

export interface ViewerApi {
  loadSettings(): Promise<Settings>;
  saveConnections(connections: ConnectionProfile[]): Promise<void>;
  openTransport(target: { host: string; port: number }): Promise<TransportInfo>;
  closeTransport(id: string): Promise<void>;
  onTransportEvent(listener: (event: TransportEvent) => void): () => void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  setRemoteFocused(focused: boolean): void;
  setFullscreen(enabled: boolean): Promise<void>;
  onFullscreenChange(listener: (enabled: boolean) => void): () => void;
  getVersion(): Promise<string>;
}

export type SessionPhase = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'disconnected' | 'error';
export type CredentialField = 'username' | 'password' | 'target';
export type Shortcut = 'copy' | 'paste' | 'cut' | 'selectAll' | 'spotlight' | 'commandTab' | 'escape';
export interface SessionSnapshot {
  phase: SessionPhase;
  desktopName: string;
  credentialFields: CredentialField[];
  clipboardNotice: string;
  clipboardSync: boolean;
  remoteFocused: boolean;
  transmissionScale: {
    requested: TransmissionScale;
    supported: boolean;
    pending: boolean;
    width: number;
    height: number;
    error?: string;
  };
  error?: ViewerError;
}

declare global {
  interface Window { viewer: ViewerApi }
}
