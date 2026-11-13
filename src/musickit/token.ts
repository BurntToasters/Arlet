import { invoke } from "@tauri-apps/api/core";
import type { AppErrorCode } from "../domain/errors.ts";

// Developer-token sourcing. Release builds get the token from the native
// `get_developer_token` command, which downloads a signed hosted file at launch,
// verifies it, and caches it. Debug builds read `.env` through the same command.
// The JWT is never a Vite/VITE_ frontend env var, and the `.p8` private key is
// never shipped or committed.

export interface DeveloperToken {
  token: string;
  source: "env";
}

export interface DeveloperTokenProvider {
  getToken(): Promise<DeveloperToken>;
}

export type InvokeFn = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function createNativeTokenProvider(
  invokeFn: InvokeFn = invoke as InvokeFn,
): DeveloperTokenProvider {
  return {
    async getToken(): Promise<DeveloperToken> {
      let token: string;
      try {
        token = await invokeFn<string>("get_developer_token");
      } catch (error) {
        // Tauri rejects command errors with a plain string, which carries
        // the native command's message (token unavailable or expired).
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string" && error.trim()
              ? error
              : "MusicKit developer token is not available.";
        // Only an expired token is TOKEN_EXPIRED: it shows the expiry notice.
        // A token that cannot be downloaded is MUSICKIT_INIT_FAILED.
        const code: AppErrorCode = /expired/iu.test(message)
          ? "TOKEN_EXPIRED"
          : "MUSICKIT_INIT_FAILED";
        throw Object.assign(new Error(message), { code });
      }
      if (typeof token !== "string" || !token.trim()) {
        throw Object.assign(
          new Error(
            "MUSICKIT_DEVELOPER_TOKEN is not set. " +
              "Copy .env.example to .env and set your Apple Music developer token.",
          ),
          { code: "MUSICKIT_INIT_FAILED" satisfies AppErrorCode },
        );
      }
      return { token, source: "env" };
    },
  };
}

/** Expiry (epoch ms) of a developer JWT; undefined when unreadable. */
export function developerTokenExpiry(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload || !/^[A-Za-z0-9_-]+$/u.test(payload)) return undefined;
  try {
    const base64 = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const exp = (JSON.parse(atob(base64)) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp)
      ? exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}
