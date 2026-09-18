import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { BoundedSet } from "../../src/lib/bounded-set.js";
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  parseSignatureHeader,
  signWebhookBody,
  verifyWebhookSignature,
} from "../../src/lib/webhook.js";

const SECRET = "app_secret_value";
const BODY = '{"client_key":"app_1","event":"im_receive_msg","content":"{}"}';
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;

function validHeader(body = BODY, seconds = NOW_SECONDS) {
  return signWebhookBody(body, SECRET, seconds);
}

describe("parseSignatureHeader", () => {
  it("reads t and s", () => {
    expect(parseSignatureHeader("t=123,s=abc")).toEqual({
      timestamp: 123,
      signature: "abc",
    });
  });

  it("matches by name, not position", () => {
    // TikTok's own sample reads these positionally; this order must still work.
    expect(parseSignatureHeader("s=abc,t=123")).toEqual({
      timestamp: 123,
      signature: "abc",
    });
  });

  it.each([
    ["missing s", "t=123"],
    ["missing t", "s=abc"],
    ["no pairs", "garbage"],
    ["non-numeric t", "t=abc,s=abc"],
    ["empty", ""],
  ])("returns null for a malformed header (%s)", (_label, header) => {
    expect(parseSignatureHeader(header)).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(
      verifyWebhookSignature({
        header: validHeader(),
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    ["missing header", null],
    ["malformed header", "nonsense"],
  ])("rejects a %s", (_label, header) => {
    const result = verifyWebhookSignature({
      header,
      rawBody: BODY,
      appSecret: SECRET,
      now: NOW_MS,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const header = signWebhookBody(BODY, "wrong_secret", NOW_SECONDS);
    expect(
      verifyWebhookSignature({
        header,
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
      }),
    ).toMatchObject({ valid: false, reason: "signature mismatch" });
  });

  it("rejects a tampered body", () => {
    const header = validHeader();
    expect(
      verifyWebhookSignature({
        header,
        rawBody: `${BODY} `,
        appSecret: SECRET,
        now: NOW_MS,
      }),
    ).toMatchObject({ valid: false, reason: "signature mismatch" });
  });

  it("rejects a truncated signature without throwing", () => {
    // timingSafeEqual throws on length mismatch; this must not escape. The
    // result must also be a rejection — asserting only "does not throw" would
    // still pass if the guard returned valid.
    const header = `t=${NOW_SECONDS},s=abc`;
    let result: ReturnType<typeof verifyWebhookSignature> | undefined;
    expect(() => {
      result = verifyWebhookSignature({
        header,
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
      });
    }).not.toThrow();
    expect(result).toMatchObject({ valid: false });
  });

  it("treats an explicit tolerance of 0 as zero, not as unset", () => {
    // `?? DEFAULT` only catches undefined, so 0 must genuinely mean 0.
    expect(
      verifyWebhookSignature({
        header: validHeader(BODY, NOW_SECONDS - 2),
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
        toleranceSeconds: 0,
      }).valid,
    ).toBe(false);
  });

  it("rejects a replayed request outside the tolerance", () => {
    const header = validHeader(BODY, NOW_SECONDS - 3600);
    const result = verifyWebhookSignature({
      header,
      rawBody: BODY,
      appSecret: SECRET,
      now: NOW_MS,
    });
    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/away from local time/);
  });

  it("accepts drift exactly at the tolerance and rejects one second past it", () => {
    // The boundary itself, which `>` and `>=` disagree about: a host sitting
    // exactly on the limit must not flip between accepting and rejecting
    // every one of its deliveries depending on which comparison was written.
    const at = verifyWebhookSignature({
      header: validHeader(BODY, NOW_SECONDS - 300),
      rawBody: BODY,
      appSecret: SECRET,
      now: NOW_MS,
      toleranceSeconds: 300,
    });
    expect(at.valid).toBe(true);

    const past = verifyWebhookSignature({
      header: validHeader(BODY, NOW_SECONDS - 301),
      rawBody: BODY,
      appSecret: SECRET,
      now: NOW_MS,
      toleranceSeconds: 300,
    });
    expect(past.valid).toBe(false);
  });

  it("defaults to a tolerance wide enough to survive ordinary delivery delay", () => {
    // Five seconds — TikTok's sample value — makes a slow cold start or a
    // lightly skewed clock reject every delivery, and each 401 makes TikTok
    // replay the same already-stale timestamp.
    expect(DEFAULT_SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThanOrEqual(60);
    expect(
      verifyWebhookSignature({
        header: validHeader(BODY, NOW_SECONDS - 45),
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
      }).valid,
    ).toBe(true);
  });

  it("rejects a header whose timestamp is empty or not a positive integer", () => {
    // `Number("")` is 0, which is finite: without an explicit check this
    // parses as a valid epoch and is reported as a signature mismatch,
    // pointing whoever debugs it at the app secret instead of the header.
    for (const header of ["t=,s=abc", "t=abc,s=abc", "t=-1,s=abc", "t=1.5,s=abc"]) {
      const result = verifyWebhookSignature({
        header,
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
      });
      expect(result.valid).toBe(false);
      expect((result as { reason: string }).reason).toBe("malformed signature header");
    }
  });

  it("tolerates whitespace around the header's parts", () => {
    const signed = validHeader(BODY, NOW_SECONDS);
    const [t, sig] = signed.split(",");
    expect(
      verifyWebhookSignature({
        header: `${t} , ${sig} `,
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
      }).valid,
    ).toBe(true);
  });

  it("tolerates small clock drift in both directions", () => {
    for (const offset of [-4, 4]) {
      expect(
        verifyWebhookSignature({
          header: validHeader(BODY, NOW_SECONDS + offset),
          rawBody: BODY,
          appSecret: SECRET,
          now: NOW_MS,
        }).valid,
      ).toBe(true);
    }
  });

  it("honours a widened tolerance", () => {
    expect(
      verifyWebhookSignature({
        header: validHeader(BODY, NOW_SECONDS - 60),
        rawBody: BODY,
        appSecret: SECRET,
        now: NOW_MS,
        toleranceSeconds: 120,
      }),
    ).toEqual({ valid: true });
  });

  it("verifies raw bytes, so a re-serialized body fails", () => {
    // The practical trap: JSON.stringify(JSON.parse(body)) drops whitespace
    // and would never reproduce the original HMAC.
    const spaced = '{"a": 1,  "b": 2}';
    const header = signWebhookBody(spaced, SECRET, NOW_SECONDS);
    const reserialized = JSON.stringify(JSON.parse(spaced));

    expect(
      verifyWebhookSignature({
        header,
        rawBody: spaced,
        appSecret: SECRET,
        now: NOW_MS,
      }).valid,
    ).toBe(true);
    expect(
      verifyWebhookSignature({
        header,
        rawBody: reserialized,
        appSecret: SECRET,
        now: NOW_MS,
      }).valid,
    ).toBe(false);
  });

  it("signs exactly `${t}.${body}` with HMAC-SHA256 hex", () => {
    // Pinned against an independent computation so a refactor cannot quietly
    // change the signing string.
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${NOW_SECONDS}.${BODY}`)
      .digest("hex");
    expect(validHeader()).toBe(`t=${NOW_SECONDS},s=${expected}`);
  });
});

describe("BoundedSet", () => {
  it("reports first insertion and rejects repeats", () => {
    const set = new BoundedSet(10);
    expect(set.add("a")).toBe(true);
    expect(set.add("a")).toBe(false);
  });

  it("evicts the oldest entries past its limit", () => {
    const set = new BoundedSet(3);
    for (const value of ["a", "b", "c", "d"]) {
      set.add(value);
    }
    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(false);
    expect(set.has("d")).toBe(true);
  });
});
