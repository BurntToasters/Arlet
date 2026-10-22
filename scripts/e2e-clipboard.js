#!/usr/bin/env node

// Puts the tester's clipboard back after a check borrowed it for the support
// report. Failure modes it guards: a restore through the app adds the old
// text (maybe a password a manager kept out of history) to Win+V history and
// the cloud clipboard; a restore overwrites something copied during the
// check; the report stays on the clipboard when the old content was not text.
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
  public static string Restore(string prefix, string text) {
    if (!Open()) return "busy";
    try {
      string current = Current();
      if (current == null || !current.StartsWith(prefix)) return "changed";
      EmptyClipboard();
      if (text == null) return "cleared";
      SetClipboardData(CF_UNICODETEXT, Global(Encoding.Unicode.GetBytes(text + "\\0")));
      // Kept out of Win+V history, cloud sync, and clipboard monitors.
      byte[] off = BitConverter.GetBytes(0);
      SetClipboardData(RegisterClipboardFormat("CanIncludeInClipboardHistory"), Global(off));
      SetClipboardData(RegisterClipboardFormat("CanUploadToCloudClipboard"), Global(off));
      SetClipboardData(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), Global(off));
      return "restored";
    } finally {
      CloseClipboard();
    }
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[ArletE2eClipboard]::Restore($request.prefix, $request.text)
`;

/**
 * Restores `previous` (null when it was not text) if the clipboard still
 * holds the report. Returns "restored", "cleared", "changed", "busy", or
 * "failed"; never throws, so a check is not failed by the cleanup.
 */
export function restoreClipboard(previous) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
    {
      input: JSON.stringify({
        prefix: REPORT_PREFIX,
        text: typeof previous === "string" ? previous : null,
      }),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return result.status === 0 ? result.stdout.trim() || "failed" : "failed";
}
