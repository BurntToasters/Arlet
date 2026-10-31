#!/usr/bin/env node

// Samples which process owns the foreground window during a native E2E run,
// and whether a visible Arlet window sits above it in the z-order, so a
// background launch can prove Arlet never took the keyboard or covered the
// active app (a full-screen game drops out when a window appears on top).
// Failure modes it guards: the window activates on first show, on a restart,
// or when a test maximizes, resizes, or full-screens it; the window rises
// above the active app without activating; the monitor itself opening a
// visible console (it runs hidden); a dead monitor reported as "no steals"
// (zero samples is reported, never treated as a pass); Tao's visible message
// dispatcher and tauri-plugin-single-instance's IPC window being mistaken for
// covering windows (exact class and styles); an active desktop, which every
// window sits above, reported as covered (docs/TESTING.md has the rule).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SAMPLE_MS = 250;
const DISPATCHER_CLASS = "Tao Thread Event Target";
// Both helper windows carry WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TOOLWINDOW
// | WS_EX_TRANSPARENT: they never take focus, cover anything, or reach the taskbar.
const HELPER_STYLE_MASK = "080800A0";
// tauri-plugin-single-instance (2.5.x) registers "<identifier>-sic" as its
// window class; its semver suffix is only added when that feature is enabled.
const SINGLE_INSTANCE_CLASS_SUFFIX = "-sic";
const TAURI_CONFIG = fileURLToPath(
  new URL("../src-tauri/tauri.conf.json", import.meta.url),
);

/** The single-instance IPC window class for the app's Tauri identifier. */
function singleInstanceClassName() {
  const { identifier } = JSON.parse(readFileSync(TAURI_CONFIG, "utf8"));
  if (!/^[A-Za-z0-9._-]+$/u.test(identifier ?? "")) {
    throw new Error(
      `Unsafe Tauri identifier for the single-instance class: ${identifier}`,
    );
  }
  return `${identifier}${SINGLE_INSTANCE_CLASS_SUFFIX}`;
}

const foregroundScript = (singleInstanceClass) => `
$ErrorActionPreference = "SilentlyContinue"
Add-Type -Namespace ArletE2E -Name Foreground -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr hWnd, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern System.IntPtr GetWindowLongPtr64(System.IntPtr hWnd, int index);
[DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern System.IntPtr GetWindowLong32(System.IntPtr hWnd, int index);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
public static System.IntPtr GetWindowLongPtr(System.IntPtr hWnd, int index) {
  return System.IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index) : GetWindowLong32(hWnd, index);
}
'@
$GW_HWNDPREV = 3
$GWL_EXSTYLE = -20
$dispatcherClass = "${DISPATCHER_CLASS}"
$singleInstanceClass = "${singleInstanceClass}"
$requiredHelperStyles = [Convert]::ToUInt64("${HELPER_STYLE_MASK}", 16)
while ($true) {
  $owner = [uint32]0
  $hwnd = [ArletE2E.Foreground]::GetForegroundWindow()
  [void][ArletE2E.Foreground]::GetWindowThreadProcessId($hwnd, [ref]$owner)
  $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
  $arletIds = @(Get-Process -Name arlet -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  $fg = New-Object ArletE2E.Foreground+RECT
  [void][ArletE2E.Foreground]::GetWindowRect($hwnd, [ref]$fg)
  # The desktop is below every window, so nothing above it is covering it.
  $fgClass = New-Object System.Text.StringBuilder 64
  [void][ArletE2E.Foreground]::GetClassName($hwnd, $fgClass, 64)
  $desktop = 0
  if ($name -eq "explorer" -and ($fgClass.ToString() -ceq "Progman" -or $fgClass.ToString() -ceq "WorkerW")) {
    $desktop = 1
  }
  # "-" when nothing of Arlet's covers the active window, else title|class|rect.
  $above = "-"
  $dispatcherCount = 0
  $dispatcherStyleEvidence = "-"
  $singleInstanceCount = 0
  $singleInstanceStyleEvidence = "-"
  $walk = [ArletE2E.Foreground]::GetWindow($hwnd, $GW_HWNDPREV)
  while ($walk -ne [System.IntPtr]::Zero -and $arletIds.Count -gt 0 -and $desktop -eq 0) {
    $walkOwner = [uint32]0
    [void][ArletE2E.Foreground]::GetWindowThreadProcessId($walk, [ref]$walkOwner)
    if (($arletIds -contains $walkOwner) -and [ArletE2E.Foreground]::IsWindowVisible($walk)) {
      # Only a sized window that overlaps the active one can cover it.
      $r = New-Object ArletE2E.Foreground+RECT
      [void][ArletE2E.Foreground]::GetWindowRect($walk, [ref]$r)
      if ($r.Right -gt $r.Left -and $r.Bottom -gt $r.Top -and $r.Left -lt $fg.Right -and $r.Right -gt $fg.Left -and $r.Top -lt $fg.Bottom -and $r.Bottom -gt $fg.Top) {
        $class = New-Object System.Text.StringBuilder 64
        [void][ArletE2E.Foreground]::GetClassName($walk, $class, 64)
        $className = $class.ToString()
        $extendedStyle = [uint64]([ArletE2E.Foreground]::GetWindowLongPtr($walk, $GWL_EXSTYLE).ToInt64())
        $hasHelperStyles = (($extendedStyle -band $requiredHelperStyles) -eq $requiredHelperStyles)
        if ($hasHelperStyles -and $className -ceq $dispatcherClass) {
          $dispatcherCount += 1
          if ($dispatcherStyleEvidence -eq "-") {
            $dispatcherStyleEvidence = "0x{0:X8}" -f $extendedStyle
          }
        } elseif ($hasHelperStyles -and $className -ceq $singleInstanceClass) {
          $singleInstanceCount += 1
          if ($singleInstanceStyleEvidence -eq "-") {
            $singleInstanceStyleEvidence = "0x{0:X8}" -f $extendedStyle
          }
        } elseif ($above -eq "-") {
          $title = New-Object System.Text.StringBuilder 64
          [void][ArletE2E.Foreground]::GetWindowText($walk, $title, 64)
          $above = ("{0}|{1}|{2},{3},{4},{5}" -f $title, $class, $r.Left, $r.Top, $r.Right, $r.Bottom) -replace " ", "_"
        }
      }
    }
    $walk = [ArletE2E.Foreground]::GetWindow($walk, $GW_HWNDPREV)
  }
  if (-not $name) { $name = "(none)" }
  [Console]::Out.WriteLine("$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) $desktop $above $name $dispatcherCount $dispatcherStyleEvidence $singleInstanceCount $singleInstanceStyleEvidence")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${SAMPLE_MS}
}
`;

const firstAt = (list) => (list[0] ? new Date(list[0].at).toISOString() : null);

/** Starts sampling; `stop()` ends it and summarizes what owned the foreground. */
export function startForegroundMonitor() {
  const singleInstanceClass = singleInstanceClassName();
  const samples = [];
  let buffer = "";
  const monitor = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      foregroundScript(singleInstanceClass),
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  monitor.stdout.setEncoding("utf8");
  monitor.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^(\d+) ([01]) (\S+) (.+) (\d+) (\S+) (\d+) (\S+)$/u.exec(
        line.trim(),
      );
      if (match) {
        samples.push({
          at: Number(match[1]),
          desktop: match[2] === "1",
          above: match[3] === "-" ? null : match[3],
          name: match[4],
          ignoredDispatcherCount: Number(match[5]),
          ignoredDispatcherStyle: match[6] === "-" ? null : match[6],
          ignoredSingleInstanceCount: Number(match[7]),
          ignoredSingleInstanceStyle: match[8] === "-" ? null : match[8],
        });
      }
    }
  });
  monitor.on("error", () => undefined);
  // Ctrl+C and crashes exit without stop(); the loop must not outlive the run.
  const end = () => monitor.kill();
  process.once("exit", end);
  return {
    stop() {
      process.off("exit", end);
      monitor.kill();
      const isArlet = (sample) => sample.name.toLowerCase() === "arlet";
      const active = samples.filter(isArlet);
      const above = samples.filter(
        (sample) => sample.above && !isArlet(sample),
      );
      const owners = {};
      for (const sample of samples) {
        const name = sample.name || "(none)";
        owners[name] = (owners[name] ?? 0) + 1;
      }
      // Summarizes one ignored helper window kind from its per-sample counts.
      const helperSummary = (countKey, styleKey) => {
        const hits = samples.filter((sample) => sample[countKey] > 0);
        return {
          sampleCount: hits.length,
          windowObservations: hits.reduce(
            (count, sample) => count + sample[countKey],
            0,
          ),
          observedExtendedStyle:
            hits.find((sample) => sample[styleKey])?.[styleKey] ?? null,
        };
      };
      return {
        sampleMs: SAMPLE_MS,
        samples: samples.length,
        arletSamples: active.length,
        arletFirstAt: firstAt(active),
        // Samples with a visible Arlet window above the active app.
        aboveSamples: above.length,
        aboveFirstAt: firstAt(above),
        // Title|class|rect of the first covering window, to tell which it was.
        aboveWindow: above[0]?.above ?? null,
        // Samples with the desktop active, checked for activation only.
        desktopSamples: samples.filter((sample) => sample.desktop).length,
        ignoredDispatcher: {
          className: DISPATCHER_CLASS,
          requiredExtendedStyleMask: `0x${HELPER_STYLE_MASK}`,
          ...helperSummary("ignoredDispatcherCount", "ignoredDispatcherStyle"),
        },
        ignoredSingleInstance: {
          className: singleInstanceClass,
          requiredExtendedStyleMask: `0x${HELPER_STYLE_MASK}`,
          ...helperSummary(
            "ignoredSingleInstanceCount",
            "ignoredSingleInstanceStyle",
          ),
        },
        owners,
      };
    },
  };
}
