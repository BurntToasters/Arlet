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

export function isAuthorized(
  instance: MusicKit.MusicKitInstance,
): boolean {
  return instance.isAuthorized;
}
