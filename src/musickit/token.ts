import { invoke } from "@tauri-apps/api/core";
import type { AppErrorCode } from "../domain/errors.ts";
import { mapErrorToCode } from "./errors.ts";

// Developer-token sourcing. `get_developer_token` serves `.env` at runtime in
// debug builds and, in release builds, the token `build.rs` validated and
// compiled from the release machine's `.env`. The JWT is never a Vite/VITE_
// frontend env var, and the `.p8` private key is never shipped or committed.
// `createServiceTokenProvider` remains for a future hosted token service.

export interface DeveloperToken {
  token: string;
  source: "env" | "service";
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
        // the release-build message (missing or expired embedded token).
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string" && error.trim()
              ? error
              : "MusicKit developer token is not available.";
        throw Object.assign(new Error(message), {
          code: "TOKEN_EXPIRED" satisfies AppErrorCode,
        });
      }
      if (typeof token !== "string" || !token.trim()) {
        throw Object.assign(
          new Error(
            "MUSICKIT_DEVELOPER_TOKEN is not set. " +
              "Copy .env.example to .env and set your Apple Music developer token.",
          ),
          { code: "TOKEN_EXPIRED" satisfies AppErrorCode },
        );
      }
      return { token, source: "env" };
    },
  };
}

export function createServiceTokenProvider(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): DeveloperTokenProvider {
  return {
    async getToken(): Promise<DeveloperToken> {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, { method: "GET" });
      } catch (error) {
        throw new Error(
          `Developer token service unreachable: ${mapErrorToCode(error)}`,
        );
      }
      if (!response.ok) {
        throw new Error(`Developer token service returned ${response.status}`);
      }
      const data = (await response.json()) as { token?: unknown };
      if (typeof data.token !== "string" || !data.token) {
        throw new Error("Developer token service returned no token");
      }
      return { token: data.token, source: "service" };
    },
  };
}
