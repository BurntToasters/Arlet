import type { AppErrorCode } from "../domain/errors.ts";
import { mapErrorToCode } from "./errors.ts";

// Developer-token sourcing (plan section 5.2/5.3). Production must obtain a
// short-lived token from a small HTTPS token service; only local development
// may use a manually generated token from `.env.local`. The `.p8` private key
// is never shipped, bundled, or committed.

export interface DeveloperToken {
  token: string;
  source: "env" | "service";
}

export interface DeveloperTokenProvider {
  getToken(): Promise<DeveloperToken>;
}

export function createEnvTokenProvider(
  env: Record<string, string | undefined> = import.meta.env,
): DeveloperTokenProvider {
  return {
    async getToken(): Promise<DeveloperToken> {
      const token = env.VITE_MUSICKIT_DEVELOPER_TOKEN;
      if (!token) {
        throw Object.assign(
          new Error(
            "VITE_MUSICKIT_DEVELOPER_TOKEN is not set. " +
              "Create a .env.local file with your developer token.",
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
