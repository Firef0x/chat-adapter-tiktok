import { AdapterRateLimitError, AuthenticationError, NetworkError } from "@chat-adapter/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { REFRESH_SKEW_MS, TikTokTokenManager } from "../../src/lib/token-manager.js";
import type { TikTokTokens } from "../../src/types.js";
import { TIKTOK_CODE } from "../../src/types.js";

const HOUR = 60 * 60 * 1000;

function tokenEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    json: async () => ({
      code: 0,
      message: "OK",
      request_id: "req_1",
      data: {
        access_token: "access_new",
        token_type: "Bearer",
        scope: "message.list.read,message.list.send",
        expires_in: 86_400,
        refresh_token: "refresh_new",
        refresh_token_expires_in: 31_536_000,
        open_id: "biz_123",
        ...overrides,
      },
    }),
  } as unknown as Response;
}

function errorEnvelope(code: number, message = "nope") {
  return {
    json: async () => ({ code, message, request_id: "req_1", data: {} }),
  } as unknown as Response;
}

describe("TikTokTokenManager", () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000_000_000;
  });

  function build(options: Partial<ConstructorParameters<typeof TikTokTokenManager>[0]> = {}) {
    const fetchImpl = vi.fn(async () => tokenEnvelope());
    const manager = new TikTokTokenManager({
      appId: "app_1",
      appSecret: "secret_1",
      businessId: "biz_123",
      accessToken: "access_old",
      refreshToken: "refresh_old",
      accessTokenExpiresAt: now + 24 * HOUR,
      now: clock,
      fetchImpl: fetchImpl as never,
      ...options,
    });
    return { manager, fetchImpl };
  }

  it("reuses a token that is comfortably valid", async () => {
    const { manager, fetchImpl } = build();
    await expect(manager.getAccessToken()).resolves.toBe("access_old");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes before expiry rather than at it", async () => {
    // Inside the skew window the old token would still work, but a request
    // started now could easily land after it stops working.
    const { manager, fetchImpl } = build({
      accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1000,
    });
    await expect(manager.getAccessToken()).resolves.toBe("access_new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats an unknown expiry as expired", async () => {
    const { manager, fetchImpl } = build({ accessTokenExpiresAt: undefined });
    await expect(manager.getAccessToken()).resolves.toBe("access_new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts credentials in the body with no Access-Token header", async () => {
    const { manager, fetchImpl } = build({ accessTokenExpiresAt: 0 });
    await manager.getAccessToken();

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/open_api/v1.3/tt_user/oauth2/refresh_token/");
    expect((init.headers as Record<string, string>)["Access-Token"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "app_1",
      client_secret: "secret_1",
      grant_type: "refresh_token",
      refresh_token: "refresh_old",
    });
  });

  it("collapses concurrent refreshes into a single request", async () => {
    // Each rotation invalidates the previous refresh token, so a burst that
    // refreshed independently would invalidate its own credentials.
    const { manager, fetchImpl } = build({ accessTokenExpiresAt: 0 });

    const results = await Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);

    expect(results).toEqual(["access_new", "access_new", "access_new"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows a later refresh after an in-flight one settles", async () => {
    const { manager, fetchImpl } = build({ accessTokenExpiresAt: 0 });
    await manager.refreshAccessToken();
    await manager.refreshAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stores the rotated refresh token for the next refresh", async () => {
    const { manager, fetchImpl } = build({ accessTokenExpiresAt: 0 });
    await manager.refreshAccessToken();
    await manager.refreshAccessToken();

    const second = JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(second.refresh_token).toBe("refresh_new");
  });

  it("hands rotated credentials to the host", async () => {
    const saved: TikTokTokens[] = [];
    const { manager } = build({
      accessTokenExpiresAt: 0,
      onTokenRefresh: (tokens) => {
        saved.push(tokens);
      },
    });

    await manager.getAccessToken();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      accessToken: "access_new",
      refreshToken: "refresh_new",
      businessId: "biz_123",
      scopes: ["message.list.read", "message.list.send"],
    });
    expect(saved[0]?.accessTokenExpiresAt).toBe(now + 86_400 * 1000);
  });

  it("keeps serving when the host fails to persist, but logs it", async () => {
    // The rotation already happened at TikTok; failing the caller cannot undo
    // it, and the in-memory token still works.
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const { manager } = build({
      accessTokenExpiresAt: 0,
      onTokenRefresh: async () => {
        throw new Error("database down");
      },
      logger: logger as never,
    });

    await expect(manager.getAccessToken()).resolves.toBe("access_new");
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("fails fast when the refresh token has already expired", async () => {
    const { manager, fetchImpl } = build({
      accessTokenExpiresAt: 0,
      refreshTokenExpiresAt: now - 1,
    });

    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a rejected refresh as needing re-authorization", async () => {
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.INVALID_ACCESS_TOKEN));
    const { manager } = build({ accessTokenExpiresAt: 0, fetchImpl: fetchImpl as never });

    await expect(manager.getAccessToken()).rejects.toThrow(/re-authorized/);
  });

  it("keeps a throttled refresh retryable instead of demanding re-auth", async () => {
    // 40100 means "try again shortly", not "your grant is gone".
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.RATE_LIMITED));
    const { manager } = build({ accessTokenExpiresAt: 0, fetchImpl: fetchImpl as never });

    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(AdapterRateLimitError);
  });

  it("keeps a server error retryable rather than demanding re-authorization", async () => {
    // Asserting only that it throws would still pass if 51065 were
    // misclassified as terminal, sending an operator through a manual OAuth
    // flow over a transient TikTok outage.
    const fetchImpl = vi.fn(async () => errorEnvelope(TIKTOK_CODE.SYSTEM_ERROR));
    const { manager } = build({ accessTokenExpiresAt: 0, fetchImpl: fetchImpl as never });

    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
    await expect(manager.getAccessToken()).rejects.not.toBeInstanceOf(AuthenticationError);
  });

  it("keeps existing credentials when the refresh response is incomplete", async () => {
    // Applying a partial payload yields NaN expiry (refresh on every call) and
    // an undefined refresh token that the host would persist over its good one.
    const saved: TikTokTokens[] = [];
    const fetchImpl = vi.fn(async () => tokenEnvelope({ expires_in: undefined }));
    const { manager } = build({
      accessTokenExpiresAt: 0,
      fetchImpl: fetchImpl as never,
      onTokenRefresh: (tokens) => {
        saved.push(tokens);
      },
    });

    await expect(manager.getAccessToken()).rejects.toThrow(/incomplete token response/);
    expect(saved).toHaveLength(0);
    expect(manager.getTokens().refreshToken).toBe("refresh_old");
  });

  it("wraps a non-JSON token response as a network fault", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    }));
    const { manager } = build({ accessTokenExpiresAt: 0, fetchImpl: fetchImpl as never });

    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
  });

  it("does not hand out its internal scopes array", async () => {
    const { manager } = build({ accessTokenExpiresAt: 0 });
    await manager.getAccessToken();

    manager.getTokens().scopes.push("injected");
    expect(manager.getTokens().scopes).not.toContain("injected");
  });

  it("recovers on a later attempt after a transient failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorEnvelope(TIKTOK_CODE.SYSTEM_ERROR))
      .mockResolvedValueOnce(tokenEnvelope());
    const { manager } = build({ accessTokenExpiresAt: 0, fetchImpl: fetchImpl as never });

    await expect(manager.getAccessToken()).rejects.toThrow();
    await expect(manager.getAccessToken()).resolves.toBe("access_new");
  });
});
