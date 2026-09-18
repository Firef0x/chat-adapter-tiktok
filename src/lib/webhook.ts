import crypto from "node:crypto";

export const SIGNATURE_HEADER = "tiktok-signature";
/**
 * Permitted signature timestamp drift, in seconds.
 *
 * TikTok's own sample uses five, which is a sample rather than a security
 * requirement and is far too tight to run on. The budget has to cover network
 * transit, a cold start, time queued behind other work, and any clock skew on
 * the host — and it is spent before verification, not after. When it is
 * exceeded the delivery is answered 401, which makes TikTok replay the *same
 * signed timestamp*, so every retry is staler than the last: a host whose
 * clock is six seconds off rejects one hundred percent of its messages,
 * forever, while logging nothing louder than a warning.
 *
 * Five minutes is the usual replay window for signed webhooks and is what a
 * timestamp check is actually for — stopping a captured delivery from being
 * replayed hours later, not policing NTP.
 */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface ParsedSignature {
  /** Unix epoch **seconds**. */
  timestamp: number;
  /** Hex-encoded HMAC-SHA256. */
  signature: string;
}

/**
 * Parse a `Tiktok-Signature` header of the form `t=1633174587,s=18494715...`.
 *
 * Parts are matched **by name**, not by position. TikTok's own sample indexes
 * them positionally, which silently breaks if the order ever changes.
 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === "t") {
      // `Number("")` is 0, which is finite — so a header with an empty `t=`
      // would parse as a valid epoch and be reported downstream as a
      // signature mismatch, sending whoever debugs it after the app secret
      // instead of the malformed header in front of them.
      const parsed = Number(value);
      if (value !== "" && Number.isInteger(parsed) && parsed > 0) {
        timestamp = parsed;
      }
    } else if (key === "s") {
      signature = value;
    }
  }

  if (timestamp === null || !signature) {
    return null;
  }

  return { timestamp, signature };
}

export type VerificationResult = { valid: true } | { valid: false; reason: string };

export interface VerifyOptions {
  /** Raw `Tiktok-Signature` header value. */
  header: string | null;
  /**
   * The **raw** request body.
   *
   * Must be the bytes as received. Parsing the JSON and re-serializing it does
   * not round-trip, so the recomputed HMAC would never match.
   */
  rawBody: string;
  appSecret: string;
  /** Unix epoch milliseconds. */
  now?: number;
  toleranceSeconds?: number;
}

/**
 * Verify a webhook signature, failing closed.
 *
 * Every failure path returns `valid: false` with a reason rather than
 * throwing, so the caller can log the cause while still answering 401.
 */
export function verifyWebhookSignature(options: VerifyOptions): VerificationResult {
  const {
    header,
    rawBody,
    appSecret,
    now = Date.now(),
    toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  } = options;

  if (!header) {
    return { valid: false, reason: "missing signature header" };
  }

  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return { valid: false, reason: "malformed signature header" };
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest("hex");

  const provided = Buffer.from(parsed.signature, "utf8");
  const computed = Buffer.from(expected, "utf8");

  // timingSafeEqual throws on length mismatch, so check length first — and a
  // differing length is itself a mismatch.
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return { valid: false, reason: "signature mismatch" };
  }

  // Checked only after the HMAC matches: a stale timestamp on an otherwise
  // valid signature is a replay, which is worth distinguishing in logs.
  const driftSeconds = Math.abs(now / 1000 - parsed.timestamp);
  if (driftSeconds > toleranceSeconds) {
    return {
      valid: false,
      reason: `signature timestamp is ${Math.round(driftSeconds)}s away from local time`,
    };
  }

  return { valid: true };
}

/** Compute a signature header. Used by tests and for local verification. */
export function signWebhookBody(
  rawBody: string,
  appSecret: string,
  timestampSeconds: number,
): string {
  const signature = crypto
    .createHmac("sha256", appSecret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${timestampSeconds},s=${signature}`;
}
