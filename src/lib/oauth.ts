import { AuthenticationError, NetworkError } from "@chat-adapter/shared";

import type { TikTokTokenResponse, TikTokTokens } from "../types.js";
import { TIKTOK_CODE, TIKTOK_MESSAGING_SCOPES } from "../types.js";
import {
  fetchEnvelope,
  TIKTOK_API_HOST,
  TIKTOK_DEFAULT_API_VERSION,
  unwrapEnvelope,
} from "./api-client.js";
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
  const now = options.now ?? (() => Date.now());

  const envelope = await fetchEnvelope<TikTokTokenResponse>({
    url,
    method: "POST",
    // The OAuth endpoints take credentials in the body and no auth header.
    // The code field is `auth_code`, not `code` as most providers use.
    body: {
      client_id: options.appId,
      client_secret: options.appSecret,
      grant_type: "authorization_code",
      auth_code: options.authCode,
      redirect_uri: options.redirectUri,
    },
    fetchImpl: options.fetchImpl,
    operation: "the token exchange",
  });

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
    scopes: splitScopes(data.scope),
  };
}

export interface RevokeTokenOptions {
  appId: string;
  appSecret: string;
  /** The access token to invalidate. */
  accessToken: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Revoke an access token, disconnecting the account.
 *
 * Note the parameter naming: this endpoint takes `client_id` and
 * `client_secret`, matching the token endpoints — unlike
 * {@link getTokenInfo}, which names the same application `app_id` and takes no
 * secret at all. TikTok uses three conventions for one value across this API.
 *
 * TikTok documents no distinct outcome for revoking a token that is already
 * revoked or expired, so a caller should treat any success as "the token is
 * not usable now" rather than "it was live until this call".
 */
export async function revokeAccessToken(options: RevokeTokenOptions): Promise<void> {
  const base = (options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "");
  const version = options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;

  const envelope = await fetchEnvelope<Record<string, never>>({
    url: `${base}/open_api/${version}/tt_user/oauth2/revoke/`,
    method: "POST",
    body: {
      client_id: options.appId,
      client_secret: options.appSecret,
      access_token: options.accessToken,
    },
    fetchImpl: options.fetchImpl,
    operation: "the token revocation",
  });

  unwrapEnvelope(envelope);
}

export interface TokenInfoOptions {
  appId: string;
  accessToken: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

/** What TikTok reports about an access token. */
export interface TikTokTokenInfo {
  appId: string;
  /**
   * The account's own identifier, which the messaging endpoints accept as
   * `business_id`.
   */
  creatorId: string;
  /** Granted scopes, split from TikTok's comma-separated `scope` string. */
  scopes: string[];
}

/**
 * Inspect an access token's granted scopes.
 *
 * Useful at setup: the messaging scopes can be absent from an otherwise valid
 * grant, and without this the first failure appears much later as a permission
 * error on a send.
 *
 * Two quirks worth knowing. The application is named `app_id` here, not
 * `client_id` as the token and revoke endpoints call it, and no secret is
 * required — the access token alone identifies the grant. The response carries
 * no expiry, so this cannot answer "how long is this token good for".
 */
export async function getTokenInfo(options: TokenInfoOptions): Promise<TikTokTokenInfo> {
  const base = (options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "");
  const version = options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;

  const data = unwrapEnvelope(
    await fetchEnvelope<{ app_id?: string; creator_id?: string; scope?: string }>({
      url: `${base}/open_api/${version}/tt_user/token_info/get/`,
      method: "POST",
      body: { app_id: options.appId, access_token: options.accessToken },
      fetchImpl: options.fetchImpl,
      operation: "the token inspection",
    }),
  );

  if (!data?.creator_id) {
    // The same policy as `toTokens`: a partial response applied as though it
    // were whole is worse than a failure. This value is documented as usable
    // as `business_id`, so an empty one would travel into every later call and
    // surface as an opaque remote parameter error.
    throw new NetworkError(ADAPTER_NAME, "TikTok returned token info without a creator_id.");
  }

  return {
    appId: data.app_id ?? options.appId,
    creatorId: data.creator_id,
    // Trimmed: TikTok's example has no spaces, but a stray one would make a
    // granted scope read as missing — a false alarm that blocks a good setup.
    scopes: splitScopes(data.scope),
  };
}

/** Split TikTok's comma-separated scope string, ignoring spacing. */
export function splitScopes(scope: string | undefined): string[] {
  if (!scope) {
    return [];
  }
  return scope
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Whether a token carries every scope direct messaging needs.
 *
 * A grant can be valid and still lack these, in which case the first symptom
 * is a permission error on a send rather than anything at connect time.
 */
export function missingMessagingScopes(scopes: string | readonly string[]): string[] {
  // Accepting the raw string is not a convenience: `String.includes` is a
  // substring test, so passing TikTok's comma-separated `scope` to an
  // array-only signature would report nothing missing whatever it contained.
  // A permission precheck that fails open is worse than none, and the wire
  // field (`scope`) differs from the parsed one (`scopes`) by a single letter.
  const granted = typeof scopes === "string" ? splitScopes(scopes) : scopes;
  return TIKTOK_MESSAGING_SCOPES.filter((scope) => !granted.includes(scope));
}
