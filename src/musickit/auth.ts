export async function authorize(
  instance: MusicKit.MusicKitInstance,
): Promise<string> {
  return instance.authorize();
}

export async function unauthorize(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  return instance.unauthorize();
}

export function isAuthorized(instance: MusicKit.MusicKitInstance): boolean {
  return instance.isAuthorized;
}

/** Host only. Authorize URLs carry the developer JWT in the query string. */
export function describePopupUrl(url: unknown): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "host=(blank)";
  try {
    const parsed = new URL(raw, "https://authorize.music.apple.com");
    if (parsed.protocol === "about:") {
      const page = parsed.pathname.replace(/^\//u, "") || "blank";
      return `host=about:${page}`;
    }
    return `host=${parsed.hostname}`;
  } catch {
    return "host=(unparseable)";
  }
}

export function installAuthPopupProbe(
  log: (message: string) => void,
  openFn: typeof window.open = window.open.bind(window),
): () => void {
  const wrapped: typeof window.open = (...args) => {
    log(`Auth popup ${describePopupUrl(args[0])}`);
    const opened = openFn(...args);
    if (!opened) {
      log("Auth popup blocked (window.open returned null).");
    }
    return opened;
  };
  window.open = wrapped;
  return () => {
    window.open = openFn;
  };
}
