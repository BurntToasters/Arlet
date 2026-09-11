import { describe, expect, it, vi } from "vitest";
import {
  createNativeTokenProvider,
  createServiceTokenProvider,
} from "../musickit/token.ts";

describe("createNativeTokenProvider", () => {
  it("returns the token from the debug Tauri command", async () => {
    const invokeFn = vi.fn().mockResolvedValue("dev-token");
    const provider = createNativeTokenProvider(invokeFn);
    await expect(provider.getToken()).resolves.toEqual({
      token: "dev-token",
      source: "env",
    });
    expect(invokeFn).toHaveBeenCalledWith("get_developer_token");
  });

  it("throws a typed error when unset", async () => {
    const invokeFn = vi
      .fn()
      .mockRejectedValue(
        new Error("MUSICKIT_DEVELOPER_TOKEN is not set. .env"),
      );
    const provider = createNativeTokenProvider(invokeFn);
    await expect(provider.getToken()).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
    });
    await expect(provider.getToken()).rejects.toThrow(/\.env/);
    await expect(provider.getToken()).rejects.not.toThrow(/\.env\.local/);
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
