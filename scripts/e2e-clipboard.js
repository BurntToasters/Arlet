#!/usr/bin/env node

// Puts the tester's clipboard back after a check borrowed it for the support
// report. Failure modes it guards: a restore through the app adds the old
// text (maybe a password a manager kept out of history) to Win+V history and
// the cloud clipboard; a restore overwrites something copied during the
// check; PowerShell's legacy input encoding corrupts Unicode and makes a
// still-current report look changed; read-after-write verification is skipped.
// The text goes in through stdin, never the command line.

import { spawnSync } from "node:child_process";

const REPORT_PREFIX = "# Arlet diagnostics report";

const SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ArletE2eClipboard {
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
  const uint CF_UNICODETEXT = 13;
  const uint GMEM_MOVEABLE = 2;
  static bool Open() {
    for (int attempt = 0; attempt < 40; attempt++) {
      if (OpenClipboard(IntPtr.Zero)) return true;
      Thread.Sleep(25);
    }
    return false;
  }
  static IntPtr Global(byte[] bytes) {
    IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
    IntPtr pointer = GlobalLock(memory);
    Marshal.Copy(bytes, 0, pointer, bytes.Length);
    GlobalUnlock(memory);
    return memory;
  }
  static string Current() {
    IntPtr data = GetClipboardData(CF_UNICODETEXT);
    if (data == IntPtr.Zero) return null;
    IntPtr pointer = GlobalLock(data);
    try { return Marshal.PtrToStringUni(pointer); } finally { GlobalUnlock(data); }
  }
  // Only while the report is still there; anything else was copied since.
  public static string Restore(string prefix, string expected, string text) {
    if (!Open()) return "busy";
    try {
      if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return "changed";
      string current = Current();
      if (current == null) return "read-failed";
      if (expected != null) {
        if (current != expected)
          return current.StartsWith(prefix) ? "report-mismatch" : "changed";
      } else if (!current.StartsWith(prefix)) {
        return "changed";
      }
      if (!EmptyClipboard()) return "failed";
      if (text == null)
        return Current() == null ? "cleared" : "verification-failed";
      if (SetClipboardData(CF_UNICODETEXT, Global(Encoding.Unicode.GetBytes(text + "\\0"))) == IntPtr.Zero) return "failed";
      // Kept out of Win+V history, cloud sync, and clipboard monitors.
      byte[] off = BitConverter.GetBytes(0);
      SetClipboardData(RegisterClipboardFormat("CanIncludeInClipboardHistory"), Global(off));
      SetClipboardData(RegisterClipboardFormat("CanUploadToCloudClipboard"), Global(off));
      SetClipboardData(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), Global(off));
      return Current() == text ? "restored" : "verification-failed";
    } finally {
      CloseClipboard();
    }
  }
}
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[ArletE2eClipboard]::Restore($request.prefix, $request.expected, $request.text)
`;

/**
 * Restores `previous` (null when it was not text) if the clipboard still
 * holds the expected report. "changed" is returned only after reading that
 * no Unicode text remains or the current text no longer has the report prefix.
 * Restored text is read back and compared before returning "restored".
 * Failures never throw, so the E2E check can record them.
 */
export function restoreClipboard(previous, expectedReport) {
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      {
        input: Buffer.from(
          JSON.stringify({
            prefix: REPORT_PREFIX,
            expected:
              typeof expectedReport === "string" ? expectedReport : null,
            text: typeof previous === "string" ? previous : null,
          }),
          "utf8",
        ),
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error?.code === "ETIMEDOUT") return "busy";
    if (result.error || result.status !== 0) return "failed";
    return result.stdout.trim() || "failed";
  } catch {
    return "failed";
  }
}
