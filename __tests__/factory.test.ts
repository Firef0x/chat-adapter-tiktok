import { ValidationError } from "@chat-adapter/shared";
import { afterEach, describe, expect, it } from "vitest";

import { TikTokAdapter } from "../src/adapter.js";
import { createTikTokAdapter, tiktok } from "../src/factory.js";

const CREDENTIALS = {
  appId: "app_1",
  appSecret: "secret_1",
  businessId: "biz_123",
  accessToken: "access_1",
  refreshToken: "refresh_1",
};

const ENV_KEYS = [
  "TIKTOK_APP_ID",
  "TIKTOK_APP_SECRET",
  "TIKTOK_BUSINESS_ID",
  "TIKTOK_ACCESS_TOKEN",
  "TIKTOK_REFRESH_TOKEN",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("createTikTokAdapter", () => {
  it("builds an adapter from explicit config", () => {
    expect(createTikTokAdapter(CREDENTIALS)).toBeInstanceOf(TikTokAdapter);
  });

  it("falls back to environment variables", () => {
    process.env.TIKTOK_APP_ID = "app_1";
    process.env.TIKTOK_APP_SECRET = "secret_1";
    process.env.TIKTOK_BUSINESS_ID = "biz_123";
    process.env.TIKTOK_ACCESS_TOKEN = "access_1";
    process.env.TIKTOK_REFRESH_TOKEN = "refresh_1";

    expect(createTikTokAdapter()).toBeInstanceOf(TikTokAdapter);
  });

  it("prefers explicit config over the environment", () => {
    process.env.TIKTOK_BUSINESS_ID = "from_env";
    const adapter = createTikTokAdapter(CREDENTIALS);
    expect(adapter.botUserId).toBe("biz_123");
  });

  it.each(ENV_KEYS)("names the missing credential and its env var (%s)", (envKey) => {
    const key = {
      TIKTOK_APP_ID: "appId",
      TIKTOK_APP_SECRET: "appSecret",
      TIKTOK_BUSINESS_ID: "businessId",
      TIKTOK_ACCESS_TOKEN: "accessToken",
      TIKTOK_REFRESH_TOKEN: "refreshToken",
    }[envKey] as keyof typeof CREDENTIALS;

    const partial = { ...CREDENTIALS };
    delete partial[key];

    // Failing at construction beats an opaque API rejection hours later.
    expect(() => createTikTokAdapter(partial)).toThrow(ValidationError);
    expect(() => createTikTokAdapter(partial)).toThrow(new RegExp(envKey));
  });

  it("exposes a shorthand alias", () => {
    expect(tiktok).toBe(createTikTokAdapter);
  });

  it("defaults the bot display name", () => {
    expect(createTikTokAdapter(CREDENTIALS).userName).toBe("tiktok-bot");
  });
});
