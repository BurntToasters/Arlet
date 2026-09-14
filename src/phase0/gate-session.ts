import type { AppState } from "../state.ts";

const CHECKLIST_STORAGE_KEY = "arlet-phase0-checklist";
const SESSION_STARTED_KEY = "arlet-phase0-session-started";

export type GateCheckCategory =
  "authorization" | "playback" | "lifecycle" | "recovery";

export interface GateChecklistItem {
  id: string;
  category: GateCheckCategory;
  label: string;
}

export const GATE_CHECKLIST: GateChecklistItem[] = [
  {
    id: "auth-init",
    category: "authorization",
    label: "MusicKit initializes without errors",
  },
  {
    id: "auth-popup",
    category: "authorization",
    label: "Apple authorization popup appears",
  },
  {
    id: "auth-complete",
    category: "authorization",
    label: "Authorization completes successfully",
  },
  {
    id: "auth-token",
    category: "authorization",
    label: "Music User Token is obtained",
  },
  {
    id: "auth-persist",
    category: "authorization",
    label: "Session persists across page reload",
  },
  {
    id: "auth-logout",
    category: "authorization",
    label: "Logout clears session",
  },
  {
    id: "auth-relogin",
    category: "authorization",
    label: "Re-login after logout works",
  },
  {
    id: "play-full",
    category: "playback",
    label: "Full protected track plays (not just 30s preview)",
  },
  {
    id: "play-audio",
    category: "playback",
    label: "Audio output is correct",
  },
  {
    id: "play-seek",
    category: "playback",
    label: "Seek within track works",
  },
  {
    id: "play-pause",
    category: "playback",
    label: "Pause/resume works",
  },
  {
    id: "play-next",
    category: "playback",
    label: "Skip to next track works",
  },
  {
    id: "play-prev",
    category: "playback",
    label: "Skip to previous track works",
  },
  {
    id: "play-volume",
    category: "playback",
    label: "Volume control works",
  },
  {
    id: "play-20",
    category: "playback",
    label: "20+ consecutive tracks play without failure",
  },
  {
    id: "play-2h",
    category: "playback",
    label: "Two-hour continuous session stable",
  },
  {
    id: "life-minimize",
    category: "lifecycle",
    label: "App minimize/restore: playback continues",
  },
  {
    id: "life-lock",
    category: "lifecycle",
    label: "Lock/unlock Windows: playback recovers",
  },
  {
    id: "life-device",
    category: "lifecycle",
    label: "Change default audio output device: playback continues",
  },
  {
    id: "life-focus",
    category: "lifecycle",
    label: "Alt-tab away and back: no issues",
  },
  {
    id: "recover-network",
    category: "recovery",
    label: "Network interruption: error surfaced, recovery possible",
  },
  {
    id: "recover-token",
    category: "recovery",
    label: "Invalid/expired token: clear error state",
  },
  {
    id: "recover-restart",
    category: "recovery",
    label: "Restart app: expected session behavior",
  },
];

const CATEGORY_TITLES: Record<GateCheckCategory, string> = {
  authorization: "Authorization",
  playback: "Playback",
  lifecycle: "Window Lifecycle",
  recovery: "Error Recovery",
};

export interface GateEnvironment {
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
  webviewVersion: string | null;
  windowsBuild?: string | null;
  debug: boolean;
  nodeVersion?: string;
  npmVersion?: string;
  rustToolchain?: string;
  rustcVersion?: string | null;
}

export interface GateReportInput {
  environment: GateEnvironment;
  /** Only this aggregate is written to reports; auth tokens never belong in a report input. */
  appState: Pick<Readonly<AppState>, "tracksPlayed">;
  sessionStartedAt: Date;
  diagLog: string;
  checklist: Record<string, boolean>;
  observedHosts: readonly string[];
  failures: readonly string[];
}

function emptyChecklistState(): Record<string, boolean> {
  return Object.fromEntries(GATE_CHECKLIST.map((item) => [item.id, false]));
}

export function loadChecklistState(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(CHECKLIST_STORAGE_KEY);
    if (!raw) return emptyChecklistState();
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return { ...emptyChecklistState(), ...parsed };
  } catch {
    return emptyChecklistState();
  }
}

export function saveChecklistState(state: Record<string, boolean>): void {
  sessionStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(state));
}

export function toggleChecklistItem(
  state: Record<string, boolean>,
  id: string,
): Record<string, boolean> {
  const next = { ...state, [id]: !state[id] };
  saveChecklistState(next);
  return next;
}

export function getSessionStartedAt(): Date {
  const existing = sessionStorage.getItem(SESSION_STARTED_KEY);
  if (existing) {
    const parsed = new Date(existing);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const started = new Date();
  sessionStorage.setItem(SESSION_STARTED_KEY, started.toISOString());
  return started;
}

export function formatSessionDuration(
  startedAt: Date,
  now = new Date(),
): string {
  const totalSeconds = Math.max(
    0,
    Math.floor((now.getTime() - startedAt.getTime()) / 1000),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

const observedHosts = new Set<string>();

function recordHost(
  url: string | URL,
  onHostsChanged?: (hosts: readonly string[]) => void,
): void {
  const sizeBefore = observedHosts.size;
  try {
    const parsed =
      typeof url === "string" ? new URL(url, window.location.href) : url;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      observedHosts.add(parsed.hostname);
    }
  } catch {
    // Ignore invalid URLs from relative paths or malformed requests.
  }
  if (observedHosts.size !== sizeBefore) {
    try {
      onHostsChanged?.([...observedHosts].sort((a, b) => a.localeCompare(b)));
    } catch {
      // A diagnostics subscriber must not change fetch/performance behavior.
    }
  }
}

export function startNetworkObserver(
  onHostsChanged?: (hosts: readonly string[]) => void,
): () => void {
  observedHosts.clear();

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === "string") {
      recordHost(input, onHostsChanged);
    } else if (input instanceof URL) {
      recordHost(input, onHostsChanged);
    } else if (input instanceof Request) {
      recordHost(input.url, onHostsChanged);
    }
    return originalFetch(input, init);
  };

  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntriesByType("resource")) {
          recordHost(entry.name, onHostsChanged);
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer?.disconnect();
      observer = undefined;
    }
  }

  return () => {
    window.fetch = originalFetch;
    observer?.disconnect();
  };
}

export function getObservedHosts(): readonly string[] {
  return [...observedHosts].sort((a, b) => a.localeCompare(b));
}

function checklistSection(
  title: string,
  items: GateChecklistItem[],
  checklist: Record<string, boolean>,
): string {
  const lines = items.map((item) => {
    const mark = checklist[item.id] ? "x" : " ";
    return `- [${mark}] ${item.label}`;
  });
  return `## ${title}\n\n${lines.join("\n")}`;
}

function inferRecommendation(
  checklist: Record<string, boolean>,
): "PASS" | "FAIL" | "PENDING" {
  const required = GATE_CHECKLIST.filter((item) => item.id !== "play-2h");
  const allRequiredChecked = required.every((item) => checklist[item.id]);
  if (allRequiredChecked && checklist["play-2h"]) return "PASS";
  if (Object.values(checklist).some(Boolean)) return "PENDING";
  return "PENDING";
}

export function formatFeasibilityReport(input: GateReportInput): string {
  const {
    environment,
    appState,
    sessionStartedAt,
    diagLog,
    checklist,
    observedHosts: hosts,
    failures,
  } = input;
  const recommendation = inferRecommendation(checklist);
  const checkedCount = Object.values(checklist).filter(Boolean).length;
  const categories = Object.keys(CATEGORY_TITLES) as GateCheckCategory[];

  const sections = categories.map((category) =>
    checklistSection(
      CATEGORY_TITLES[category],
      GATE_CHECKLIST.filter((item) => item.category === category),
      checklist,
    ),
  );

  const failureBlock =
    failures.length > 0
      ? failures.map((line) => `- ${line}`).join("\n")
      : "(none recorded — add failures from the diagnostics log if any)";

  const hostBlock =
    hosts.length > 0
      ? hosts.map((host) => `- \`${host}\``).join("\n")
      : "(none observed yet — play/search while the app runs)";

  return `# MusicKit + Tauri v2 Feasibility Report

> **Status:** ${recommendation === "PASS" ? "PASS" : recommendation === "FAIL" ? "FAIL" : "PENDING"} — generated ${new Date().toISOString()}
> Checklist: ${checkedCount}/${GATE_CHECKLIST.length} | Session: ${formatSessionDuration(sessionStartedAt)} | Tracks played: ${appState.tracksPlayed}

## Environment

| Property              | Value |
|-----------------------|-------|
| Windows Build         | ${environment.windowsBuild ?? "(fill from Settings > System > About)"} |
| Architecture          | ${environment.arch} |
| WebView2 Version      | ${environment.webviewVersion ?? "unknown"} |
| Tauri Version         | ${environment.tauriVersion} |
| App Version           | ${environment.version} |
| MusicKit JS Version   | v3 |
| Node Version          | ${environment.nodeVersion ?? "(fill from \`node -v\`)"} |
| npm Version           | ${environment.npmVersion ?? "(fill from \`npm -v\`)"} |
| Rust Toolchain        | ${environment.rustToolchain ?? "(fill from rust-toolchain.toml)"} |
| rustc                 | ${environment.rustcVersion ?? "(fill from \`rustc -V\`)"} |
| Debug build           | ${environment.debug ? "yes" : "no"} |
| Session started       | ${sessionStartedAt.toISOString()} |
| Session duration      | ${formatSessionDuration(sessionStartedAt)} |

${sections.join("\n\n")}

## Observed Network Hosts

${hostBlock}

## Observed Failures

${failureBlock}

## Diagnostics Log

\`\`\`text
${diagLog.trim() || "(empty)"}
\`\`\`

## Recommendation

- [${recommendation === "PASS" ? "x" : " "}] **PASS** — Proceed to Milestone 1
- [${recommendation === "FAIL" ? "x" : " "}] **FAIL** — Document in detail, evaluate CastLabs Electron
`;
}

export function categorizeObservedHost(
  hostname: string,
): "script" | "api" | "auth" | "media" | "other" {
  if (hostname.includes("js-cdn.music.apple.com")) return "script";
  if (hostname.includes("authorize.music.apple.com")) return "auth";
  if (hostname.includes("api.music.apple.com")) return "api";
  if (hostname.endsWith(".mzstatic.com")) return "media";
  if (hostname.endsWith(".apple.com")) return "api";
  return "other";
}

export function formatNetworkSurfaceMarkdown(hosts: readonly string[]): string {
  const grouped: Record<string, string[]> = {
    script: [],
    api: [],
    auth: [],
    media: [],
    other: [],
  };

  for (const host of hosts) {
    grouped[categorizeObservedHost(host)].push(host);
  }

  const table = (
    title: string,
    rows: string[],
    defaultPurpose: string,
  ): string => {
    if (rows.length === 0) {
      return `## ${title}\n\n| Domain | Purpose |\n|--------|---------|\n| (none observed) | ${defaultPurpose} |`;
    }
    const lines = rows.map(
      (host) => `| \`${host}\` | (confirm during testing) |`,
    );
    return `## ${title}\n\n| Domain | Purpose |\n|--------|---------|\n${lines.join("\n")}`;
  };

  return `# MusicKit Network Surface

> Observed Apple domains during Phase 0 testing.
> Generated ${new Date().toISOString()}

${table("Script Sources", grouped.script, "MusicKit JS CDN")}
${table("Connect/API Endpoints", [...grouped.api, ...grouped.other.filter((h) => h.includes("apple"))], "Apple Music API")}
${table("Authorization", grouped.auth, "OAuth popup")}
${table("Media/Artwork CDN", grouped.media, "Artwork/media streams")}

## Notes

- CSP in \`tauri.conf.json\` must match observed domains.
- Do not use broad wildcards like \`https:\` as a shortcut.
- Re-run export after search, sign-in, and full-track playback.
`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
