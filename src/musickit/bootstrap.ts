import {
  createNativeTokenProvider,
  type DeveloperTokenProvider,
} from "./token.ts";

export async function waitForMusicKit(timeoutMs = 10000): Promise<void> {
  if (window.MusicKit) return;
  return new Promise((resolve, reject) => {
    const onLoaded = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      document.removeEventListener("musickitloaded", onLoaded);
      reject(new Error("MusicKit JS did not load within timeout"));
    }, timeoutMs);
    document.addEventListener("musickitloaded", onLoaded, { once: true });
  });
}

export function configureMusicKit(
  developerToken: string,
): MusicKit.MusicKitInstance {
  return window.MusicKit.configure({
    developerToken,
    app: {
      name: "Arlet",
      build: __APP_VERSION__,
    },
  });
}

export async function initializeMusicKit(
  provider: DeveloperTokenProvider = createNativeTokenProvider(),
): Promise<MusicKit.MusicKitInstance> {
  const { token } = await provider.getToken();
  await waitForMusicKit();
  return configureMusicKit(token);
}
