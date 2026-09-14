import {
  Check,
  Download,
  ExternalLink,
  Info,
  LoaderCircle,
  MonitorCog,
  Moon,
  Palette,
  RefreshCw,
  Sun,
  UserRound,
} from "lucide-preact";
import type { JSX } from "preact";
import { useAppController, useAppState } from "../app/context.tsx";
import type {
  ThemePreference,
  UpdateChannel,
  UpdateState,
  WindowEffectPreference,
} from "../state.ts";

function updateStatusCopy(updates: UpdateState): string {
  switch (updates.status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return updates.message ?? "Downloading update…";
    case "ready":
      return updates.version
        ? `Version ${updates.version} is downloaded and ready to install.`
        : "Update downloaded and ready to install.";
    case "up-to-date":
      return "You are running the latest version.";
    case "error":
      return updates.message ?? "Unable to check for updates.";
    case "installing":
      return updates.message ?? "Installing update…";
    case "idle":
      return updates.message ?? "Updates have not been checked yet.";
  }
}

function updateChannelDescription(channel: UpdateChannel): string {
  switch (channel) {
    case "auto":
      return "Stable installs follow stable releases; beta installs follow beta releases.";
    case "stable":
      return "Only published stable releases are offered.";
    case "beta":
      return "Stable and beta preview releases are offered.";
  }
}

function initializationCopy(
  status: ReturnType<typeof useAppState>["initialization"],
): string {
  switch (status.status) {
    case "ready":
      return "MusicKit is ready";
    case "loading":
      return "Connecting to MusicKit…";
    case "error":
      return status.message;
    case "idle":
      return "MusicKit has not started";
  }
}

export function SettingsView(): JSX.Element {
  const state = useAppState();
  const controller = useAppController();
  const settings = state.settings;
  const authorized = state.auth.status === "authorized";
  const authorizationPending = state.auth.pending === true;

  const updateTheme = (event: JSX.TargetedEvent<HTMLSelectElement>): void => {
    void controller.setTheme(event.currentTarget.value as ThemePreference);
  };
  const updateEffect = (event: JSX.TargetedEvent<HTMLSelectElement>): void => {
    void controller.setWindowEffect(
      event.currentTarget.value as WindowEffectPreference,
    );
  };
  const updateChannel = (event: JSX.TargetedEvent<HTMLSelectElement>): void => {
    void controller.setUpdateChannel(
      event.currentTarget.value as UpdateChannel,
    );
  };
  const updateBusy = ["checking", "downloading", "installing"].includes(
    state.updates.status,
  );
  const updaterAvailable = !import.meta.env.DEV;
  const updateProgress =
    state.updates.progress === undefined
      ? undefined
      : Math.round(state.updates.progress * 100);

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Arlet</span>
          <h1 tabIndex={-1}>Settings</h1>
        </div>
      </div>

      <div className="settings-layout">
        <section className="settings-section" aria-labelledby="account-heading">
          <div className="settings-section-heading">
            <span className="settings-icon">
              <UserRound aria-hidden="true" size={19} strokeWidth={1.8} />
            </span>
            <div>
              <h2 id="account-heading">Account</h2>
              <p>MusicKit connection for this session.</p>
            </div>
          </div>
          <div className="account-card">
            <span className="account-avatar large" aria-hidden="true">
              <UserRound size={22} strokeWidth={1.7} />
            </span>
            <div className="account-card-copy">
              <strong>
                {authorized
                  ? "Apple Music connected"
                  : "Apple Music not connected"}
              </strong>
              <span>{initializationCopy(state.initialization)}</span>
            </div>
            {authorized ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void controller.signOut().catch(() => undefined)}
              >
                Sign out
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={
                  state.initialization.status !== "ready" ||
                  authorizationPending
                }
                onClick={() =>
                  void controller.authorize().catch(() => undefined)
                }
              >
                {authorizationPending ? "Signing in…" : "Sign in"}
              </button>
            )}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="updates-heading">
          <div className="settings-section-heading">
            <span className="settings-icon">
              <RefreshCw aria-hidden="true" size={19} strokeWidth={1.8} />
            </span>
            <div>
              <h2 id="updates-heading">Updates</h2>
              <p>Keep Arlet current with signed Windows releases.</p>
            </div>
          </div>
          <div className="settings-fields">
            <label className="settings-field settings-toggle-field">
              <span>
                <Download aria-hidden="true" size={16} strokeWidth={1.8} />{" "}
                Check for updates on startup
              </span>
              <input
                type="checkbox"
                checked={settings.autoCheckUpdates}
                disabled={updateBusy}
                onChange={(event) =>
                  void controller.setAutoCheckUpdates(
                    event.currentTarget.checked,
                  )
                }
              />
            </label>
            <label className="settings-field">
              <span>
                <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />{" "}
                Release channel
              </span>
              <select
                value={settings.updateChannel}
                disabled={updateBusy}
                onChange={updateChannel}
              >
                <option value="auto">Auto (follow installed release)</option>
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </label>
          </div>
          <p className="settings-field-help">
            {updateChannelDescription(settings.updateChannel)}
          </p>
          {!updaterAvailable ? (
            <p className="update-dev-note" role="note">
              Update checks are available in packaged builds only.
            </p>
          ) : null}
          <div
            className={`update-status update-status-${state.updates.status}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {state.updates.status === "downloading" ||
            state.updates.status === "checking" ||
            state.updates.status === "installing" ? (
              <LoaderCircle aria-hidden="true" size={15} className="spin" />
            ) : state.updates.status === "ready" ? (
              <Download aria-hidden="true" size={15} strokeWidth={1.8} />
            ) : state.updates.status === "error" ? (
              <Info aria-hidden="true" size={15} strokeWidth={1.8} />
            ) : (
              <Check aria-hidden="true" size={15} strokeWidth={1.8} />
            )}
            <span>{updateStatusCopy(state.updates)}</span>
          </div>
          {state.updates.status === "downloading" ? (
            <div
              className="update-progress"
              role="progressbar"
              aria-label="Update download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={updateProgress}
            >
              <span
                style={{
                  width: `${updateProgress ?? 0}%`,
                }}
              />
            </div>
          ) : null}
          <div className="update-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={updateBusy || !updaterAvailable}
              onClick={() => {
                if (updaterAvailable) void controller.checkForUpdates();
              }}
            >
              {updateBusy && state.updates.status === "checking"
                ? "Checking…"
                : "Check now"}
            </button>
          </div>
        </section>

        <section
          className="settings-section"
          aria-labelledby="appearance-heading"
        >
          <div className="settings-section-heading">
            <span className="settings-icon">
              <Palette aria-hidden="true" size={19} strokeWidth={1.8} />
            </span>
            <div>
              <h2 id="appearance-heading">Appearance</h2>
              <p>Choose how Arlet sits in your Windows desktop.</p>
            </div>
          </div>
          <div className="settings-fields">
            <label className="settings-field">
              <span>
                <MonitorCog aria-hidden="true" size={16} strokeWidth={1.8} />{" "}
                Theme
              </span>
              <select value={settings.theme} onChange={updateTheme}>
                <option value="system">Use system setting</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="settings-field">
              <span>
                <Palette aria-hidden="true" size={16} strokeWidth={1.8} />{" "}
                Window material
              </span>
              <select value={settings.windowEffect} onChange={updateEffect}>
                <option value="acrylic">Acrylic</option>
                <option value="mica">Mica</option>
                <option value="solid">Solid</option>
              </select>
            </label>
          </div>
          <div className="effect-status" role="status">
            {state.windowEffect.fallbackReason ? (
              <Info aria-hidden="true" size={15} strokeWidth={1.8} />
            ) : (
              <Check aria-hidden="true" size={15} strokeWidth={1.8} />
            )}
            <span>
              Requested {state.windowEffect.requested}; using{" "}
              {state.windowEffect.applied}.
            </span>
            {state.windowEffect.fallbackReason ? (
              <small>{state.windowEffect.fallbackReason}</small>
            ) : null}
          </div>
        </section>

        <section
          className="settings-section"
          aria-labelledby="accessibility-heading"
        >
          <div className="settings-section-heading">
            <span className="settings-icon">
              <Sun aria-hidden="true" size={19} strokeWidth={1.8} />
            </span>
            <div>
              <h2 id="accessibility-heading">Comfort</h2>
              <p>
                Arlet follows Windows contrast and reduced-motion preferences.
              </p>
            </div>
          </div>
          <div className="comfort-note">
            <Moon aria-hidden="true" size={17} strokeWidth={1.8} />
            <span>
              Use the system theme to keep Arlet in sync with Windows light and
              dark mode.
            </span>
          </div>
        </section>

        {import.meta.env.DEV ? (
          <section
            className="settings-section settings-developer"
            aria-labelledby="developer-heading"
          >
            <div className="settings-section-heading">
              <span className="settings-icon">
                <Info aria-hidden="true" size={19} strokeWidth={1.8} />
              </span>
              <div>
                <h2 id="developer-heading">Developer</h2>
                <p>
                  Protected playback diagnostics are available in development
                  builds.
                </p>
              </div>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                void controller.openMusicDiagnostic().catch(() => undefined)
              }
            >
              Open music.apple.com diagnostic{" "}
              <ExternalLink aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
          </section>
        ) : null}
      </div>
    </>
  );
}
