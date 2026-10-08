import { describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_RETRY_DELAYS_MS,
  createMusicRequest,
} from "../musickit/catalog.ts";

type Music = (
  path: string,
  query?: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;

function rateLimited(retryAfter?: string): Error {
  return Object.assign(new Error("Request failed with status 429"), {
    status: 429,
    ...(retryAfter
      ? { response: { headers: new Headers({ "retry-after": retryAfter }) } }
      : {}),
  });
}

const storefront = {
  data: [
    {
      id: "ca",
      attributes: {
        defaultLanguageTag: "en-CA",
        supportedLanguageTags: ["en-CA", "fr-CA"],
      },
    },
  ],
};

function setup(music: Music, language = "en-CA") {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const request = createMusicRequest(
    {
      storefrontId: "ca",
      api: { music },
    } as unknown as MusicKit.MusicKitInstance,
    { sleep, languages: () => [language] },
  );
  return { request, sleep };
}

// Failure modes: one 429 fails a whole library load; retries ignore
// Retry-After or never stop; writes (POST) are replayed; catalog text is
// always in the storefront default language; an unsupported language tag
// is sent to Apple; a failed storefront lookup breaks every request.
describe("MusicKit request wrapper", () => {
  it("retries a rate-limited read, honouring a capped Retry-After", async () => {
    const music = vi
      .fn<Music>()
      .mockRejectedValueOnce(rateLimited("2"))
      .mockResolvedValueOnce({ data: ["ok"] });
    const { request, sleep } = setup(music);
    await expect(request("/v1/me/library/songs")).resolves.toEqual({
      data: ["ok"],
    });
    expect(music).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);

    const capped = vi
      .fn<Music>()
      .mockRejectedValueOnce(rateLimited("3600"))
      .mockResolvedValueOnce({});
    const second = setup(capped);
    await second.request("/v1/me/library/songs");
    expect(second.sleep).toHaveBeenCalledWith(10_000);
  });

  it("gives up after the bounded retries and never replays writes", async () => {
    const always = vi.fn<Music>().mockRejectedValue(rateLimited());
    const { request, sleep } = setup(always);
    await expect(request("/v1/me/library/songs")).rejects.toThrow(/429/u);
    expect(always).toHaveBeenCalledTimes(RATE_LIMIT_RETRY_DELAYS_MS.length + 1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      ...RATE_LIMIT_RETRY_DELAYS_MS,
    ]);

    const post = vi.fn<Music>().mockRejectedValue(rateLimited());
    await expect(
      setup(post).request("/v1/me/library/playlists", undefined, {
        method: "POST",
      }),
    ).rejects.toThrow();
    expect(post).toHaveBeenCalledOnce();

    const other = vi.fn<Music>().mockRejectedValue(new Error("403"));
    await expect(
      setup(other).request("/v1/me/library/songs"),
    ).rejects.toThrow();
    expect(other).toHaveBeenCalledOnce();
  });

  it("localizes catalog reads to a supported language only", async () => {
    const music = vi.fn<Music>(async (path) =>
      path === "/v1/storefronts/ca" ? storefront : { data: [] },
    );
    const { request } = setup(music, "fr-FR");
    await request("/v1/catalog/ca/search", { term: "x" });
    await request("/v1/catalog/ca/charts");
    await request("/v1/me/library/songs", { limit: 5 });
    expect(music.mock.calls).toEqual([
      ["/v1/storefronts/ca"],
      ["/v1/catalog/ca/search", { term: "x", l: "fr-CA" }],
      ["/v1/catalog/ca/charts", { l: "fr-CA" }],
      ["/v1/me/library/songs", { limit: 5 }],
    ]);

    const unsupported = vi.fn<Music>(async (path) =>
      path === "/v1/storefronts/ca" ? storefront : { data: [] },
    );
    await setup(unsupported, "ja-JP").request("/v1/catalog/ca/search", {
      term: "x",
    });
    expect(unsupported).toHaveBeenLastCalledWith("/v1/catalog/ca/search", {
      term: "x",
    });
  });

  it("keeps working when the storefront lookup fails", async () => {
    const music = vi.fn<Music>(async (path) => {
      if (path === "/v1/storefronts/ca") throw new Error("offline");
      return { data: [] };
    });
    const { request } = setup(music, "fr-CA");
    await expect(
      request("/v1/catalog/ca/search", { term: "x" }),
    ).resolves.toEqual({ data: [] });
    expect(music).toHaveBeenLastCalledWith("/v1/catalog/ca/search", {
      term: "x",
    });
  });
});
