import {
  getObservedHosts,
  startNetworkObserver,
} from "../phase0/gate-session.ts";
import type { DiagnosticsStore } from "./store.ts";

/**
 * Preserves the Phase 0 fetch/performance observer and mirrors its sanitized
 * host list into the diagnostics store whenever a host is observed.
 */
export function registerDiagnosticsNetwork(
  store: DiagnosticsStore,
): () => void {
  const stop = startNetworkObserver((hosts) => {
    store.setMetadata({ observedHosts: hosts });
  });
  store.setMetadata({ observedHosts: getObservedHosts() });
  return stop;
}
