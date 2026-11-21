import { invoke } from "@tauri-apps/api/core";
import type { InvokeFunction } from "./window.ts";

/** Mirrors `MinVersionStatus` in src-tauri/src/min_version.rs. */
export interface MinVersionStatus {
  required: boolean;
  minimum: string | null;
  current: string;
}

/** A version this build must update from before it can keep listening. */
export interface UpdateRequirement {
  current: string;
  minimum: string;
}

let requirement: UpdateRequirement | null = null;
const listeners = new Set<() => void>();

/** Asks the native side once per launch. Outside Tauri nothing is required. */
export async function getMinVersionStatus(
  invokeFn: InvokeFunction = invoke as InvokeFunction,
): Promise<MinVersionStatus> {
  try {
    return await invokeFn<MinVersionStatus>("min_version_status");
  } catch {
    return { required: false, minimum: null, current: "" };
  }
}

/** Queries the native status and records a required update, if any. Never rejects. */
export async function checkMinimumVersion(
  invokeFn?: InvokeFunction,
): Promise<void> {
  const status = await getMinVersionStatus(invokeFn);
  if (status.required && status.minimum) {
    requireUpdate({ current: status.current, minimum: status.minimum });
  }
}

function requireUpdate(next: UpdateRequirement): void {
  requirement = next;
  for (const listener of listeners) listener();
}

export function getUpdateRequirement(): UpdateRequirement | null {
  return requirement;
}

/** Runs `listener` after each change to the requirement. Returns the unsubscribe. */
export function subscribeUpdateRequirement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
