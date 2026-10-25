import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaults } from '../src/config.ts';
if (process.platform !== 'win32') throw new Error('Windows only');
const cfg = defaults();
console.error('独立诊断使用默认配置（窗口降级开启），不读取部署配置；输出含歌曲及窗口标题，分享前请脱敏。');
const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', fileURLToPath(new URL('./media-session.ps1', import.meta.url)), '-Diagnostic',
  ...(process.argv.includes('--once') ? ['-Once'] : [])], {
  windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, MUSIC_SESSION_PATTERN: cfg.sessionPattern, MUSIC_WINDOW_FALLBACK: '1' },
});
let terminating = false;
const finish = () => {
  terminating = true;
  if (!child.kill()) { console.error('诊断读取进程终止失败'); process.exitCode = 1; }
};
const timeout = setTimeout(finish, 15_000);
process.once('SIGINT', finish);
child.once('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.once('close', code => { clearTimeout(timeout); if (!terminating && code !== 0) process.exitCode = code ?? 1; });
