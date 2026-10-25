import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseSnapshot } from '../src/state.ts';

test('Windows fallback enumerates all owned windows and rejects helpers, ambiguity and foreign PIDs',
  { skip: process.platform !== 'win32' }, () => {
    const script = `
$ErrorActionPreference = 'Stop'
. '${resolve('scripts/window-reader.ps1').replaceAll("'", "''")}'
Initialize-NeteaseWindowReader
Add-Type -AssemblyName System.Windows.Forms
$forms = @()
try {
  foreach ($title in @('NetEase Cloud Music', 'Off The Hook - Jeff Jarvis')) {
    $form = New-Object Windows.Forms.Form
    $form.Text = $title
    $form.ShowInTaskbar = $false
    $form.Opacity = 0
    $form.Show()
    $forms += $form
  }
  [Windows.Forms.Application]::DoEvents()
  $owned = @([NeteaseCompanion.Windows]::Read([int[]]@($PID)))
  $selected = Select-NeteaseWindowTitle $owned
  $duplicate = Select-NeteaseWindowTitle @(@{Title='Off The Hook - Jeff Jarvis'}, @{Title='Off The Hook - Jeff Jarvis'})
  $ambiguous = Select-NeteaseWindowTitle @(@{Title='Song A - Artist'}, @{Title='Song B - Artist'})
  $helpers = Select-NeteaseWindowTitle @(@{Title='NetEase Cloud Music'}, @{Title=([char]0x684c).ToString()+[char]0x9762+[char]0x6b4c+[char]0x8bcd+' - helper'}, @{Title='No separator'})
  $forms[1].Hide()
  [Windows.Forms.Application]::DoEvents()
  $hidden = Select-NeteaseWindowTitle @([NeteaseCompanion.Windows]::Read([int[]]@($PID)))
  @{ selected=$selected; duplicate=$duplicate; ambiguous=$ambiguous; helpers=$helpers; hidden=$hidden;
    foreign=@([NeteaseCompanion.Windows]::Read([int[]]@(-1))).Count } | ConvertTo-Json -Compress -Depth 5
} finally { foreach ($form in $forms) { $form.Dispose() } }
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.selected.title, 'Off The Hook - Jeff Jarvis');
    assert.equal(data.duplicate.title, data.selected.title);
    assert.equal(data.ambiguous.reason, 'ambiguous-window-titles');
    assert.equal(data.helpers.title, null);
    assert.equal(data.hidden.title, null);
    assert.equal(data.foreign, 0);
  });

test('normal reader snapshots exclude diagnostic window and session inventories',
  { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve('scripts/media-session.ps1'), '-Once'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, MUSIC_WINDOW_FALLBACK: '0' },
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.diagnostic, undefined);
    assert.ok(Object.keys(data).every(key => key === 'track' || key === 'error'));
    assert.doesNotThrow(() => parseSnapshot(data));
  });

test('standalone diagnostic explicitly enables fallback and exposes raw evidence',
  { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/diagnose.ts', '--once'], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, MUSIC_WINDOW_FALLBACK: '0' },
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.diagnostic.windowFallback, true);
    assert.equal(typeof data.diagnostic.sessionCount, 'number');
    assert.ok(Array.isArray(data.diagnostic.sessions));
    assert.ok(Array.isArray(data.diagnostic.window.windows));
    assert.equal(typeof data.diagnostic.reason, 'string');
  });
