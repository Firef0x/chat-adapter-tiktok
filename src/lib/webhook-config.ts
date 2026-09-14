import type { TikTokWebhookConfig, TikTokWebhookEventType } from "../types.js";
import {
  fetchEnvelope,
  TIKTOK_API_HOST,
  TIKTOK_DEFAULT_API_VERSION,
  unwrapEnvelope,
} from "./api-client.js";

/**
 * Shared by every call here.
 *
 * These endpoints are **app-level**: they authenticate with the app's own ID
 * and secret as ordinary parameters rather than an `Access-Token` header, and
 * a configuration applies to every business that has authorized the app. There
 * is no per-account registration to repeat.
 */
export interface WebhookConfigOptions {
  appId: string;
  appSecret: string;
  /** Defaults to `"DIRECT_MESSAGE"`, the only documented value. */
  eventType?: TikTokWebhookEventType;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

interface WebhookConfigData {
  app_id?: string;
  event_type?: TikTokWebhookEventType;
  callback_url?: string;
}

function endpoint(options: WebhookConfigOptions, action: string): string {
  const base = (options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "");
  const version = options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;
  return `${base}/open_api/${version}/business/webhook/${action}/`;
}

/**
 * Read the app's current webhook configuration.
 *
 * @returns the configuration, or `null` when none exists. TikTok signals
 * "not configured" by omitting `callback_url` from an otherwise successful
 * response rather than by returning an error, so the absence is translated
 * into `null` instead of a half-populated object.
 */
export async function getWebhookConfig(
  options: WebhookConfigOptions,
): Promise<TikTokWebhookConfig | null> {
  const eventType = options.eventType ?? "DIRECT_MESSAGE";
  const url = new URL(endpoint(options, "list"));
  url.searchParams.set("app_id", options.appId);
  url.searchParams.set("secret", options.appSecret);
  url.searchParams.set("event_type", eventType);

  const data = unwrapEnvelope(
    await fetchEnvelope<WebhookConfigData>({
      url: url.toString(),
      method: "GET",
      fetchImpl: options.fetchImpl,
      operation: "the webhook configuration read",
    }),
  );

  if (!data?.callback_url) {
    return null;
  }

  return {
    appId: data.app_id ?? options.appId,
    eventType: data.event_type ?? eventType,
    callbackUrl: data.callback_url,
  };
}

/**
 * Create or replace the app's webhook configuration.
 *
 * One call configures one event type, and `DIRECT_MESSAGE` is the only value
 * TikTok documents — so this replaces rather than appends.
 */
export async function setWebhookConfig(
  options: WebhookConfigOptions & { callbackUrl: string },
): Promise<TikTokWebhookConfig> {
  const eventType = options.eventType ?? "DIRECT_MESSAGE";

  const data = unwrapEnvelope(
    await fetchEnvelope<WebhookConfigData>({
      url: endpoint(options, "update"),
      method: "POST",
      body: {
        app_id: options.appId,
        secret: options.appSecret,
        event_type: eventType,
        callback_url: options.callbackUrl,
      },
      fetchImpl: options.fetchImpl,
      operation: "the webhook configuration write",
    }),
  );

  return {
    appId: data?.app_id ?? options.appId,
    eventType: data?.event_type ?? eventType,
    callbackUrl: data?.callback_url ?? options.callbackUrl,
  };
}

/**
 * Remove the app's webhook configuration for one event type.
 *
 * The configuration is identified by the app and event type together; there is
 * no separate webhook ID to pass.
 */
export async function deleteWebhookConfig(options: WebhookConfigOptions): Promise<void> {
  unwrapEnvelope(
    await fetchEnvelope<WebhookConfigData>({
      url: endpoint(options, "delete"),
      method: "POST",
      body: {
        app_id: options.appId,
        secret: options.appSecret,
        event_type: options.eventType ?? "DIRECT_MESSAGE",
      },
      fetchImpl: options.fetchImpl,
      operation: "the webhook configuration delete",
    }),
  );
}
