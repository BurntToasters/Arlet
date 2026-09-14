import { render } from "preact";
import { App } from "./app/App.tsx";
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
  render(
    <App
      controller={appController}
      router={router}
      diagnosticsStore={diagnosticsStore}
    />,
    mount,
  );
  void initializeApplication(appController, diagnosticsStore);
}
