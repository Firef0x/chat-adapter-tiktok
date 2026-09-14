import { beforeEach, describe, expect, it, vi } from "vitest";

import { TikTokAdapter } from "../../src/adapter.js";
import { signWebhookBody } from "../../src/lib/webhook.js";
import { TikTokWebhookRouter } from "../../src/lib/webhook-router.js";
import type { TikTokMessageContent } from "../../src/types.js";

const APP_SECRET = "app_secret_value";
const BIZ_A = "biz_aaa";
const BIZ_B = "biz_bbb";
const CONVERSATION_ID = "conv+abc==";

function okResponse(data: unknown) {
  return {
    json: async () => ({ code: 0, message: "OK", request_id: "req_1", data }),
  } as unknown as Response;
}

function messageContent(overrides: Partial<TikTokMessageContent> = {}): TikTokMessageContent {
  return {
    from: "someuser",
    to: "acmebrand",
    unique_identifier: "user_1",
    from_user: { id: "user_1", role: "personal_account" },
    to_user: { id: BIZ_A, role: "business_account" },
    conversation_id: CONVERSATION_ID,
    message_id: "msg_1",
    timestamp: 1_700_000_000_000,
    type: "text",
    text: { body: "hello" },
    scene_type: 0,
    is_follower: false,
    message_tag: { source: "APP" },
    ...overrides,
  };
}

function adapterFor(businessId: string) {
  const processed: string[] = [];
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const adapter = new TikTokAdapter({
    appId: "app_1",
    appSecret: APP_SECRET,
    businessId,
    accessToken: "access_1",
    refreshToken: "refresh_1",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    fetchImpl: vi.fn(async () => okResponse({})) as never,
  });
  const chat = {
    getLogger: () => logger,
    processMessage: (_a: unknown, threadId: string) => {
      processed.push(threadId);
    },
  };
  return { adapter, processed, chat, logger };
}

function deliveryFor(
  businessId: string,
  options: { secret?: string; seconds?: number; body?: string } = {},
) {
  const body =
    options.body ??
    JSON.stringify({
      client_key: "app_1",
      event: "im_receive_msg",
      create_time: Math.floor(Date.now() / 1000),
      user_openid: businessId,
      content: JSON.stringify(
        messageContent({ to_user: { id: businessId, role: "business_account" } }),
      ),
    });
  const seconds = options.seconds ?? Math.floor(Date.now() / 1000);

  return new Request("https://example.com/webhooks/tiktok", {
    method: "POST",
    headers: {
      "tiktok-signature": signWebhookBody(body, options.secret ?? APP_SECRET, seconds),
      "content-type": "application/json",
      "x-tt-logid": "log_1",
    },
    body,
  });
}

describe("TikTokWebhookRouter", () => {
  let router: TikTokWebhookRouter;
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
    router = new TikTokWebhookRouter({ appSecret: APP_SECRET, logger: logger as never });
  });

  it("delivers to the adapter owning the account, not merely to some adapter", async () => {
    // Two tenants registered: routing must pick B for B's delivery. A test
    // with one registered adapter would pass even if the lookup were ignored.
    const a = adapterFor(BIZ_A);
    const b = adapterFor(BIZ_B);
    await a.adapter.initialize(a.chat as never);
    await b.adapter.initialize(b.chat as never);
    router.register(a.adapter).register(b.adapter);

    const response = await router.handleWebhook(deliveryFor(BIZ_B));

    expect(response.status).toBe(200);
    expect(b.processed).toHaveLength(1);
    expect(a.processed).toHaveLength(0);
  });

  it("routes each tenant's delivery to its own adapter", async () => {
    const a = adapterFor(BIZ_A);
    const b = adapterFor(BIZ_B);
    await a.adapter.initialize(a.chat as never);
    await b.adapter.initialize(b.chat as never);
    router.register(a.adapter).register(b.adapter);

    await router.handleWebhook(deliveryFor(BIZ_A));
    await router.handleWebhook(deliveryFor(BIZ_B));

    expect(a.processed).toHaveLength(1);
    expect(b.processed).toHaveLength(1);
    expect(a.processed[0]).not.toBe(b.processed[0]);
  });

  it("rejects a forged signature before the tenant lookup runs", async () => {
    // Verification must precede routing, and proving that needs a tenant the
    // router can only reach through the resolver. With the adapter registered
    // instead, its own verification returns 401 too — so the assertion would
    // hold even if the router never verified at all.
    //
    // What is actually at stake: an unauthenticated caller must not be able to
    // drive tenant lookups, which are database queries, with an account ID of
    // their choosing.
    const resolve = vi.fn(async () => null);
    const guarded = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      resolve,
      logger: logger as never,
    });

    const response = await guarded.handleWebhook(deliveryFor(BIZ_A, { secret: "wrong" }));

    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not hand a forged delivery to a registered adapter", async () => {
    const a = adapterFor(BIZ_A);
    await a.adapter.initialize(a.chat as never);
    router.register(a.adapter);

    const response = await router.handleWebhook(deliveryFor(BIZ_A, { secret: "wrong" }));

    expect(response.status).toBe(401);
    expect(a.processed).toHaveLength(0);
    // The adapter no longer verifies for itself on this path, so the 401 can
    // only have come from the router.
    expect(a.logger.warn).not.toHaveBeenCalled();
  });

  it("rejects a replayed delivery before the tenant lookup runs", async () => {
    // Routed through the resolver for the same reason as the forged-signature
    // case: with the adapter registered, its own rejection would mask a router
    // that never checked the timestamp.
    const resolve = vi.fn(async () => null);
    const guarded = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      resolve,
      logger: logger as never,
    });

    const response = await guarded.handleWebhook(
      deliveryFor(BIZ_A, { seconds: Math.floor(Date.now() / 1000) - 3600 }),
    );

    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("applies its own signature tolerance", async () => {
    // Nothing exercised this option: it survived only because the default
    // matched. It is now the only tolerance in play, since adapters it
    // dispatches to do not verify again.
    const a = adapterFor(BIZ_A);
    await a.adapter.initialize(a.chat as never);
    const lenient = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      signatureToleranceSeconds: 7200,
      logger: logger as never,
    });
    lenient.register(a.adapter);

    const stale = deliveryFor(BIZ_A, { seconds: Math.floor(Date.now() / 1000) - 3600 });

    expect((await lenient.handleWebhook(stale)).status).toBe(200);
    expect(a.processed).toHaveLength(1);
  });

  it("delivers even when the tenant lookup outlasts the signature window", async () => {
    // The router verifies once. A second check under a later clock would
    // reject a delivery the first accepted, and TikTok retries anything
    // non-2xx forever — so a slow tenant load would loop indefinitely.
    const b = adapterFor(BIZ_B);
    await b.adapter.initialize(b.chat as never);

    const tolerant = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      // Wide enough to accept a signature aged past the adapter's own default.
      signatureToleranceSeconds: 30,
      logger: logger as never,
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return b.adapter;
      },
    });

    // Six seconds old: beyond the 5-second default, so a re-check would fail.
    const aged = deliveryFor(BIZ_B, { seconds: Math.floor(Date.now() / 1000) - 6 });
    const response = await tolerant.handleWebhook(aged);

    expect(response.status).toBe(200);
    expect(b.processed).toHaveLength(1);
  });

  it("passes webhook options through to the adapter", async () => {
    // `options` carries waitUntil; dropping it would silently truncate
    // background work on serverless runtimes.
    const a = adapterFor(BIZ_A);
    const seen: unknown[] = [];
    await a.adapter.initialize({
      getLogger: () => a.logger,
      processMessage: (_ad: unknown, _t: string, _f: unknown, options: unknown) => {
        seen.push(options);
      },
    } as never);
    router.register(a.adapter);

    const waitUntil = vi.fn();
    await router.handleWebhook(deliveryFor(BIZ_A), { waitUntil } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ waitUntil });
  });

  it("refuses an adapter belonging to a different app", async () => {
    // One router serves one app; a mismatch would make every delivery for that
    // adapter unverifiable, and TikTok would retry each one forever.
    const foreign = new TikTokAdapter({
      appId: "app_1",
      appSecret: "a-different-secret",
      businessId: BIZ_B,
      accessToken: "access_1",
      refreshToken: "refresh_1",
      fetchImpl: vi.fn() as never,
    });

    expect(() => router.register(foreign)).toThrow(/different app secret/);
    expect(router.registered).toEqual([]);
  });

  it("refuses an empty app secret", () => {
    // `createHmac` accepts an empty key, so every forged delivery would verify.
    expect(() => new TikTokWebhookRouter({ appSecret: "" })).toThrow(/appSecret is required/);
  });

  it("names the business account when a delivery is discarded", async () => {
    // This path drops the message permanently; without the account, "tenant X
    // went quiet" cannot be diagnosed from the logs.
    await router.handleWebhook(deliveryFor("biz_stranger"));

    expect(logger.warn).toHaveBeenCalledWith(
      "No TikTok adapter is registered for this business account",
      expect.objectContaining({ businessId: "biz_stranger" }),
    );
  });

  it("consults the resolver for an account not held in memory", async () => {
    const b = adapterFor(BIZ_B);
    await b.adapter.initialize(b.chat as never);
    const resolve = vi.fn(async (id: string) => (id === BIZ_B ? b.adapter : null));
    const lazy = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      resolve,
      logger: logger as never,
    });

    const response = await lazy.handleWebhook(deliveryFor(BIZ_B));

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith(BIZ_B);
    expect(b.processed).toHaveLength(1);
  });

  it("prefers a registered adapter over the resolver", async () => {
    const a = adapterFor(BIZ_A);
    await a.adapter.initialize(a.chat as never);
    const resolve = vi.fn();
    const both = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      resolve,
      logger: logger as never,
    });
    both.register(a.adapter);

    await both.handleWebhook(deliveryFor(BIZ_A));

    expect(a.processed).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("answers 200 for an account nobody owns, so TikTok stops retrying", async () => {
    // "Not ours" is permanent; a non-2xx would buy an endless replay.
    const response = await router.handleWebhook(deliveryFor("biz_stranger"));

    expect(response.status).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("answers 503 when the resolver itself fails, so the message is retried", async () => {
    // A database blip is transient — the opposite of "not ours" — and the two
    // must not collapse into the same answer.
    const flaky = new TikTokWebhookRouter({
      appSecret: APP_SECRET,
      resolve: () => {
        throw new Error("database down");
      },
      logger: logger as never,
    });

    const response = await flaky.handleWebhook(deliveryFor(BIZ_A));

    expect(response.status).toBe(503);
    expect(logger.error).toHaveBeenCalled();
  });

  it("answers 200 on an unparseable envelope rather than looping", async () => {
    const response = await router.handleWebhook(deliveryFor(BIZ_A, { body: "{not json" }));

    expect(response.status).toBe(200);
    expect(logger.error).toHaveBeenCalled();
  });

  it("answers 200 when the envelope names no account", async () => {
    const body = JSON.stringify({ client_key: "app_1", event: "im_receive_msg", content: "{}" });
    const response = await router.handleWebhook(deliveryFor(BIZ_A, { body }));

    expect(response.status).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("hands the adapter a body it can still read", async () => {
    // The router consumes the request; a Request body cannot be read twice, so
    // the adapter must receive fresh bytes or it would verify an empty body.
    const a = adapterFor(BIZ_A);
    await a.adapter.initialize(a.chat as never);
    router.register(a.adapter);

    await router.handleWebhook(deliveryFor(BIZ_A));

    expect(a.processed).toHaveLength(1);
    expect(a.logger.warn).not.toHaveBeenCalled();
  });

  it("tracks and releases registrations", () => {
    const a = adapterFor(BIZ_A);
    router.register(a.adapter);

    expect(router.registered).toEqual([BIZ_A]);
    expect(router.unregister(BIZ_A)).toBe(true);
    expect(router.unregister(BIZ_A)).toBe(false);
    expect(router.registered).toEqual([]);
  });
});
