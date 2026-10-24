import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { MusicConfig } from './config.ts';
import { parseSnapshot, type Snapshot } from './state.ts';

export interface Reader { start(onSnapshot: (s: Snapshot) => void, onError: (message: string) => void): void; stop(): Promise<void> }
export class WindowsReader implements Reader {
  private child?: ChildProcess;
  private stopping = false;
  private restart?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private generation = 0;
  private failures = 0;
  constructor(private cfg: MusicConfig, private launchProcess: typeof spawn = spawn,
    private timing = { heartbeatMs: 20_000, checkMs: 5000, retryMs: 2000 }) {}
  start(onSnapshot: (s: Snapshot) => void, onError: (message: string) => void): void {
    if (this.child && this.stopping) throw new Error('上次媒体读取进程尚未退出，不能重复启动');
    if (this.child || this.restart || this.watchdog) return;
    this.stopping = false;
    const generation = ++this.generation;
    const launch = () => {
      this.restart = undefined;
      if (this.stopping || generation !== this.generation) return;
      let lastSnapshot = Date.now();
      const child = this.child = this.launchProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/media-session.ps1', import.meta.url))], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MUSIC_SESSION_PATTERN: this.cfg.sessionPattern,
          MUSIC_WINDOW_FALLBACK: this.cfg.windowFallback ? '1' : '0' },
      });
      let lineBytes = 0;
      child.stdout!.on('data', (chunk: Buffer) => {
        for (const byte of chunk) {
          lineBytes = byte === 10 ? 0 : lineBytes + 1;
          if (lineBytes > 65_536) { onError('媒体读取器数据过大，正在重连'); child.kill(); child.stdout!.destroy(); break; }
        }
      });
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', line => {
        if (this.stopping || generation !== this.generation || this.child !== child) return;
        if (line.length > 32_768) { onError('媒体读取器数据过大，正在重连'); child.kill(); return; }
        try { const snapshot = parseSnapshot(JSON.parse(line)); lastSnapshot = Date.now(); this.failures = 0; onSnapshot(snapshot); }
        catch { onError('媒体读取器返回了无法识别的数据'); }
      });
      this.watchdog = setInterval(() => {
        if (Date.now() - lastSnapshot > this.timing.heartbeatMs) { onError('媒体读取超时无响应，正在重连'); child.kill(); }
      }, this.timing.checkMs);
      child.stderr?.on('data', () => { if (generation === this.generation && !this.stopping) onError('媒体读取器报告错误，请运行 npm run diagnose 查看本机输出'); });
      child.on('error', e => { if (!this.stopping && generation === this.generation) onError(e.message); });
      child.on('close', () => {
        lines.close();
        if (this.child !== child) return;
        if (this.stopping) { this.child = undefined; return; }
        if (generation !== this.generation) return;
        clearInterval(this.watchdog);
        this.watchdog = undefined;
        this.child = undefined;
        if (!this.stopping) {
          const delay = Math.min(60_000, this.timing.retryMs * 2 ** Math.min(this.failures++, 5));
          onError(`媒体读取器退出，${delay / 1000} 秒后重试`);
          this.restart = setTimeout(launch, delay);
        }
      });
    };
    launch();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    ++this.generation;
    clearTimeout(this.restart);
    this.restart = undefined;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null) { this.child = undefined; return; }
    await new Promise<void>(resolve => {
      const onClose = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(() => { child.removeListener('close', onClose); resolve(); }, 2000);
      child.once('close', onClose);
      try {
        if (!child.kill()) { clearTimeout(timeout); child.removeListener('close', onClose); resolve(); }
      } catch { clearTimeout(timeout); child.removeListener('close', onClose); resolve(); }
    });
    if (this.child === child && child.exitCode === null) throw new Error('媒体读取进程未确认退出，请结束对应 PowerShell 子进程后重试');
    if (this.child === child) this.child = undefined;
  }
}
