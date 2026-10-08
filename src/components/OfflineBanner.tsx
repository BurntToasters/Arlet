import { WifiOff } from "lucide-preact";
import type { JSX } from "preact";

/**
 * Shown while MusicKit cannot start. MusicKit loads from Apple's CDN, so a
 * reload is the reliable way to retry once the connection is back.
 */
export function OfflineBanner({
  reload = () => window.location.reload(),
}: {
  reload?: () => void;
}): JSX.Element {
  return (
    <div className="offline-banner" role="status">
      <WifiOff aria-hidden="true" size={16} strokeWidth={1.9} />
      <span>
        You're offline. Showing your cached library; playback needs a
        connection.
      </span>
      <button className="secondary-button" type="button" onClick={reload}>
        Reconnect
      </button>
    </div>
  );
}
