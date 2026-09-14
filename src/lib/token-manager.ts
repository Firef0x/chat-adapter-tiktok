import { AuthenticationError, NetworkError } from "@chat-adapter/shared";
import type { Logger } from "chat";
import { ConsoleLogger } from "chat";

import type { TikTokApiEnvelope, TikTokTokenResponse, TikTokTokens } from "../types.js";
import { TIKTOK_CODE } from "../types.js";
import {
  type AccessTokenProvider,
  mapTikTokError,
  TIKTOK_API_HOST,
  TIKTOK_DEFAULT_API_VERSION,
} from "./api-client.js";
import { ADAPTER_NAME } from "./thread-id.js";

/**
 * How long before expiry a token is considered stale.
 *
 * This shifts each refresh slightly earlier rather than adding any, and avoids
 * racing the expiry on a request that would otherwise fail in flight.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface TokenManagerOptions {
  appId: string;
  appSecret: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  businessId: string;
  onTokenRefresh?: (tokens: TikTokTokens) => void | Promise<void>;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests. */
  now?: () => number;
  /**
   * Resolved on each use rather than captured.
   *
   * The adapter swaps its logger for the host's during `initialize()`. A
   * reference captured at construction would keep pointing at the bootstrap
   * `ConsoleLogger`, sending the most consequential message this class can
   * emit — a failure to persist rotated credentials — to stdout instead of
   * the host's log pipeline, where nobody's alerts would ever match it.
   */
  logger?: Logger | (() => Logger);
}

/**
 * Owns the access-token lifecycle for one connected business account.
 *
 * TikTok access tokens live 24 hours and refresh tokens a year, and the
 * refresh token **rotates on every use** — so this class is also responsible
 * for handing the rotated credentials back to the host.
 */
export class TikTokTokenManager implements AccessTokenProvider {
  private accessToken: string;
  private refreshToken: string;
  private accessTokenExpiresAt: number;
  private refreshTokenExpiresAt: number;
  private scopes: string[] = [];

  /** Shared by every caller that arrives while a refresh is in flight. */
  private inflight: Promise<string> | null = null;

  private readonly options: TokenManagerOptions;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TokenManagerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;

    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    // An unknown expiry is treated as already expired: one refresh up front
    // beats discovering the expiry through a failed API call.
    this.accessTokenExpiresAt = options.accessTokenExpiresAt ?? 0;
    this.refreshTokenExpiresAt =
      options.refreshTokenExpiresAt ?? Number.POSITIVE_INFINITY;
  }

  /** Current credentials, for a host that wants to persist them. */
  getTokens(): TikTokTokens {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      accessTokenExpiresAt: this.accessTokenExpiresAt,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt,
      businessId: this.options.businessId,
      // Copied: handing out the live array lets a caller mutate internal state.
      scopes: [...this.scopes],
    };
  }

  /** The current logger, falling back to console so this can never be silent. */
  private get logger(): Logger {
    const configured = this.options.logger;
    if (typeof configured === "function") {
      return configured();
    }
    return configured ?? new ConsoleLogger();
  }

  /** Return a usable access token, refreshing first if it is near expiry. */
  async getAccessToken(): Promise<string> {
    if (this.now() < this.accessTokenExpiresAt - REFRESH_SKEW_MS) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  /**
   * Refresh unconditionally.
   *
   * Concurrent callers share a single in-flight request: without this, a burst
   * of requests arriving at expiry would each rotate the refresh token, and
   * every rotation but the last would be invalidated mid-flight.
   */
  refreshAccessToken(): Promise<string> {
    this.inflight ??= this.performRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async performRefresh(): Promise<string> {
    if (this.now() >= this.refreshTokenExpiresAt) {
      throw new AuthenticationError(
        ADAPTER_NAME,
        "TikTok refresh token has expired. The connection must be re-authorized.",
      );
    }

    const url = `${(this.options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "")}/open_api/${
      this.options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION
    }/tt_user/oauth2/refresh_token/`;

    // The OAuth endpoints authenticate with credentials in the body and must
    // not carry an Access-Token header.
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.options.appId,
          client_secret: this.options.appSecret,
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
        }),
      });
    } catch (error) {
      // A transport failure must stay retryable. Letting the raw error escape
      // would bypass the caller's retry classification entirely.
      throw new NetworkError(
        ADAPTER_NAME,
        "Token refresh request failed",
        error instanceof Error ? error : undefined,
      );
    }

    let envelope: TikTokApiEnvelope<TikTokTokenResponse>;
    try {
      envelope = (await response.json()) as TikTokApiEnvelope<TikTokTokenResponse>;
    } catch (error) {
      // Typically a CDN or gateway error page. Reporting it as a parse error
      // would read as a bug in this library rather than a transient fault.
      throw new NetworkError(
        ADAPTER_NAME,
        `Non-JSON response from the token endpoint (HTTP ${response.status})`,
        error instanceof Error ? error : undefined,
      );
    }

    // A non-numeric code means the body never came from the API layer, so it
    // says nothing about the grant. Demanding re-authorization here would send
    // an operator through a manual OAuth flow over a five-minute outage.
    if (typeof envelope?.code !== "number") {
      throw new NetworkError(
        ADAPTER_NAME,
        `Unrecognized token-endpoint response (HTTP ${response.status})`,
      );
    }

    if (envelope.code !== TIKTOK_CODE.OK) {
      throw this.refreshFailure(envelope);
    }

    this.applyTokenResponse(envelope.data);
    await this.notifyHost();
    return this.accessToken;
  }

  /**
   * Decide whether a failed refresh is transient or terminal.
   *
   * Throttling and server errors are worth retrying with the same refresh
   * token. Anything else means the token will not work again, and an operator
   * has to re-authorize.
   */
  private refreshFailure(envelope: TikTokApiEnvelope<unknown>): Error {
    if (
      envelope.code === TIKTOK_CODE.RATE_LIMITED ||
      envelope.code === TIKTOK_CODE.SYSTEM_ERROR
    ) {
      return mapTikTokError(envelope.code, envelope.message, envelope.request_id);
    }

    return new AuthenticationError(
      ADAPTER_NAME,
      `TikTok refused to refresh the access token (code ${envelope.code}: ${envelope.message}). The connection must be re-authorized.`,
    );
  }

  /**
   * Adopt a refreshed grant, but only if it is complete.
   *
   * A partial payload applied blindly is worse than a failed refresh: a
   * missing `expires_in` yields `NaN`, which makes the freshness check at
   * every call false and turns normal traffic into a refresh-per-request
   * storm — and since each refresh rotates the token, the host would be
   * handed, and would persist, an `undefined` refresh token over its good one.
   */
  private applyTokenResponse(data: TikTokTokenResponse): void {
    const missing: string[] = [];
    if (!data?.access_token) {
      missing.push("access_token");
    }
    if (!data?.refresh_token) {
      missing.push("refresh_token");
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
        `TikTok returned an incomplete token response (missing or invalid: ${missing.join(", ")}). The existing credentials were kept.`,
      );
    }

    const now = this.now();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.accessTokenExpiresAt = now + data.expires_in * 1000;
    this.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000;
    this.scopes = data.scope ? data.scope.split(",") : [];
  }

  private async notifyHost(): Promise<void> {
    if (!this.options.onTokenRefresh) {
      return;
    }

    try {
      await this.options.onTokenRefresh(this.getTokens());
    } catch (error) {
      // The rotation already happened at TikTok, so failing the caller here
      // would not undo it — and the new token works in memory, so the process
      // can keep serving. Log loudly: until persistence succeeds, a restart
      // loses the connection permanently.
      this.logger.error(
        "Failed to persist refreshed TikTok tokens. The connection will break on restart unless they are saved.",
        { error },
      );
    }
  }
}
