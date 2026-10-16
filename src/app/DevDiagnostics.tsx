import { useMemo } from "preact/hooks";
import type { JSX } from "preact";
import { clearDiagnosticLogs } from "../state.ts";
import type { AppController } from "./controller.ts";
import { useAppController, useAppSelector, useAppSlices } from "./context.tsx";
import { DiagnosticsDrawer } from "../components/diagnostics/DiagnosticsDrawer.tsx";
import type { DiagnosticsDrawerController } from "../diagnostics/types.ts";
import type { DiagnosticsStore } from "../diagnostics/store.ts";

export function diagnosticsController(
  controller: AppController,
): DiagnosticsDrawerController {
  return {
    onClearSession: () => {
      clearDiagnosticLogs();
    },
    onOpenMusicDiagnostic: async () => {
      await controller.openMusicDiagnostic();
    },
    onQueueConsecutive: () => controller.playConsecutive(),
  };
}

/** Only the open drawer subscribes to diagnostics, search and tracks played. */
function DiagnosticsPanel({
  diagnosticsStore,
}: {
  diagnosticsStore?: DiagnosticsStore;
}): JSX.Element {
  const state = useAppSlices("diagnostics", "search", "tracksPlayed");
  const playbackStatus = useAppSelector((store) => store.playback.status);
  const controller = useAppController();
  const drawerController = useMemo(
    () => diagnosticsController(controller),
    [controller],
  );
  return (
    <DiagnosticsDrawer
      open
      onClose={controller.closeDiagnostics}
      store={diagnosticsStore}
      appSnapshot={{
        tracksPlayed: state.tracksPlayed,
        playbackStatus,
        failures: state.diagnostics.failures,
        sessionStartedAt: new Date(state.diagnostics.sessionStartedAt),
        consecutiveQueueReady:
          state.search.results.length >= controller.consecutiveTrackTarget,
      }}
      controller={drawerController}
    />
  );
}

/**
 * Dev-only diagnostics wiring. The `import.meta.env.DEV` guard lets the
 * production build drop the drawer, as it did when it lived in AppLayout.
 */
export function DevDiagnostics({
  diagnosticsStore,
}: {
  diagnosticsStore?: DiagnosticsStore;
}): JSX.Element | null {
  const open = useAppSelector((store) => store.ui.diagnosticsOpen);
  return open && import.meta.env.DEV ? (
    <DiagnosticsPanel diagnosticsStore={diagnosticsStore} />
  ) : null;
}
