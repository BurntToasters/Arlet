import { registerLifecycleDiagnostics } from "../phase0/lifecycle.ts";
import type { DiagnosticsStore } from "./store.ts";

/** Connects the existing Phase 0 lifecycle probes to the bounded store. */
export function registerDiagnosticsLifecycle(
  store: DiagnosticsStore,
): () => void {
  return registerLifecycleDiagnostics((message) => {
    store.log(message, { source: "lifecycle" });
  });
}
