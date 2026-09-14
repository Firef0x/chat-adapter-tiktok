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
  /**
   * How many times to retry a throttled request. Defaults to 2; `0` disables
   * retrying.
   */
  maxRateLimitRetries?: number;
  /**
   * Delay before the first retry, in milliseconds, doubling each attempt.
   * Defaults to 1000.
   */
  rateLimitRetryDelayMs?: number;
  /** Injectable delay, for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface TikTokRequest {
  method: "GET" | "POST";
  /** Path below the version segment, e.g. `"business/message/send/"`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Multipart payload, for the media upload endpoint.
   *
   * When present it replaces `body`, and the Content-Type header is left unset
   * so the runtime can add the multipart boundary — setting it by hand
   * produces a body the server cannot parse.
   */
  formData?: FormData;
}

/**
 * Translate a TikTok envelope code into the adapter error taxonomy.
 *
 * Retryability is the distinction that matters to callers:
 * `AdapterRateLimitError` and `NetworkError` are worth retrying, and
 * everything else is not.
 */
export function mapTikTokError(code: number, message: string, requestId?: string): Error {
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
      return new NetworkError(ADAPTER_NAME, `Unrecognized TikTok error ${code}: ${detail}`);
  }
}

/** A non-negative integer, falling back when the value is not a usable one. */
function clampCount(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : fallback;
}

/** Return the envelope's data, or throw the mapped error it reports. */
export function unwrapEnvelope<TData>(envelope: TikTokApiEnvelope<TData>): TData {
  if (envelope.code !== TIKTOK_CODE.OK) {
    throw mapTikTokError(envelope.code, envelope.message, envelope.request_id);
  }
  return envelope.data;
}

/**
 * Perform a TikTok call that carries no `Access-Token` header, and return its
 * envelope.
 *
 * The OAuth and webhook-configuration endpoints authenticate with credentials
 * in the payload rather than the header, so they cannot go through
 * {@link TikTokApiClient}. They still face its three hazards — transport
 * failure, a non-JSON body from a gateway, and a failure reported as HTTP 200
 * with a non-zero code — and every caller that cannot use the client routes
 * through here so those are handled in one place.
 */
export async function fetchEnvelope<TData>(options: {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  /** Multipart payload. Replaces `body`, and suppresses the JSON content type. */
  formData?: FormData;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Names the operation in error messages. */
  operation: string;
}): Promise<TikTokApiEnvelope<TData>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const isJsonPost = options.method === "POST" && !options.formData;

  const headers: Record<string, string> = { ...options.headers };
  if (isJsonPost) {
    headers["Content-Type"] = "application/json";
  }

  let body: BodyInit | undefined;
  if (options.formData) {
    // The content type is left unset so the runtime can add the multipart
    // boundary; setting it by hand produces a body the server cannot parse.
    body = options.formData;
  } else if (isJsonPost) {
    body = JSON.stringify(options.body ?? {});
  }

  let response: Response;
  try {
    response = await fetchImpl(options.url, { method: options.method, headers, body });
  } catch (error) {
    throw new NetworkError(
      ADAPTER_NAME,
      `${options.operation} failed`,
      error instanceof Error ? error : undefined,
    );
  }

  let envelope: TikTokApiEnvelope<TData>;
  try {
    envelope = (await response.json()) as TikTokApiEnvelope<TData>;
  } catch (error) {
    throw new NetworkError(
      ADAPTER_NAME,
      `Non-JSON response from ${options.operation} (HTTP ${response.status})`,
      error instanceof Error ? error : undefined,
    );
  }

  if (typeof envelope?.code !== "number") {
    throw new NetworkError(
      ADAPTER_NAME,
      `Unrecognized response from ${options.operation} (HTTP ${response.status})`,
    );
  }

  return envelope;
}

/**
 * Thin HTTP client for the Business Messaging API.
 *
 * It exists to centralize three things that are easy to get wrong: the custom
 * `Access-Token` header, the fact that failures arrive as HTTP 200 with a
 * non-zero envelope code, and the retry after a token rejection — which is
 * once per attempt, so a throttled request that is retried may refresh more
 * than once, and each refresh rotates the token.
 */
export class TikTokApiClient {
  private readonly tokens: AccessTokenProvider;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRateLimitRetries: number;
  private readonly rateLimitRetryDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: TikTokApiClientOptions) {
    this.tokens = options.tokens;
    this.baseUrl = (options.baseUrl ?? TIKTOK_API_HOST).replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? TIKTOK_DEFAULT_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // `??` lets NaN through, and `attempt >= NaN` is never true — an unbounded
    // retry loop. A NaN delay is worse still: setTimeout(fn, NaN) fires
    // immediately, turning the backoff into a hot loop against a rate limiter.
    this.maxRateLimitRetries = clampCount(options.maxRateLimitRetries, 2);
    this.rateLimitRetryDelayMs = clampCount(options.rateLimitRetryDelayMs, 1000);
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Build a full URL.
   *
   * Callers must include the trailing slash in `path`; TikTok 404s without it.
   */
  buildUrl(path: string, query?: TikTokRequest["query"]): string {
    const normalized = path.replace(/^\/+/, "");
    const url = new URL(`${this.baseUrl}/open_api/${this.apiVersion}/${normalized}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        // URLSearchParams percent-encodes `+`, which conversation IDs contain
        // and which TikTok rejects when passed through literally.
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  /**
   * Perform a request, retrying only while TikTok reports throttling.
   *
   * The backoff is deliberately short. TikTok's own documented recovery for a
   * per-minute overage is five minutes and a per-day overage resets at
   * midnight UTC, so retrying cannot rescue a sustained overage — and waiting
   * that long inside a webhook handler would be worse than failing. What this
   * does cover is a brief burst, where a second or two is enough.
   */
  async request<TData>(req: TikTokRequest): Promise<TData> {
    let delay = this.rateLimitRetryDelayMs;

    for (let attempt = 0; ; attempt++) {
      // Sequential by definition: a backoff exists to space attempts out, so
      // there is nothing here to parallelise.
      // oxlint-disable-next-line no-await-in-loop
      const envelope = await this.attempt<TData>(req);

      if (envelope.code !== TIKTOK_CODE.RATE_LIMITED || attempt >= this.maxRateLimitRetries) {
        return this.unwrap(envelope);
      }

      // oxlint-disable-next-line no-await-in-loop
      await this.sleepImpl(delay);
      delay *= 2;
    }
  }

  /** One request, including the single token refresh on rejection. */
  private async attempt<TData>(req: TikTokRequest): Promise<TikTokApiEnvelope<TData>> {
    const token = await this.tokens.getAccessToken();

    const first = await this.send<TData>(req, token);
    if (first.code !== TIKTOK_CODE.INVALID_ACCESS_TOKEN) {
      return first;
    }

    // The token was rejected despite looking unexpired — it may have been
    // revoked, or the clock may be off. Refresh once and try again; a second
    // rejection is a real authentication failure.
    const refreshed = await this.tokens.refreshAccessToken();
    return this.send<TData>(req, refreshed);
  }

  private async send<TData>(
    req: TikTokRequest,
    accessToken: string,
  ): Promise<TikTokApiEnvelope<TData>> {
    return fetchEnvelope<TData>({
      url: this.buildUrl(req.path, req.query),
      method: req.method,
      body: req.body,
      formData: req.formData,
      // The messaging endpoints use this custom header rather than a Bearer
      // token, despite `token_type` being reported as "Bearer".
      headers: { "Access-Token": accessToken },
      fetchImpl: this.fetchImpl,
      operation: req.path,
    });
  }

  private unwrap<TData>(envelope: TikTokApiEnvelope<TData>): TData {
    return unwrapEnvelope(envelope);
  }
}
