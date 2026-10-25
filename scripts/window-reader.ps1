# ASCII for Windows PowerShell 5.1. Loaded by the reader and regression tests.
function Initialize-NeteaseWindowReader {
    if ('NeteaseCompanion.Windows' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace NeteaseCompanion {
    public class Window { public int Pid; public long Handle; public string Title; }
    public static class Windows {
        private delegate bool Callback(IntPtr hwnd, IntPtr param);
        [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr param);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        public static Window[] Read(int[] pids) {
            var allowed = new HashSet<int>(pids);
            var found = new List<Window>();
            bool ok = EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                if (!allowed.Contains((int)pid) || !IsWindowVisible(hwnd)) return true;
                var text = new StringBuilder(512);
                GetWindowText(hwnd, text, text.Capacity);
                if (text.Length > 0)
                    found.Add(new Window { Pid = (int)pid, Handle = hwnd.ToInt64(), Title = text.ToString() });
                return true;
            }, IntPtr.Zero);
            if (!ok) throw new InvalidOperationException("EnumWindows failed");
            return found.ToArray();
        }
    }
}
'@
}

function Select-NeteaseWindowTitle($windows) {
    $titles = @($windows | ForEach-Object { $_.Title.Trim() } | Where-Object {
        $_ -match '\S.*\s[-\u2013\u2014]\s.*\S' -and
        $_ -notmatch '^(\u7f51\u6613\u4e91\u97f3\u4e50|NetEase Cloud Music|\u684c\u9762\u6b4c\u8bcd|\u8ff7\u4f60\u64ad\u653e\u5668)(\s*[-\u2013\u2014].*)?$'
    } | Sort-Object -Unique)
    if ($titles.Count -eq 1) { return @{ title = $titles[0]; reason = 'selected' } }
    if ($titles.Count -gt 1) { return @{ title = $null; reason = 'ambiguous-window-titles' } }
    return @{ title = $null; reason = 'no-song-window-title' }
}

function Get-NeteaseWindowObservation {
    param([switch]$Diagnostic)
    $processes = @(Get-Process -Name cloudmusic -ErrorAction SilentlyContinue)
    $windows = @()
    $selection = @{ title = $null; reason = 'no-visible-cloudmusic-process' }
    $failure = $null
    try {
        Initialize-NeteaseWindowReader
        if ($processes.Count -gt 0) {
            $windows = @([NeteaseCompanion.Windows]::Read([int[]]@($processes | ForEach-Object { $_.Id })))
            if ($windows.Count -gt 64) { throw 'Too many cloudmusic windows' }
            $selection = Select-NeteaseWindowTitle $windows
        }
    } catch { $failure = $_.Exception.Message; $selection = @{ title = $null; reason = 'window-enumeration-failed' } }
    $processDetails = @()
    if ($Diagnostic) {
        $processDetails = @($processes | Select-Object -First 32 | ForEach-Object {
            try { @{ Id = $_.Id; MainWindowHandle = $_.MainWindowHandle.ToInt64(); MainWindowTitle = $_.MainWindowTitle } }
            catch { @{ error = 'Process exited or window properties unavailable' } }
        })
    }
    return @{ title = $selection.title; reason = $selection.reason; error = $failure;
        processes = $processDetails;
        windows = @($windows | Select-Object -First 64 Pid, Handle, Title) }
}
