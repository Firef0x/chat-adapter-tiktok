import { AuthenticationError, NetworkError, PermissionError } from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeAuthCode,
  getTokenInfo,
  missingMessagingScopes,
  revokeAccessToken,
  splitScopes,
  TIKTOK_AUTHORIZE_URL,
} from "../../src/lib/oauth.js";
import { TIKTOK_CODE, TIKTOK_MESSAGING_SCOPES } from "../../src/types.js";

const NOW = 1_700_000_000_000;

function tokenEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    json: async () => ({
      code: 0,
      message: "OK",
      request_id: "req_1",
      data: {
        access_token: "access_1",
        token_type: "Bearer",
        scope: "message.list.read,message.list.send",
        expires_in: 86_400,
        refresh_token: "refresh_1",
        refresh_token_expires_in: 31_536_000,
        open_id: "biz_123",
        ...overrides,
      },
    }),
  } as unknown as Response;
}

function infoEnvelope(data: unknown) {
  return {
    status: 200,
    json: async () => ({ code: 0, message: "OK", request_id: "req_1", data }),
  } as unknown as Response;
}

function errorEnvelope(code: number, message = "nope") {
  return {
    status: 200,
    json: async () => ({ code, message, request_id: "req_1", data: {} }),
  } as unknown as Response;
}

function exchange(fetchImpl: unknown) {
  return exchangeAuthCode({
    appId: "app_1",
    appSecret: "secret_1",
    authCode: "code_1",
    redirectUri: "https://example.com/cb",
    fetchImpl: fetchImpl as never,
    now: () => NOW,
  });
}

describe("buildAuthorizeUrl", () => {
  it("names the app client_key, as the authorize leg requires", () => {
    // The token leg calls the same value client_id. Mixing them up fails with
    // an unhelpful error.
    const url = new URL(
      buildAuthorizeUrl({
        appId: "app_1",
        redirectUri: "https://example.com/cb",
        state: "xyz",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(TIKTOK_AUTHORIZE_URL);
    expect(url.searchParams.get("client_key")).toBe("app_1");
    expect(url.searchParams.get("client_id")).toBeNull();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  it("defaults to the messaging scopes, comma separated", () => {
    const url = new URL(
      buildAuthorizeUrl({
        appId: "app_1",
        redirectUri: "https://example.com/cb",
        state: "xyz",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "message.list.read,message.list.send,message.list.manage",
    );
  });

  it("honours explicit scopes", () => {
    const url = new URL(
      buildAuthorizeUrl({
        appId: "app_1",
        redirectUri: "https://example.com/cb",
        state: "xyz",
        scopes: ["user.info.basic"],
      }),
    );
    expect(url.searchParams.get("scope")).toBe("user.info.basic");
  });

  it("can force the consent screen", () => {
    const url = new URL(
      buildAuthorizeUrl({
        appId: "app_1",
        redirectUri: "https://example.com/cb",
        state: "xyz",
        forceConsent: true,
      }),
    );
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
  });

  it("percent-encodes the redirect URI", () => {
    const url = buildAuthorizeUrl({
      appId: "app_1",
      redirectUri: "https://example.com/cb?a=1&b=2",
      state: "xyz",
    });
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Fa%3D1%26b%3D2");
  });
});

describe("exchangeAuthCode", () => {
  it("posts auth_code and client_id with no auth header", async () => {
    // TikTok names the field auth_code, not the usual `code`.
    const fetchImpl = vi.fn(async () => tokenEnvelope());
    await exchange(fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/open_api/v1.3/tt_user/oauth2/token/");
    expect((init.headers as Record<string, string>)["Access-Token"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "app_1",
      client_secret: "secret_1",
      grant_type: "authorization_code",
      auth_code: "code_1",
      redirect_uri: "https://example.com/cb",
    });
  });

  it("returns credentials shaped for the adapter config", async () => {
    await expect(exchange(vi.fn(async () => tokenEnvelope()))).resolves.toEqual({
      accessToken: "access_1",
      refreshToken: "refresh_1",
      accessTokenExpiresAt: NOW + 86_400 * 1000,
      refreshTokenExpiresAt: NOW + 31_536_000 * 1000,
      businessId: "biz_123",
      scopes: ["message.list.read", "message.list.send"],
    });
  });

  it("maps open_id to businessId, since they are the same value", async () => {
    const tokens = await exchange(vi.fn(async () => tokenEnvelope({ open_id: "other" })));
    expect(tokens.businessId).toBe("other");
  });

  it("explains that a rejected code is single-use and short-lived", async () => {
    // The likeliest cause is a replayed or stale code, and the operator needs
    // to know retrying the same one cannot work.
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.INVALID_PARAM));
    await expect(exchange(fetchImpl)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(exchange(fetchImpl)).rejects.toThrow(/only be used once/);
  });

  it("keeps a throttled exchange retryable", async () => {
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.RATE_LIMITED));
    await expect(exchange(fetchImpl)).rejects.toBeInstanceOf(NetworkError);
  });

  it("wraps transport and non-JSON failures as network faults", async () => {
    await expect(
      exchange(
        vi.fn(async () => {
          throw new Error("ECONNRESET");
        }),
      ),
    ).rejects.toBeInstanceOf(NetworkError);

    await expect(
      exchange(
        vi.fn(async () => ({
          status: 502,
          json: async () => {
            throw new Error("Unexpected token <");
          },
        })),
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("refuses an incomplete token response rather than returning junk", async () => {
    // Half-populated credentials would be persisted and fail much later.
    await expect(
      exchange(vi.fn(async () => tokenEnvelope({ refresh_token: undefined }))),
    ).rejects.toThrow(/incomplete token response/);
  });
});

describe("revokeAccessToken", () => {
  it("names the app client_id, matching the token endpoints", async () => {
    // Deliberately different from token_info, which calls the same value
    // app_id — three naming conventions exist across this API.
    const fetchImpl = vi.fn(async () => infoEnvelope({}));

    await revokeAccessToken({
      appId: "app_1",
      appSecret: "secret_1",
      accessToken: "access_1",
      fetchImpl: fetchImpl as never,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/open_api/v1.3/tt_user/oauth2/revoke/");
    expect((init.headers as Record<string, string>)["Access-Token"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "app_1",
      client_secret: "secret_1",
      access_token: "access_1",
    });
  });

  it("surfaces a rejected revocation rather than resolving quietly", async () => {
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.NO_PERMISSION));

    await expect(
      revokeAccessToken({
        appId: "app_1",
        appSecret: "secret_1",
        accessToken: "access_1",
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("wraps a transport failure as a network fault", async () => {
    await expect(
      revokeAccessToken({
        appId: "app_1",
        appSecret: "secret_1",
        accessToken: "access_1",
        fetchImpl: vi.fn(async () => {
          throw new Error("ECONNRESET");
        }) as never,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("getTokenInfo", () => {
  it("names the app app_id and sends no secret", async () => {
    // The access token alone identifies the grant here.
    const fetchImpl = vi.fn(async () =>
      infoEnvelope({ app_id: "app_1", creator_id: "biz_123", scope: "message.list.read" }),
    );

    await getTokenInfo({ appId: "app_1", accessToken: "access_1", fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/open_api/v1.3/tt_user/token_info/get/");
    expect(JSON.parse(init.body as string)).toEqual({
      app_id: "app_1",
      access_token: "access_1",
    });
  });

  it("splits the comma-separated scope string", async () => {
    const fetchImpl = vi.fn(async () =>
      infoEnvelope({
        app_id: "app_1",
        creator_id: "biz_123",
        scope: "message.list.read,message.list.send",
      }),
    );

    await expect(
      getTokenInfo({ appId: "app_1", accessToken: "access_1", fetchImpl: fetchImpl as never }),
    ).resolves.toEqual({
      appId: "app_1",
      creatorId: "biz_123",
      scopes: ["message.list.read", "message.list.send"],
    });
  });

  it("surfaces a rejected inspection rather than returning an empty grant", async () => {
    // Without this, an expired token degrades to `scopes: []`, which reads
    // downstream as "the grant is missing every scope" and sends an operator
    // to re-consent when the real fix is a refresh.
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.INVALID_ACCESS_TOKEN));

    await expect(
      getTokenInfo({ appId: "app_1", accessToken: "access_1", fetchImpl: fetchImpl as never }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("refuses a response with no creator_id instead of forging an empty one", async () => {
    // It is documented as usable as `business_id`, so an empty one would
    // travel into every later call as an opaque remote error.
    const fetchImpl = vi.fn(async () => infoEnvelope({ app_id: "app_1", scope: "a" }));

    await expect(
      getTokenInfo({ appId: "app_1", accessToken: "access_1", fetchImpl: fetchImpl as never }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("reports no scopes rather than one empty string", async () => {
    const fetchImpl = vi.fn(async () => infoEnvelope({ app_id: "app_1", creator_id: "biz_123" }));

    await expect(
      getTokenInfo({ appId: "app_1", accessToken: "access_1", fetchImpl: fetchImpl as never }),
    ).resolves.toMatchObject({ scopes: [] });
  });
});

describe("missingMessagingScopes", () => {
  it("distinguishes a complete grant from an incomplete one", () => {
    // Asserting only `[]` for a complete grant would pass against a stub that
    // always returns `[]`, so both directions live in one test.
    const complete = [...TIKTOK_MESSAGING_SCOPES, "user.info.basic"];
    expect(missingMessagingScopes(complete)).toEqual([]);
    expect(missingMessagingScopes(complete.slice(1))).toEqual(["message.list.read"]);
  });

  it("parses a raw scope string rather than substring-matching it", () => {
    // `String.includes` is a substring test, so an array-only signature handed
    // a raw string reports a scope as granted whenever some *other* scope
    // merely contains its name. TikTok's wire field (`scope`) differs from the
    // parsed one (`scopes`) by a single letter, so the wrong shape is easy to
    // pass — and this check exists to fail closed.
    //
    // A superstring is what separates the two implementations: substring
    // matching sees "message.list.read" inside "message.list.readonly" and
    // wrongly reports it granted.
    expect(missingMessagingScopes("message.list.readonly")).toEqual([
      "message.list.read",
      "message.list.send",
      "message.list.manage",
    ]);
    expect(missingMessagingScopes(TIKTOK_MESSAGING_SCOPES.join(","))).toEqual([]);
    expect(missingMessagingScopes("")).toHaveLength(3);
  });

  it("does not substring-match within an array either", () => {
    expect(missingMessagingScopes(["message.list.readonly"])).toHaveLength(3);
  });

  it("names exactly what is missing", () => {
    // A grant can be valid and still lack these; without the check the first
    // symptom is a permission error on a send.
    expect(missingMessagingScopes(["message.list.read"])).toEqual([
      "message.list.send",
      "message.list.manage",
    ]);
  });

  it("treats an empty grant as missing all of them", () => {
    expect(missingMessagingScopes([])).toHaveLength(3);
  });
});

describe("splitScopes", () => {
  it("splits the documented comma-separated form", () => {
    expect(splitScopes("message.list.read,message.list.send")).toEqual([
      "message.list.read",
      "message.list.send",
    ]);
  });

  it("ignores spacing, so a granted scope is never read as missing", () => {
    // TikTok's example has no spaces, but one would otherwise turn a good
    // grant into a false "missing scope" that blocks setup.
    expect(splitScopes("message.list.read, message.list.send")).toEqual([
      "message.list.read",
      "message.list.send",
    ]);
    expect(missingMessagingScopes(splitScopes(TIKTOK_MESSAGING_SCOPES.join(", ")))).toEqual([]);
  });

  it("returns nothing for an absent or empty scope string", () => {
    expect(splitScopes(undefined)).toEqual([]);
    expect(splitScopes("")).toEqual([]);
    expect(splitScopes(",,")).toEqual([]);
  });
});
