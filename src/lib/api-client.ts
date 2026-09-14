import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";

import type { TikTokApiEnvelope } from "../types.js";
import { TIKTOK_CODE } from "../types.js";
import { ADAPTER_NAME } from "./thread-id.js";

export const TIKTOK_API_HOST = "https://business-api.tiktok.com";
export const TIKTOK_DEFAULT_API_VERSION = "v1.3";

/**
 * Supplies access tokens to the client.
 *
 * Kept as an interface so the client never owns the token lifecycle: it asks
 * for a token, and on rejection asks for a fresh one exactly once.
 */
export interface AccessTokenProvider {
  /** Return a usable access token, refreshing first if it has expired. */
  getAccessToken(): Promise<string>;
  /**
   * Force a refresh after TikTok rejected the current token, and return the
   * replacement.
   */
  refreshAccessToken(): Promise<string>;
}

export interface TikTokApiClientOptions {
  tokens: AccessTokenProvider;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

export interface TikTokRequest {
  method: "GET" | "POST";
  /** Path below the version segment, e.g. `"business/message/send/"`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * Translate a TikTok envelope code into the adapter error taxonomy.
 *
 * Retryability is the distinction that matters to callers:
 * `AdapterRateLimitError` and `NetworkError` are worth retrying, and
 * everything else is not.
 */
export function mapTikTokError(
  code: number,
  message: string,
  requestId?: string,
): Error {
  const detail = requestId ? `${message} (request_id: ${requestId})` : message;

  switch (code) {
    case TIKTOK_CODE.RATE_LIMITED:
      return new AdapterRateLimitError(ADAPTER_NAME);
    case TIKTOK_CODE.SYSTEM_ERROR:
      return new NetworkError(ADAPTER_NAME, detail);
    case TIKTOK_CODE.INVALID_ACCESS_TOKEN:
      return new AuthenticationError(ADAPTER_NAME, detail);
    case TIKTOK_CODE.NO_PERMISSION:
      return new PermissionError(ADAPTER_NAME, detail);
    case TIKTOK_CODE.NOT_FOUND:
      return new ResourceNotFoundError(ADAPTER_NAME, detail);
    // 40064 is the blanket direct-message-rules code. It is the likeliest
    // carrier of a 48-hour-window or message-cap violation, but TikTok
    // documents no dedicated code for those, so the message is passed through
    // verbatim rather than reinterpreted.
    case TIKTOK_CODE.MESSAGE_BLOCKED:
    case TIKTOK_CODE.INVALID_PARAM:
    case TIKTOK_CODE.UNSUPPORTED_FILE_TYPE:
      return new ValidationError(ADAPTER_NAME, detail);
    default:
      // Deliberately retryable. An unknown code is most often a transient
      // fault or one TikTok added after this release; a spurious retry costs
      // one request, while a spurious permanent failure discards a message
      // that would have succeeded.
      return new NetworkError(
        ADAPTER_NAME,
        `Unrecognized TikTok error ${code}: ${detail}`,
      );
  }
}

/**
 * Thin HTTP client for the Business Messaging API.
 *
 * It exists to centralize three things that are easy to get wrong: the custom
 * `Access-Token` header, the fact that failures arrive as HTTP 200 with a
 * non-zero envelope code, and the single retry after a token rejection.
 */
export class TikTokApiClient {
  private readonly tokens: AccessTokenProvider;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TikTokApiClientOptions) {
    this.tokens = options.tokens;
    this.baseUrl = (options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Build a full URL.
   *
   * Callers must include the trailing slash in `path`; TikTok 404s without it.
   */
  buildUrl(path: string, query?: TikTokRequest["query"]): string {
    const normalized = path.replace(/^\/+/, "");
    const url = new URL(
      `${this.baseUrl}/open_api/${this.apiVersion}/${normalized}`,
    );

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        // URLSearchParams percent-encodes `+`, which conversation IDs contain
        // and which TikTok rejects when passed through literally.
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  async request<TData>(req: TikTokRequest): Promise<TData> {
    const token = await this.tokens.getAccessToken();

    const first = await this.send<TData>(req, token);
    if (first.code !== TIKTOK_CODE.INVALID_ACCESS_TOKEN) {
      return this.unwrap(first);
    }

    // The token was rejected despite looking unexpired — it may have been
    // revoked, or the clock may be off. Refresh once and try again; a second
    // rejection is a real authentication failure.
    const refreshed = await this.tokens.refreshAccessToken();
    return this.unwrap(await this.send<TData>(req, refreshed));
  }

  private async send<TData>(
    req: TikTokRequest,
    accessToken: string,
  ): Promise<TikTokApiEnvelope<TData>> {
    const url = this.buildUrl(req.path, req.query);
    const headers: Record<string, string> = { "Access-Token": accessToken };
    if (req.method === "POST") {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      });
    } catch (error) {
      throw new NetworkError(
        ADAPTER_NAME,
        `Request to ${req.path} failed`,
        error instanceof Error ? error : undefined,
      );
    }

    let envelope: TikTokApiEnvelope<TData>;
    try {
      envelope = (await response.json()) as TikTokApiEnvelope<TData>;
    } catch (error) {
      // A body that is not JSON means the request never reached the API layer
      // — a gateway or proxy answered instead. The cause is kept: knowing
      // whether it was a WAF block or an error page is what identifies the
      // intermediary responsible.
      throw new NetworkError(
        ADAPTER_NAME,
        `Non-JSON response from ${req.path} (HTTP ${response.status})`,
        error instanceof Error ? error : undefined,
      );
    }

    // A non-numeric code means the body did not come from the API layer, so it
    // carries no verdict about the request itself.
    if (typeof envelope?.code !== "number") {
      throw new NetworkError(
        ADAPTER_NAME,
        `Unrecognized response from ${req.path} (HTTP ${response.status})`,
      );
    }

    return envelope;
  }

  private unwrap<TData>(envelope: TikTokApiEnvelope<TData>): TData {
    if (envelope.code !== TIKTOK_CODE.OK) {
      throw mapTikTokError(envelope.code, envelope.message, envelope.request_id);
    }
    return envelope.data;
  }
}
