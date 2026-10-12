import { render } from "preact";
import { App } from "./app/App.tsx";
import { safeErrorMessage } from "./app/controller-support.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { createAppController } from "./app/controller.ts";
import { initializeApplication } from "./app-init.ts";
import { createHashRouter } from "./routing/router.ts";
import { setNavigation } from "./state.ts";
import {
  DiagnosticsStore,
  createTauriDiagnosticsAdapter,
} from "./diagnostics/index.ts";
import "./styles/tokens.css";
import "./styles/base.css";

const mount = document.getElementById("app");

if (mount) {
  const diagnosticsStore = new DiagnosticsStore({
    persistence: createTauriDiagnosticsAdapter(),
  });
  // The controller remains the owner of MusicKit; the diagnostics store only
  // receives already-redacted log messages.
  const appController = createAppController({ diagnosticsStore });
  const router = createHashRouter();
  router.subscribe((route) => setNavigation(route));
  router.start();
  // Last resort if the shell itself fails to render: the window is
  // frameless, so a blank page would leave no way to recover but the tray.
  render(
    <ErrorBoundary
      onError={(error) =>
        appController.log(`Arlet failed to render: ${safeErrorMessage(error)}`)
      }
      fallback={() => (
        <section className="empty-state fatal-render-error">
          <h2>Arlet ran into a problem</h2>
          <p>Reload to continue. The problem was saved to Arlet's log.</p>
          <div className="empty-action">
            <button
              className="primary-button"
              type="button"
              onClick={() => location.reload()}
            >
              Reload Arlet
            </button>
          </div>
        </section>
      )}
    >
      <App
        controller={appController}
        router={router}
        diagnosticsStore={diagnosticsStore}
      />
    </ErrorBoundary>,
    mount,
  );
  void initializeApplication(appController, diagnosticsStore);
}
