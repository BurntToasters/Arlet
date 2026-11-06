/**
 * Provider queue setup shared by Play and Play Next/Play Later. A Play
 * replaces the provider queue; an insert started while that setup runs must
 * wait for it and plan against the new queue instead of the one being
 * replaced. The generation also lets an insert abort if another setup starts
 * while its provider calls are in flight.
 */
export interface QueueSetupOwner {
  queueSetupGeneration: number;
  queueSetup: Promise<void> | undefined;
}

/** Marks provider queue setup as running until the returned release runs. */
export function beginQueueSetup(session: QueueSetupOwner): () => void {
  const generation = ++session.queueSetupGeneration;
  let settle = (): void => {};
  session.queueSetup = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    settle();
    if (session.queueSetupGeneration === generation) {
      session.queueSetup = undefined;
    }
  };
}
