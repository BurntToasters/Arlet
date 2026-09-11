import { describe, expect, it, vi } from "vitest";
import {
  createEnvTokenProvider,
  createServiceTokenProvider,
} from "../musickit/token.ts";

describe("createEnvTokenProvider", () => {
  it("returns the configured token", async () => {
    const provider = createEnvTokenProvider({
      VITE_MUSICKIT_DEVELOPER_TOKEN: "dev-token",
    });
    await expect(provider.getToken()).resolves.toEqual({
      token: "dev-token",
      source: "env",
    });
  });

  it("throws a typed error when unset", async () => {
    const provider = createEnvTokenProvider({});
    await expect(provider.getToken()).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
  });
});

describe("createServiceTokenProvider", () => {
  it("returns the service token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: "short-lived" }),
    });
    const provider = createServiceTokenProvider(
      "https://tokens.example/token",
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.getToken()).resolves.toEqual({
      token: "short-lived",
      source: "service",
    });
  });

  it("rejects non-OK responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });
    const provider = createServiceTokenProvider(
      "https://tokens.example/token",
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.getToken()).rejects.toThrow("503");
  });

  it("rejects empty token payloads", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const provider = createServiceTokenProvider(
      "https://tokens.example/token",
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.getToken()).rejects.toThrow("no token");
  });
});
