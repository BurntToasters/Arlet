export async function waitForMusicKit(timeoutMs = 10000): Promise<void> {
  if (window.MusicKit) return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MusicKit JS did not load within timeout")),
      timeoutMs,
    );
    document.addEventListener("musickitloaded", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function configureMusicKit(
  developerToken: string,
): MusicKit.MusicKitInstance {
  return window.MusicKit.configure({
    developerToken,
    app: {
      name: "Arlet",
      build: "0.1.0",
    },
  });
}

export async function initializeMusicKit(): Promise<MusicKit.MusicKitInstance> {
  const token = import.meta.env.VITE_MUSICKIT_DEVELOPER_TOKEN;
  if (!token) {
    throw new Error(
      "VITE_MUSICKIT_DEVELOPER_TOKEN is not set. " +
        "Create a .env.local file with your developer token.",
    );
  }
  await waitForMusicKit();
  return configureMusicKit(token);
}
