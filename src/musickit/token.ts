import { invoke } from "@tauri-apps/api/core";
import type { AppErrorCode } from "../domain/errors.ts";
import { mapErrorToCode } from "./errors.ts";

// Developer-token sourcing (plan section 5.2/5.3). Production obtains a
// short-lived token from a small HTTPS token service. Local Phase 0 reads
// `MUSICKIT_DEVELOPER_TOKEN` from `.env` via a debug-only Tauri command so
// the JWT is never a Vite/VITE_ frontend env var. The `.p8` private key is
// never shipped, bundled, or committed.

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
        throw Object.assign(
          new Error(
            error instanceof Error
              ? error.message
              : "MUSICKIT_DEVELOPER_TOKEN is not available. " +
                  "Copy .env.example to .env and run npm run tauri:dev.",
          ),
          { code: "TOKEN_EXPIRED" satisfies AppErrorCode },
        );
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
