export type LifecycleLog = (message: string) => void;

export function registerLifecycleDiagnostics(log: LifecycleLog): () => void {
  const onVisibility = (): void => {
    log(`lifecycle: visibility ${document.visibilityState}`);
  };
  const onOnline = (): void => {
    log("lifecycle: network online");
  };
  const onOffline = (): void => {
    log("lifecycle: network offline");
  };
  const onFocus = (): void => {
    log("lifecycle: window focus");
  };
  const onBlur = (): void => {
    log("lifecycle: window blur");
  };
  const onDeviceChange = (): void => {
    log("lifecycle: audio device change");
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
  };
}
