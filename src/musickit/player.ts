export const CONSECUTIVE_TRACK_TARGET = 20;

export async function playQueue(
  instance: MusicKit.MusicKitInstance,
  songIds: readonly string[],
  startIndex = 0,
): Promise<void> {
  if (songIds.length === 0) {
    throw new Error("Queue is empty");
  }
  const start = Math.max(0, Math.min(startIndex, songIds.length - 1));
  await instance.setQueue({ songs: [...songIds.slice(start)] });
  await instance.play();
}

export async function playSong(
  instance: MusicKit.MusicKitInstance,
  songId: string,
): Promise<void> {
  await playQueue(instance, [songId]);
}

export async function pause(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  instance.pause();
}

export async function resume(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  await instance.play();
}

export async function toggle(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  if (instance.playbackState === MusicKit.PlaybackStates.playing) {
    instance.pause();
  } else {
    await instance.play();
  }
}

export async function seekToTime(
  instance: MusicKit.MusicKitInstance,
  seconds: number,
): Promise<void> {
  await instance.seekToTime(seconds);
}

export async function skipToNext(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  await instance.skipToNextItem();
}

export async function skipToPrevious(
  instance: MusicKit.MusicKitInstance,
): Promise<void> {
  await instance.skipToPreviousItem();
}

export function setVolume(
  instance: MusicKit.MusicKitInstance,
  volume: number,
): void {
  instance.volume = Math.max(0, Math.min(1, volume));
}
