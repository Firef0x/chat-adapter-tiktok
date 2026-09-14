import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AccessTokenProvider,
  mapTikTokError,
  TikTokApiClient,
} from "../../src/lib/api-client.js";
import { TIKTOK_CODE } from "../../src/types.js";

function envelope(code: number, data: unknown = {}, message = "OK") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code, message, request_id: "req_1", data }),
  } as unknown as Response;
}

function tokenProvider(): AccessTokenProvider & {
  getAccessToken: ReturnType<typeof vi.fn>;
  refreshAccessToken: ReturnType<typeof vi.fn>;
} {
  return {
    getAccessToken: vi.fn(async () => "token_old"),
    refreshAccessToken: vi.fn(async () => "token_new"),
  };
}

describe("mapTikTokError", () => {
  it.each([
    [TIKTOK_CODE.RATE_LIMITED, AdapterRateLimitError],
    [TIKTOK_CODE.SYSTEM_ERROR, NetworkError],
    [TIKTOK_CODE.INVALID_ACCESS_TOKEN, AuthenticationError],
    [TIKTOK_CODE.NO_PERMISSION, PermissionError],
    [TIKTOK_CODE.MESSAGE_BLOCKED, ValidationError],
    [TIKTOK_CODE.INVALID_PARAM, ValidationError],
  ])("maps code %i to the right error class", (code, expected) => {
    expect(mapTikTokError(code, "boom", "req_9")).toBeInstanceOf(expected);
  });

  it("keeps the request ID so failures can be traced with TikTok support", () => {
    expect(mapTikTokError(TIKTOK_CODE.INVALID_PARAM, "bad", "req_9").message).toContain("req_9");
  });

  it("treats throttling as retryable and blocked messages as not", () => {
    // The distinction that matters: 40100 is worth retrying, 40064 never is.
    expect(mapTikTokError(TIKTOK_CODE.RATE_LIMITED, "slow down")).toBeInstanceOf(
      AdapterRateLimitError,
    );
    expect(mapTikTokError(TIKTOK_CODE.MESSAGE_BLOCKED, "blocked")).toBeInstanceOf(ValidationError);
  });

  it("maps the remaining documented codes", () => {
    expect(mapTikTokError(TIKTOK_CODE.NOT_FOUND, "gone")).toBeInstanceOf(ResourceNotFoundError);
    expect(mapTikTokError(TIKTOK_CODE.UNSUPPORTED_FILE_TYPE, "nope")).toBeInstanceOf(
      ValidationError,
    );
  });

  it("treats an unknown code as retryable rather than permanent", () => {
    // A code TikTok adds later is most likely transient. Classifying it
    // non-retryable would discard messages that would have succeeded.
    expect(mapTikTokError(59_999, "brand new")).toBeInstanceOf(NetworkError);
  });
});

describe("TikTokApiClient", () => {
  let tokens: ReturnType<typeof tokenProvider>;

  beforeEach(() => {
    tokens = tokenProvider();
  });

  it("builds URLs with the version segment and trailing slash intact", () => {
    const client = new TikTokApiClient({ tokens });
    expect(client.buildUrl("business/message/send/")).toBe(
      "https://business-api.tiktok.com/open_api/v1.3/business/message/send/",
    );
  });

  it("percent-encodes `+` in conversation IDs", () => {
    // TikTok rejects a literal `+` here, reading it as a space.
    const client = new TikTokApiClient({ tokens });
    const url = client.buildUrl("business/message/content/list/", {
      conversation_id: "a1Abc+lmGn==",
    });
    expect(url).toContain("conversation_id=a1Abc%2BlmGn%3D%3D");
    expect(url).not.toContain("a1Abc+lmGn");
  });

  it("sends the custom Access-Token header rather than a Bearer token", async () => {
    const fetchImpl = vi.fn(async () => envelope(0, { ok: true }));
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await client.request({ method: "GET", path: "business/get/" });

    const headers = fetchImpl.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers["Access-Token"]).toBe("token_old");
    expect(headers.Authorization).toBeUndefined();
  });

  it("unwraps the data field on success", async () => {
    const fetchImpl = vi.fn(async () => envelope(0, { display_name: "Acme" }));
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(client.request({ method: "GET", path: "business/get/" })).resolves.toEqual({
      display_name: "Acme",
    });
  });

  it("treats a non-zero code on an HTTP 200 as a failure", async () => {
    // This is the trap: the HTTP status says success, the envelope says no.
    const fetchImpl = vi.fn(async () =>
      envelope(TIKTOK_CODE.INVALID_PARAM, {}, "Param is invalid"),
    );
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(
      client.request({ method: "POST", path: "business/message/send/" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refreshes once and retries when the token is rejected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope(TIKTOK_CODE.INVALID_ACCESS_TOKEN, {}, "bad token"))
      .mockResolvedValueOnce(envelope(0, { retried: true }));
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(client.request({ method: "GET", path: "business/get/" })).resolves.toEqual({
      retried: true,
    });

    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    const secondHeaders = fetchImpl.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(secondHeaders["Access-Token"]).toBe("token_new");
  });

  it("gives up after a second token rejection instead of looping", async () => {
    const fetchImpl = vi.fn(async () =>
      envelope(TIKTOK_CODE.INVALID_ACCESS_TOKEN, {}, "bad token"),
    );
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("wraps transport failures as NetworkError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("rejects a body whose code is not a number", async () => {
    // Valid JSON from a gateway still says nothing about the request, so it
    // must not be unwrapped as though it came from the API.
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => ({ error: "upstream unavailable" }),
    }));
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it("clamps a non-numeric retry setting instead of looping forever", async () => {
    // `?? 2` lets NaN through, and `attempt >= NaN` is never true.
    const fetchImpl = vi.fn(async () => envelope(TIKTOK_CODE.RATE_LIMITED, {}, "slow down"));
    const client = new TikTokApiClient({
      tokens,
      fetchImpl: fetchImpl as never,
      maxRateLimitRetries: Number.NaN,
      sleepImpl: async () => {},
    });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // the default bound, not unbounded
  });

  it("wraps a non-JSON body as NetworkError rather than crashing", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    }));
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

describe("rate-limit backoff", () => {
  function clientWithSleep(fetchImpl: unknown, overrides: Record<string, unknown> = {}) {
    const slept: number[] = [];
    const client = new TikTokApiClient({
      tokens: tokenProvider(),
      fetchImpl: fetchImpl as never,
      sleepImpl: async (ms: number) => {
        slept.push(ms);
      },
      ...overrides,
    });
    return { client, slept };
  }

  it("retries a throttled request and returns the eventual success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope(TIKTOK_CODE.RATE_LIMITED, {}, "slow down"))
      .mockResolvedValueOnce(envelope(0, { ok: true }));
    const { client, slept } = clientWithSleep(fetchImpl);

    await expect(client.request({ method: "GET", path: "business/get/" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([1000]);
  });

  it("backs off exponentially and gives up after the configured attempts", async () => {
    // TikTok's own recovery for a per-minute overage is five minutes, so this
    // cannot rescue a sustained overage — only a brief burst.
    const fetchImpl = vi.fn(async () => envelope(TIKTOK_CODE.RATE_LIMITED, {}, "slow down"));
    const { client, slept } = clientWithSleep(fetchImpl);

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(slept).toEqual([1000, 2000]);
  });

  it("does not retry when disabled", async () => {
    const fetchImpl = vi.fn(async () => envelope(TIKTOK_CODE.RATE_LIMITED, {}, "slow down"));
    const { client, slept } = clientWithSleep(fetchImpl, { maxRateLimitRetries: 0 });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("honours a custom initial delay", async () => {
    const fetchImpl = vi.fn(async () => envelope(TIKTOK_CODE.RATE_LIMITED, {}, "slow down"));
    const { client, slept } = clientWithSleep(fetchImpl, { rateLimitRetryDelayMs: 50 });

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toThrow();
    expect(slept).toEqual([50, 100]);
  });

  it("does not retry a failure that is not throttling", async () => {
    // Retrying a validation error wastes quota and can never succeed.
    const fetchImpl = vi.fn(async () => envelope(TIKTOK_CODE.INVALID_PARAM, {}, "bad"));
    const { client, slept } = clientWithSleep(fetchImpl);

    await expect(client.request({ method: "GET", path: "business/get/" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("refreshes at most once per attempt, not once per send", async () => {
    // Each refresh rotates the refresh token, so the count is not free — and
    // asserting only the final value would pass even if every send refreshed.
    const tokens = tokenProvider();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope(TIKTOK_CODE.INVALID_ACCESS_TOKEN, {}, "bad token"))
      .mockResolvedValueOnce(envelope(TIKTOK_CODE.RATE_LIMITED, {}, "slow down"))
      .mockResolvedValueOnce(envelope(0, { ok: true }));
    const client = new TikTokApiClient({
      tokens,
      fetchImpl: fetchImpl as never,
      sleepImpl: async () => {},
    });

    await expect(client.request({ method: "GET", path: "business/get/" })).resolves.toEqual({
      ok: true,
    });

    // One rejection happened, so exactly one refresh — the second attempt saw
    // throttling, not a token problem.
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
