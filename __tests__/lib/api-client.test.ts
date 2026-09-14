import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
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
    expect(mapTikTokError(TIKTOK_CODE.INVALID_PARAM, "bad", "req_9").message).toContain(
      "req_9",
    );
  });

  it("treats throttling as retryable and blocked messages as not", () => {
    // The distinction that matters: 40100 is worth retrying, 40064 never is.
    expect(mapTikTokError(TIKTOK_CODE.RATE_LIMITED, "slow down")).toBeInstanceOf(
      AdapterRateLimitError,
    );
    expect(mapTikTokError(TIKTOK_CODE.MESSAGE_BLOCKED, "blocked")).not.toBeInstanceOf(
      AdapterRateLimitError,
    );
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

    await expect(
      client.request({ method: "GET", path: "business/get/" }),
    ).resolves.toEqual({ display_name: "Acme" });
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

    await expect(
      client.request({ method: "GET", path: "business/get/" }),
    ).resolves.toEqual({ retried: true });

    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
    const secondHeaders = fetchImpl.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(secondHeaders["Access-Token"]).toBe("token_new");
  });

  it("gives up after a second token rejection instead of looping", async () => {
    const fetchImpl = vi.fn(async () =>
      envelope(TIKTOK_CODE.INVALID_ACCESS_TOKEN, {}, "bad token"),
    );
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(
      client.request({ method: "GET", path: "business/get/" }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("wraps transport failures as NetworkError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(
      client.request({ method: "GET", path: "business/get/" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("wraps a non-JSON body as NetworkError rather than crashing", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    }));
    const client = new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });

    await expect(
      client.request({ method: "GET", path: "business/get/" }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
