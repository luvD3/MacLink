declare module '@novnc/novnc' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBEventMap {
    connect: Event;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    desktopname: CustomEvent<{ name: string }>;
    framebuffersize: CustomEvent<{ width: number; height: number }>;
    clipboard: CustomEvent<{ text: string }>;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    serververification: CustomEvent<{ type: string; publickey?: Uint8Array }>;
  }

  /** Public noVNC 1.7 RFB API; no implementation internals. */
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string | WebSocket | RTCDataChannel,
      options?: { shared?: boolean; credentials?: RFBCredentials },
    );

    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;

    /** MacLink adapter API; does not change the Mac display resolution. */
    get framebufferSize(): Readonly<{ width: number; height: number }>;
    get supportsTransmissionScale(): boolean;
    setTransmissionScale(value: import('../shared/types').TransmissionScale): boolean;

    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;

    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
