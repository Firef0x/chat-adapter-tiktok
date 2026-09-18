import { NetworkError, PermissionError } from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import {
  deleteWebhookConfig,
  getWebhookConfig,
  setWebhookConfig,
} from "../../src/lib/webhook-config.js";
import { TIKTOK_CODE } from "../../src/types.js";

const CREDS = { appId: "app_1", appSecret: "secret_1" };

function envelope(data: unknown, code = 0) {
  return {
    status: 200,
    json: async () => ({ code, message: code === 0 ? "OK" : "nope", request_id: "req_1", data }),
  } as unknown as Response;
}

describe("getWebhookConfig", () => {
  it("sends credentials as query parameters, with no Access-Token header", async () => {
    // These are app-level endpoints: they authenticate with app_id + secret
    // rather than a user's access token.
    const fetchImpl = vi.fn(async () =>
      envelope({
        app_id: "app_1",
        event_type: "DIRECT_MESSAGE",
        callback_url: "https://example.com/hook",
      }),
    );

    await getWebhookConfig({ ...CREDS, fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toContain("/open_api/v1.3/business/webhook/list/");
    expect(url).toContain("app_id=app_1");
    expect(url).toContain("secret=secret_1");
    expect(url).toContain("event_type=DIRECT_MESSAGE");
    expect((init?.headers as Record<string, string> | undefined)?.["Access-Token"]).toBeUndefined();
  });

  it("returns the configuration when one exists", async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({
        app_id: "app_1",
        event_type: "DIRECT_MESSAGE",
        callback_url: "https://example.com/hook",
      }),
    );

    await expect(getWebhookConfig({ ...CREDS, fetchImpl: fetchImpl as never })).resolves.toEqual({
      appId: "app_1",
      eventType: "DIRECT_MESSAGE",
      callbackUrl: "https://example.com/hook",
    });
  });

  it("returns null when none is configured", async () => {
    // TikTok signals "not configured" by omitting callback_url from an
    // otherwise successful response, not by returning an error.
    const fetchImpl = vi.fn(async () =>
      envelope({ app_id: "app_1", event_type: "DIRECT_MESSAGE" }),
    );

    await expect(getWebhookConfig({ ...CREDS, fetchImpl: fetchImpl as never })).resolves.toBeNull();
  });

  it("maps a non-zero code on an HTTP 200 to a typed error", async () => {
    const fetchImpl = vi.fn(async () => envelope({}, TIKTOK_CODE.NO_PERMISSION));

    await expect(
      getWebhookConfig({ ...CREDS, fetchImpl: fetchImpl as never }),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("setWebhookConfig", () => {
  it("posts the documented body shape", async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({
        app_id: "app_1",
        event_type: "DIRECT_MESSAGE",
        callback_url: "https://example.com/hook",
      }),
    );

    const config = await setWebhookConfig({
      ...CREDS,
      callbackUrl: "https://example.com/hook",
      fetchImpl: fetchImpl as never,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/business/webhook/update/");
    expect(JSON.parse(init.body as string)).toEqual({
      app_id: "app_1",
      secret: "secret_1",
      // A single string, not a list — TikTok documents one event type per call.
      event_type: "DIRECT_MESSAGE",
      callback_url: "https://example.com/hook",
    });
    expect(config.callbackUrl).toBe("https://example.com/hook");
  });

  it("falls back to the requested values when the response omits them", async () => {
    const fetchImpl = vi.fn(async () => envelope({}));

    await expect(
      setWebhookConfig({
        ...CREDS,
        callbackUrl: "https://example.com/hook",
        fetchImpl: fetchImpl as never,
      }),
    ).resolves.toEqual({
      appId: "app_1",
      eventType: "DIRECT_MESSAGE",
      callbackUrl: "https://example.com/hook",
    });
  });

  it("wraps a non-JSON response rather than crashing", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    }));

    await expect(
      setWebhookConfig({
        ...CREDS,
        callbackUrl: "https://example.com/hook",
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("deleteWebhookConfig", () => {
  it("identifies the configuration by app and event type, with no webhook id", async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({ app_id: "app_1", event_type: "DIRECT_MESSAGE" }),
    );

    await deleteWebhookConfig({ ...CREDS, fetchImpl: fetchImpl as never });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/business/webhook/delete/");
    expect(JSON.parse(init.body as string)).toEqual({
      app_id: "app_1",
      secret: "secret_1",
      event_type: "DIRECT_MESSAGE",
    });
  });

  it("surfaces a rejected delete instead of resolving quietly", async () => {
    const fetchImpl = vi.fn(async () => envelope({}, TIKTOK_CODE.NOT_FOUND));

    await expect(
      deleteWebhookConfig({ ...CREDS, fetchImpl: fetchImpl as never }),
    ).rejects.toThrow();
  });
});

describe("webhook config — credential guards found in the pre-release review", () => {
  it.each([
    ["appId", { appId: "", appSecret: "secret_1" }],
    ["appSecret", { appId: "app_1", appSecret: "" }],
  ])("refuses a %s that is missing before sending anything", async (_label, creds) => {
    // `JSON.stringify` drops an undefined value entirely, so an unset
    // environment variable produces a request with no credential at all and
    // an opaque remote error that names nothing.
    const fetchImpl = vi.fn();

    await expect(getWebhookConfig({ ...creds, fetchImpl: fetchImpl as never })).rejects.toThrow(
      /is required/,
    );
    await expect(
      setWebhookConfig({ ...creds, callbackUrl: "https://x/cb", fetchImpl: fetchImpl as never }),
    ).rejects.toThrow(/is required/);
    await expect(deleteWebhookConfig({ ...creds, fetchImpl: fetchImpl as never })).rejects.toThrow(
      /is required/,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the event type it was given when TikTok omits one", async () => {
    // A caller reading `undefined` back would store it as the configuration.
    const config = await setWebhookConfig({
      ...CREDS,
      callbackUrl: "https://x/cb",
      fetchImpl: vi.fn(async () => envelope({ app_id: "app_1" })) as never,
    });

    expect(config.eventType).toBe("DIRECT_MESSAGE");
    expect(config.callbackUrl).toBe("https://x/cb");
  });
});
