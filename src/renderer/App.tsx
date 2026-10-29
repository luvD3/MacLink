import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { ConnectionProfile, CredentialField, ScaleMode, Shortcut, TransmissionScale } from '../shared/types';
import { ViewerSession } from './session';
import './styles.css';

type IconName = 'plus' | 'monitor' | 'arrow' | 'edit' | 'trash' | 'close' | 'expand' | 'clipboard' | 'power' | 'check' | 'wifi' | 'command' | 'eye' | 'refresh' | 'lock';

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    edit: <><path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z" /><path d="M13 20h7" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    expand: <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />,
    clipboard: <><path d="M8 5H5a2 2 0 0 0-2 2v13h18V7a2 2 0 0 0-2-2h-3" /><rect x="8" y="2" width="8" height="6" rx="2" /><path d="M8 13h8M8 17h5" /></>,
    power: <><path d="M12 3v9M6.5 5.5a9 9 0 1 0 11 0" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    wifi: <><path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0" /><circle cx="12" cy="20" r=".75" /></>,
    command: <path d="M9 9H6a3 3 0 1 1 3-3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3z" />,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.5 6a8 8 0 0 1 13 2M4.5 16a8 8 0 0 0 13 2" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="modal" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭对话框"><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function ConnectionEditor({ profile, onClose, onSave }: { profile: ConnectionProfile | null; onClose: () => void; onSave: (profile: ConnectionProfile) => Promise<void> }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [host, setHost] = useState(profile?.host ?? '');
  const [port, setPort] = useState(String(profile?.port ?? 5900));
  const [scale, setScale] = useState<ScaleMode>(profile?.scale ?? 'fit');
  const [transmissionScale, setTransmissionScale] = useState<TransmissionScale>(profile?.transmissionScale ?? 'original');
  const [viewOnly, setViewOnly] = useState(profile?.viewOnly ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    void onSave({ id: profile?.id ?? crypto.randomUUID(), name: name.trim(), host: host.trim(), port: Number(port), scale, transmissionScale, viewOnly }).catch((cause: unknown) => {
      setError(errorMessage(cause));
      setSaving(false);
    });
  }

  return <Modal title={profile ? '编辑连接' : '添加 Mac'} subtitle="连接信息保存在这台 Windows 电脑上。" onClose={() => { if (!saving) onClose(); }}>
    <form onSubmit={submit} className="connection-form">
      <label htmlFor="connection-name">连接名称<input id="connection-name" data-testid="connection-name" name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：书房的 Mac mini" required maxLength={100} autoFocus /></label>
      <div className="address-fields">
        <label htmlFor="connection-host">主机地址<input id="connection-host" data-testid="connection-host" name="host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="mac-mini.local 或 IP 地址" required autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        <label htmlFor="connection-port">端口<input id="connection-port" data-testid="connection-port" name="port" type="number" min={1} max={65535} required value={port} onChange={(event) => setPort(event.target.value)} /></label>
      </div>
      <div className="form-section"><span className="field-label">本地显示</span><div className="segmented-control"><button type="button" className={scale === 'fit' ? 'selected' : ''} aria-pressed={scale === 'fit'} onClick={() => setScale('fit')}>适应窗口</button><button type="button" className={scale === 'actual' ? 'selected' : ''} aria-pressed={scale === 'actual'} onClick={() => setScale('actual')}>原始比例</button></div></div>
      <div className="form-section"><span className="field-label" id="transmission-preference-label">传输尺寸</span><div className="segmented-control" role="group" aria-labelledby="transmission-preference-label"><button type="button" data-testid="connection-transmission-original" className={transmissionScale === 'original' ? 'selected' : ''} aria-pressed={transmissionScale === 'original'} onClick={() => setTransmissionScale('original')}>原始尺寸</button><button type="button" data-testid="connection-transmission-half" className={transmissionScale === 'half' ? 'selected' : ''} aria-pressed={transmissionScale === 'half'} onClick={() => setTransmissionScale('half')}>半尺寸</button></div><p className="field-description">半尺寸将宽高各减半，例如 4K → 1080p。Mac 显示设置保持不变，实际尺寸以服务器确认为准。</p></div>
      <label className="checkbox-row"><input type="checkbox" checked={viewOnly} onChange={(event) => setViewOnly(event.target.checked)} /><span>以仅查看模式连接<small>查看桌面，不发送键盘和鼠标操作。</small></span></label>
      <div className="form-hint"><Icon name="lock" size={16} /><span>连接时再输入密码，MacLink 不保存密码。</span></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={saving}>取消</button><button className="button primary" data-testid="save-connection" type="submit" disabled={saving}>{saving ? '正在保存…' : '保存连接'}</button></div>
    </form>
  </Modal>;
}

function CredentialsDialog({ fields, name, onSubmit, onCancel }: { fields: CredentialField[]; name: string; onSubmit: (credentials: Partial<Record<CredentialField, string>>) => void; onCancel: () => void }) {
  const [credentials, setCredentials] = useState<Partial<Record<CredentialField, string>>>({});
  const [submitted, setSubmitted] = useState(false);
  const labels: Record<CredentialField, string> = { username: 'Mac 用户名', password: '连接密码', target: '目标' };
  return <Modal title="登录 Mac" subtitle={`正在连接 ${name}`} onClose={onCancel}>
    <form className="connection-form" onSubmit={(event) => { event.preventDefault(); setSubmitted(true); onSubmit(credentials); setCredentials({}); }}>
      {fields.map((field, index) => <label key={field} htmlFor={`credential-${field}`}>{labels[field]}<input id={`credential-${field}`} data-testid={`auth-${field}`} name={field} type={field === 'password' ? 'password' : 'text'} value={credentials[field] ?? ''} onChange={(event) => setCredentials({ ...credentials, [field]: event.target.value })} autoFocus={index === 0} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={submitted} required /></label>)}
      <div className="form-hint"><Icon name="lock" size={16} /><span>{fields.includes('username') ? '使用 Mac 上获准进行屏幕共享的账户。' : '输入在 Mac 屏幕共享设置中指定的 VNC 密码。'}密码仅用于本次连接。</span></div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>取消连接</button><button className="button primary" data-testid="auth-submit" type="submit" disabled={submitted}>{submitted ? '正在验证…' : '登录'}</button></div>
    </form>
  </Modal>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
}

const phaseLabels = { idle: '尚未连接', connecting: '正在连接', authenticating: '等待认证', connected: '已连接', disconnected: '连接已结束', error: '连接失败' };
const shortcuts: { value: Shortcut; name: string; keys: string }[] = [
  { value: 'copy', name: '复制', keys: '⌘ C' }, { value: 'paste', name: '粘贴', keys: '⌘ V' },
  { value: 'cut', name: '剪切', keys: '⌘ X' }, { value: 'selectAll', name: '全选', keys: '⌘ A' },
  { value: 'spotlight', name: '聚焦搜索', keys: '⌘ Space' }, { value: 'commandTab', name: '切换应用', keys: '⌘ Tab' },
  { value: 'escape', name: '退出当前操作', keys: 'Esc' },
];

export default function App() {
  const [session] = useState(() => new ViewerSession(window.viewer));
  const snapshot = useSyncExternalStore(useCallback((listener) => session.subscribe(listener), [session]), useCallback(() => session.getSnapshot(), [session]));
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState<ConnectionProfile | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<{ profile: ConnectionProfile | null } | null>(null);
  const [deleteProfile, setDeleteProfile] = useState<ConnectionProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [uiError, setUiError] = useState('');
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenChanging, setFullscreenChanging] = useState(false);
  const [scale, setScale] = useState<ScaleMode>('fit');
  const [viewOnly, setViewOnly] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [toolbarShown, setToolbarShown] = useState(false);
  const [showConnectionHint, setShowConnectionHint] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const clipboardSyncToggle = useRef<HTMLInputElement>(null);
  const browserFullscreen = useRef(false);
  const toolbar = useRef<HTMLDivElement>(null);
  const toolbarReveal = useRef<HTMLDivElement>(null);
  const localToolbarKey = useRef(false);
  const hintShown = useRef(false);
  const savedConnections = useRef<ConnectionProfile[]>([]);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const selected = connections.find((profile) => profile.id === selectedId) ?? null;
  const busy = ['connecting', 'authenticating', 'connected'].includes(snapshot.phase);
  const connected = snapshot.phase === 'connected';
  const displayedProfile = activeProfile ?? selected;
  const transmission = snapshot.transmissionScale;
  const receivedSize = transmission.width > 0 && transmission.height > 0 ? `${transmission.width} × ${transmission.height}` : '尺寸未确认';
  const transmissionStatus = !connected ? '连接后确认' : `${receivedSize}${transmission.pending ? ' · 待确认' : transmission.error ? ' · 未生效' : ''}`;
  const transmissionTitle = !connected ? '传输尺寸将在连接后由服务器确认' : [
    `当前接收：${receivedSize}`,
    transmission.pending ? `已请求${transmission.requested === 'half' ? '半尺寸' : '原始尺寸'}，等待服务器确认` : '',
    !transmission.supported ? '服务器未确认支持半尺寸传输' : '',
    transmission.error ?? '',
  ].filter(Boolean).join('。\n');

  const loadSettings = useCallback(() => {
    setLoading(true);
    setUiError('');
    void window.viewer.loadSettings().then((settings) => {
      savedConnections.current = settings.connections;
      setConnections(settings.connections);
      setSelectedId((current) => settings.connections.some((profile) => profile.id === current) ? current : settings.connections[0]?.id ?? null);
      setStorageReady(true);
    }).catch((cause: unknown) => {
      setStorageReady(false);
      setUiError(`无法读取连接配置：${errorMessage(cause)}。配置未被覆盖。`);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSettings();
    void window.viewer.getVersion().then(setVersion).catch((cause: unknown) => setUiError(errorMessage(cause)));
    const updateFullscreen = () => setFullscreen(Boolean(document.fullscreenElement) || browserFullscreen.current);
    const stopFullscreen = window.viewer.onFullscreenChange((enabled) => { browserFullscreen.current = enabled; updateFullscreen(); });
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => { stopFullscreen(); document.removeEventListener('fullscreenchange', updateFullscreen); session.dispose(); };
  }, [loadSettings, session]);

  useEffect(() => {
    setToolbarShown(false);
    setClipboardOpen(false);
    localToolbarKey.current = false;
    if (!connected || hintShown.current) return;
    hintShown.current = true;
    setShowConnectionHint(true);
    const timeout = window.setTimeout(() => setShowConnectionHint(false), 3500);
    return () => { window.clearTimeout(timeout); setShowConnectionHint(false); };
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    const toggleToolbar = (event: KeyboardEvent) => {
      if (event.code !== 'F8') return;
      if (event.type === 'keyup') {
        if (localToolbarKey.current) {
          event.preventDefault();
          event.stopImmediatePropagation();
          localToolbarKey.current = false;
        }
        return;
      }
      if (event.repeat) {
        if (localToolbarKey.current) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (viewport.current!.contains(document.activeElement)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      localToolbarKey.current = true;
      if (toolbarShown) {
        setToolbarShown(false);
        if (toolbar.current!.contains(document.activeElement)) session.focus();
      } else {
        setToolbarShown(true);
        requestAnimationFrame(() => toolbar.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
      }
    };
    const hideAfterPointerLeaves = (event: PointerEvent) => {
      if (!toolbarShown || toolbar.current!.contains(document.activeElement)) return;
      const target = event.target as Node;
      if (!toolbar.current!.contains(target) && !toolbarReveal.current!.contains(target)) setToolbarShown(false);
    };
    const releaseLocalShortcut = () => { localToolbarKey.current = false; };
    window.addEventListener('keydown', toggleToolbar, true);
    window.addEventListener('keyup', toggleToolbar, true);
    window.addEventListener('pointermove', hideAfterPointerLeaves);
    window.addEventListener('blur', releaseLocalShortcut);
    return () => {
      window.removeEventListener('keydown', toggleToolbar, true);
      window.removeEventListener('keyup', toggleToolbar, true);
      window.removeEventListener('pointermove', hideAfterPointerLeaves);
      window.removeEventListener('blur', releaseLocalShortcut);
    };
  }, [connected, toolbarShown, session]);

  useEffect(() => {
    if (clipboardOpen && connected) clipboardSyncToggle.current?.focus();
  }, [clipboardOpen, connected]);

  function perform(action: () => Promise<void>) {
    setUiError('');
    return action().catch((cause: unknown) => setUiError(errorMessage(cause)));
  }

  function toggleFullscreen() {
    setFullscreenChanging(true);
    void perform(async () => {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (browserFullscreen.current) {
        await window.viewer.setFullscreen(false);
      } else {
        await document.documentElement.requestFullscreen();
      }
      if (connected) session.focus();
    }).finally(() => setFullscreenChanging(false));
  }

  function persistConnections(update: (current: ConnectionProfile[]) => ConnectionProfile[]) {
    const save = saveQueue.current.then(async () => {
      const next = update(savedConnections.current);
      await window.viewer.saveConnections(next);
      savedConnections.current = next;
      setConnections(next);
    });
    // A failed write is reported by its caller; subsequent edits can still save.
    saveQueue.current = save.catch(() => undefined);
    return save;
  }

  function choose(profile: ConnectionProfile) {
    if (busy) return;
    if (snapshot.error) session.disconnect();
    setSelectedId(profile.id);
    setActiveProfile(null);
    setNotice('');
  }

  function connect(profile: ConnectionProfile) {
    setActiveProfile(profile);
    setSelectedId(profile.id);
    setScale(profile.scale);
    setViewOnly(profile.viewOnly);
    setNotice('');
    setUiError('');
    void session.connect(profile, viewport.current!).catch((cause: unknown) => setUiError(errorMessage(cause)));
  }

  async function saveProfile(profile: ConnectionProfile) {
    await persistConnections((current) => current.some((item) => item.id === profile.id) ? current.map((item) => item.id === profile.id ? profile : item) : [...current, profile]);
    if (snapshot.error) session.disconnect();
    setSelectedId(profile.id);
    setActiveProfile(null);
    setEditor(null);
    setNotice('连接信息已保存');
  }

  function removeProfile(profile: ConnectionProfile) {
    setDeleting(true);
    setDeleteError('');
    void persistConnections((current) => current.filter((item) => item.id !== profile.id)).then(() => {
      const next = savedConnections.current;
      if (selectedId === profile.id) setSelectedId(next[0]?.id ?? null);
      if (activeProfile?.id === profile.id) { session.disconnect(); setActiveProfile(null); }
      setDeleteProfile(null);
      setNotice('连接已删除');
    }).catch((cause: unknown) => setDeleteError(errorMessage(cause))).finally(() => setDeleting(false));
  }

  function saveDisplayPreference(change: Partial<Pick<ConnectionProfile, 'scale' | 'transmissionScale' | 'viewOnly'>>) {
    const profile = activeProfile!;
    setActiveProfile((current) => current && { ...current, ...change });
    void perform(() => persistConnections((current) => current.map((item) => item.id === profile.id ? { ...item, ...change } : item)));
  }

  return <div className={`app-shell ${connected ? 'immersive' : ''}`} data-session-state={snapshot.phase} data-remote-focused={snapshot.remoteFocused}>
    <aside className="sidebar" aria-label="连接管理">
      <div className="brand"><span className="brand-mark"><Icon name="monitor" size={23} /><i /></span><div><strong>MacLink</strong><span>你的 Mac，就在这里</span></div></div>
      <div className="sidebar-section-heading"><span>我的连接 <b>{connections.length}</b></span><button className="icon-button" aria-label="添加连接" data-testid="new-connection" title="添加连接" disabled={!storageReady || busy} onClick={() => setEditor({ profile: null })}><Icon name="plus" /></button></div>
      <div className="connection-list">
        {loading && <p className="sidebar-note">正在读取连接…</p>}
        {!loading && connections.length === 0 && <div className="sidebar-empty"><Icon name="monitor" size={24} /><p>还没有保存的连接</p><span>添加一台 Mac，随时回到桌面。</span></div>}
        {connections.map((profile) => <div key={profile.id} className={`connection-item ${selectedId === profile.id ? 'selected' : ''}`}>
          <button className="connection-select" onClick={() => choose(profile)} onDoubleClick={() => { if (!busy) connect(profile); }} disabled={busy && activeProfile?.id !== profile.id} aria-pressed={selectedId === profile.id}>
            <span className="device-icon"><Icon name="monitor" size={20} /></span><span className="connection-copy"><strong>{profile.name}</strong><small>{profile.host}</small></span>{connected && activeProfile?.id === profile.id && <span className="online-dot" aria-label="已连接" />}
          </button>
          <div className="connection-item-actions"><button className="icon-button" aria-label={`编辑 ${profile.name}`} title="编辑连接" disabled={busy || !storageReady} onClick={() => setEditor({ profile })}><Icon name="edit" size={15} /></button><button className="icon-button" aria-label={`删除 ${profile.name}`} title="删除连接" disabled={busy || !storageReady} onClick={() => { setDeleteError(''); setDeleteProfile(profile); }}><Icon name="trash" size={15} /></button></div>
        </div>)}
      </div>
      <div className="sidebar-footer"><div className="local-label"><Icon name="lock" size={14} /><span>连接保存在本机 · 不保存密码</span></div><div className="sidebar-version"><span>WINDOWS VIEWER</span><span>{version ? `v${version}` : ''}</span></div></div>
    </aside>

    <main className="workspace">
      <header className="workspace-header"><div className="workspace-title"><span className="eyebrow">远程桌面</span><h1>{displayedProfile?.name ?? '连接你的 Mac'}</h1></div><div className={`session-status status-${snapshot.phase}`} role="status"><span className={snapshot.phase === 'connecting' || snapshot.phase === 'authenticating' ? 'status-dot pulsing' : 'status-dot'} />{phaseLabels[snapshot.phase]}</div></header>
      {connected && <div ref={toolbarReveal} className="toolbar-reveal" data-testid="toolbar-reveal" onPointerEnter={() => setToolbarShown(true)} aria-hidden="true" />}
      <div ref={toolbar} className={`toolbar ${toolbarShown ? 'toolbar-shown' : ''}`} data-testid="session-toolbar" aria-label="会话工具栏" aria-hidden={connected && !toolbarShown} inert={connected && !toolbarShown} onFocus={() => { if (connected) setToolbarShown(true); }} onBlur={(event) => { if (connected && !event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(':hover')) setToolbarShown(false); }}>
        <div className="toolbar-address"><Icon name="monitor" size={17} /><span>{displayedProfile ? `${displayedProfile.host}:${displayedProfile.port}` : '通过 macOS 屏幕共享连接'}</span></div>
        <div className="toolbar-actions">
          <div className="scale-toggle" data-testid="scale-toggle" aria-label="本地显示缩放" title="本地显示缩放：不改变接收的画面尺寸"><button disabled={!connected} aria-label="适应窗口" data-testid="scale-fit" aria-pressed={scale === 'fit'} className={scale === 'fit' ? 'active' : ''} onClick={() => { setScale('fit'); session.setScale('fit'); saveDisplayPreference({ scale: 'fit' }); }}>适应</button><button disabled={!connected} aria-label="原始比例" data-testid="scale-actual" aria-pressed={scale === 'actual'} className={scale === 'actual' ? 'active' : ''} onClick={() => { setScale('actual'); session.setScale('actual'); saveDisplayPreference({ scale: 'actual' }); }}>1:1</button></div>
          <div className={`transmission-control ${transmission.error ? 'has-error' : ''}`} title={transmissionTitle}>
            <label><span>传输</span><select aria-label="传输尺寸" data-testid="transmission-scale" aria-describedby="transmission-status" value={transmission.requested} disabled={!connected || (!transmission.supported && transmission.requested === 'original')} onChange={(event) => { const value = event.target.value as TransmissionScale; session.setTransmissionScale(value); saveDisplayPreference({ transmissionScale: value }); }}><option value="original">原始</option><option value="half" disabled={!transmission.supported}>半尺寸</option></select></label>
            <span id="transmission-status" data-testid="transmission-status" className="transmission-status" aria-live="polite">{transmissionStatus}</span>
          </div>
          <span className="toolbar-divider" />
          <label className={`toolbar-view-only ${viewOnly ? 'enabled' : ''}`} title="仅查看，不发送键鼠操作"><input type="checkbox" checked={viewOnly} disabled={!connected} onChange={(event) => { setViewOnly(event.target.checked); session.setViewOnly(event.target.checked); saveDisplayPreference({ viewOnly: event.target.checked }); }} /><Icon name="eye" size={17} /><span>仅查看</span></label>
          <details className="shortcut-menu"><summary aria-label="Mac 快捷键" title="Mac 快捷键" className={`icon-button ${!connected || viewOnly ? 'unavailable' : ''}`} onClick={(event) => { if (!connected || viewOnly) event.preventDefault(); }}><Icon name="command" /></summary><div className="shortcut-options"><span>发送到 Mac</span>{shortcuts.map((shortcut) => <button key={shortcut.value} data-testid={`shortcut-${shortcut.value}`} disabled={!connected || viewOnly} onClick={(event) => { session.sendShortcut(shortcut.value); event.currentTarget.closest('details')!.open = false; }}><span>{shortcut.name}</span><kbd>{shortcut.keys}</kbd></button>)}</div></details>
          <button className={`icon-button ${clipboardOpen ? 'is-active' : ''}`} aria-label="文本剪贴板" data-testid="clipboard-toggle" aria-expanded={clipboardOpen} title="文本剪贴板" disabled={!connected} onClick={() => setClipboardOpen(!clipboardOpen)}><Icon name="clipboard" /></button>
          <button className={`icon-button ${fullscreen ? 'is-active' : ''}`} data-testid="fullscreen-toggle" aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏' : '全屏：将更多快捷键发送到 Mac'} disabled={fullscreenChanging} onClick={toggleFullscreen}><Icon name="expand" /></button>
          {busy && <><span className="toolbar-divider" /><button className="button disconnect-button" data-testid={connected ? 'disconnect' : 'cancel-connect'} onClick={() => session.disconnect()}><Icon name="power" size={15} /><span>{connected ? '断开' : '取消'}</span></button></>}
        </div>
      </div>

      {uiError && <div className="error-banner" role="alert"><span>{uiError}</span>{!storageReady && <button onClick={loadSettings} disabled={loading}>重新读取</button>}<button className="icon-button" aria-label="关闭错误提示" onClick={() => setUiError('')}><Icon name="close" size={16} /></button></div>}

      <div className="viewer-area">
        <div className={`viewer-stage ${connected ? 'is-connected' : ''}`}>
          <div ref={viewport} className={`remote-viewport ${connected ? 'visible' : ''}`} data-testid="remote-screen" aria-label="Mac 远程桌面" />
          {!connected && <div className="welcome-screen">
            <div className={`desktop-illustration ${snapshot.phase === 'error' ? 'illustration-error' : ''}`} aria-hidden="true"><div className="illustration-orbit" /><div className="illustration-monitor"><div className="illustration-screen"><div className="screen-window"><span /><span /><span /><div className="screen-line" /><div className="screen-line short" /></div><div className="screen-landscape" /></div><div className="illustration-chin" /><div className="illustration-foot" /></div><div className="illustration-badge">{snapshot.phase === 'error' ? <Icon name="refresh" size={20} /> : <Icon name="wifi" size={21} />}</div></div>
            <span className="welcome-kicker">MACLINK · 远程连接，轻松一点</span>
            <h2>{snapshot.phase === 'error' ? '这次连接没有成功' : busy ? '正在连接你的 Mac' : displayedProfile ? `回到${displayedProfile.name}的桌面` : '让另一块屏幕，近在眼前'}</h2>
            <p className="welcome-description" role={snapshot.error ? 'alert' : undefined}>{snapshot.error ? snapshot.error.message : busy ? '正在建立连接，请稍候。你可以随时取消。' : displayedProfile ? '打开 Mac 的屏幕共享，即可在这里查看和操作桌面。' : '通过 Mac 自带的屏幕共享，在 Windows 上继续你的工作。'}</p>
            {busy ? <button className="button secondary welcome-action" onClick={() => session.disconnect()}><span className="loading-spinner" />取消连接</button> : displayedProfile ? <button className="button primary welcome-action" data-testid="connect" onClick={() => connect(displayedProfile)} disabled={!storageReady}><Icon name={snapshot.phase === 'error' || snapshot.phase === 'disconnected' ? 'refresh' : 'arrow'} />{snapshot.phase === 'error' || (snapshot.phase === 'disconnected' && activeProfile) ? '重新连接' : '连接 Mac'}</button> : <button className="button primary welcome-action" onClick={() => setEditor({ profile: null })} disabled={!storageReady}><Icon name="plus" />添加第一台 Mac</button>}
            {!busy && snapshot.phase !== 'error' && <div className="setup-guide"><div><span className="step-number">01</span><strong>开启屏幕共享</strong><p>Mac 系统设置 → 通用 → 共享</p></div><div><span className="step-number">02</span><strong>添加连接地址</strong><p>填写 Mac 的 IP 或主机名</p></div><div><span className="step-number">03</span><strong>登录并开始使用</strong><p>按提示输入账户或 VNC 密码</p></div></div>}
            {!busy && snapshot.phase === 'error' && <div className="connection-help"><span>连接提示</span><p>确认 Mac 已开启屏幕共享或远程管理，且两台电脑网络互通。使用 VNC 专用密码时，需在 Mac 上允许 VNC 查看器访问。</p></div>}
          </div>}
        </div>

        {clipboardOpen && connected && <aside className="clipboard-panel" aria-label="文本剪贴板面板">
          <div className="panel-heading"><div><Icon name="clipboard" /><h2>剪贴板同步</h2></div><button className="icon-button" aria-label="关闭剪贴板" onClick={() => { setClipboardOpen(false); session.focus(); }}><Icon name="close" /></button></div>
          <div className={`clipboard-sync ${snapshot.clipboardSync && !viewOnly ? 'enabled' : ''}`}>
            <label className="clipboard-sync-toggle"><span>自动同步文本</span><input ref={clipboardSyncToggle} type="checkbox" data-testid="clipboard-sync-toggle" checked={snapshot.clipboardSync} onChange={(event) => session.setClipboardSync(event.target.checked)} /></label>
            <p data-testid="clipboard-sync-status">{viewOnly ? '仅查看模式下自动同步暂停。' : snapshot.clipboardSync ? '本机与 Mac 的文本剪贴板会自动同步。' : '自动同步已暂停。'}</p>
          </div>
          {snapshot.clipboardNotice && !viewOnly && <p className="clipboard-hint" role="status">{snapshot.clipboardNotice}</p>}
          <p className="clipboard-footnote">仅同步文本，不包含文件和图片。</p>
        </aside>}
      </div>

      {connected && showConnectionHint && <div className="immersive-hint" role="status">鼠标移到顶部显示工具栏</div>}
      <footer className="statusbar"><div><span className={`footer-dot ${connected ? 'connected' : ''}`} /><span>{connected ? (snapshot.desktopName || '远程桌面已就绪') : snapshot.phase === 'idle' ? '准备就绪' : phaseLabels[snapshot.phase]}</span>{connected && <><span className="statusbar-separator">/</span><span>{viewOnly ? '仅查看' : '键鼠控制'}</span></>}</div><span className="statusbar-notice" role="status">{notice || (connected ? '使用工具栏调整显示和发送 Mac 快捷键' : '直接连接 macOS 自带服务')}</span></footer>
    </main>

    {editor && <ConnectionEditor profile={editor.profile} onClose={() => setEditor(null)} onSave={saveProfile} />}
    {deleteProfile && <Modal title="删除这个连接？" subtitle={`将从本机移除“${deleteProfile.name}”的连接信息。`} onClose={() => { if (!deleting) setDeleteProfile(null); }}><p className="delete-description">不会更改 Mac 上的设置或文件。</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setDeleteProfile(null)} disabled={deleting}>取消</button><button className="button danger" onClick={() => removeProfile(deleteProfile)} disabled={deleting}>{deleting ? '正在删除…' : '删除连接'}</button></div></Modal>}
    {snapshot.phase === 'authenticating' && snapshot.credentialFields.length > 0 && <CredentialsDialog fields={snapshot.credentialFields} name={activeProfile?.name ?? 'Mac'} onSubmit={(credentials) => session.submitCredentials(credentials)} onCancel={() => session.disconnect()} />}
  </div>;
}
