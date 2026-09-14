import { AuthenticationError, NetworkError } from "@chat-adapter/shared";

import type { TikTokApiEnvelope, TikTokTokenResponse, TikTokTokens } from "../types.js";
import { TIKTOK_CODE, TIKTOK_MESSAGING_SCOPES } from "../types.js";
import { TIKTOK_API_HOST, TIKTOK_DEFAULT_API_VERSION } from "./api-client.js";
import { ADAPTER_NAME } from "./thread-id.js";

/** Where a user is sent to approve the connection. */
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize";

export interface AuthorizeUrlOptions {
  appId: string;
  /** Must match the redirect URL registered for the app. */
  redirectUri: string;
  /** Opaque value echoed back on the redirect. Use it to defeat CSRF. */
  state: string;
  /** Defaults to the three messaging scopes. */
  scopes?: readonly string[];
  /** Force the consent screen for an already-authorized user. */
  forceConsent?: boolean;
}

/**
 * Build the URL that starts the OAuth flow.
 *
 * Note the app is named `client_key` here but `client_id` on the token
 * endpoints — TikTok is inconsistent between the two legs, and using the wrong
 * one fails with an unhelpful error.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_key", options.appId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", (options.scopes ?? TIKTOK_MESSAGING_SCOPES).join(","));
  url.searchParams.set("state", options.state);

  if (options.forceConsent) {
    url.searchParams.set("disable_auto_auth", "1");
  }

  return url.toString();
}

export interface ExchangeCodeOptions {
  appId: string;
  appSecret: string;
  /**
   * The `code` query parameter from the redirect.
   *
   * Valid for ten minutes and single-use, so exchange it immediately rather
   * than queueing the work.
   */
  authCode: string;
  /** Must match the `redirect_uri` used to build the authorize URL. */
  redirectUri: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Exchange an authorization code for tokens.
 *
 * The result is shaped for {@link TikTokAdapterConfig}: spread it alongside
 * `appId` and `appSecret` to construct an adapter. `businessId` comes from the
 * response's `open_id`, which is the same value under a different name.
 */
export async function exchangeAuthCode(options: ExchangeCodeOptions): Promise<TikTokTokens> {
  const base = (options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "");
  const version = options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;
  const url = `${base}/open_api/${version}/tt_user/oauth2/token/`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The OAuth endpoints take credentials in the body and no auth header.
      // The code field is `auth_code`, not `code` as most providers use.
      body: JSON.stringify({
        client_id: options.appId,
        client_secret: options.appSecret,
        grant_type: "authorization_code",
        auth_code: options.authCode,
        redirect_uri: options.redirectUri,
      }),
    });
  } catch (error) {
    throw new NetworkError(
      ADAPTER_NAME,
      "Token exchange request failed",
      error instanceof Error ? error : undefined,
    );
  }

  let envelope: TikTokApiEnvelope<TikTokTokenResponse>;
  try {
    envelope = (await response.json()) as TikTokApiEnvelope<TikTokTokenResponse>;
  } catch (error) {
    throw new NetworkError(
      ADAPTER_NAME,
      `Non-JSON response from the token endpoint (HTTP ${response.status})`,
      error instanceof Error ? error : undefined,
    );
  }

  // A non-numeric code means the body never reached the API layer, so it says
  // nothing about whether the grant itself was valid.
  if (typeof envelope?.code !== "number") {
    throw new NetworkError(
      ADAPTER_NAME,
      `Unrecognized token-endpoint response (HTTP ${response.status})`,
    );
  }

  if (envelope.code !== TIKTOK_CODE.OK) {
    // Throttling is worth another attempt; anything else means this code will
    // not work again — it is single-use and short-lived.
    if (envelope.code === TIKTOK_CODE.RATE_LIMITED) {
      throw new NetworkError(
        ADAPTER_NAME,
        `TikTok throttled the token exchange (${envelope.message}).`,
      );
    }
    throw new AuthenticationError(
      ADAPTER_NAME,
      `TikTok rejected the authorization code (code ${envelope.code}: ${envelope.message}). Authorization codes expire after ten minutes and can only be used once.`,
    );
  }

  return toTokens(envelope.data, now());
}

/**
 * Convert a token response into the adapter's credential shape.
 *
 * Applying a partial payload is worse than failing: a missing `expires_in`
 * becomes `NaN`, which makes the freshness check false on every call and turns
 * normal traffic into a refresh-per-request storm — and since each refresh
 * rotates the token, the host would persist an `undefined` over its good one.
 *
 * `knownBusinessId` covers the refresh leg. The response is documented to
 * carry `open_id` there too, but the account is already known at that point,
 * so an omission should not fail a refresh that is otherwise fine.
 */
export function toTokens(
  data: TikTokTokenResponse,
  now: number,
  knownBusinessId?: string,
): TikTokTokens {
  const businessId = data?.open_id || knownBusinessId;
  const missing: string[] = [];
  if (!data?.access_token) {
    missing.push("access_token");
  }
  if (!data?.refresh_token) {
    missing.push("refresh_token");
  }
  if (!businessId) {
    missing.push("open_id");
  }
  if (!Number.isFinite(data?.expires_in)) {
    missing.push("expires_in");
  }
  if (!Number.isFinite(data?.refresh_token_expires_in)) {
    missing.push("refresh_token_expires_in");
  }

  if (missing.length > 0) {
    throw new NetworkError(
      ADAPTER_NAME,
      `TikTok returned an incomplete token response (missing or invalid: ${missing.join(", ")}).`,
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: now + data.expires_in * 1000,
    refreshTokenExpiresAt: now + data.refresh_token_expires_in * 1000,
    businessId: businessId as string,
    scopes: data.scope ? data.scope.split(",") : [],
  };
}
