interface ClipboardPort {
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
}

const normalized = (text: string) => text.replace(/\r\n/g, '\n');

/** One connected session owns this watcher. Reads and remote writes are ordered
 * so our own writes never bounce back to the Mac as a new local copy. */
export class ClipboardSync {
  private active = true;
  private observed?: string;
  private pending = Promise.resolve();
  private refreshPending = false;
  private remoteRevision = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly port: ClipboardPort,
    private readonly send: (text: string) => void,
    private readonly reportError: () => void,
  ) {
    // Establish a baseline without replacing either clipboard on connection.
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 250);
  }

  refresh(): void {
    if (!this.active || this.refreshPending) return;
    this.refreshPending = true;
    this.enqueue(async () => {
      const revision = this.remoteRevision;
      const text = await this.port.readClipboard();
      if (!this.active || revision !== this.remoteRevision) return;
      const value = normalized(text);
      const changed = this.observed !== undefined && this.observed !== value;
      this.observed = value;
      // Images/files without text and clearing the clipboard are not text copies.
      if (changed && text !== '') this.send(text);
    }).finally(() => { this.refreshPending = false; });
  }

  receive(text: string): void {
    if (!this.active || text === '') return;
    ++this.remoteRevision;
    void this.enqueue(async () => {
      const value = normalized(text);
      // The local clipboard may have changed since the last poll, even when
      // this remote copy matches our previous observation.
      await this.port.writeClipboard(text);
      this.observed = value;
    });
  }

  dispose(): void {
    this.active = false;
    clearInterval(this.timer);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.active) await operation();
    }).catch(() => {
      if (!this.active) return;
      this.dispose();
      this.reportError();
    });
    return this.pending;
  }
}
