import { describe, expect, it } from "vitest";

import {
  channelIdFromThreadId,
  decodeThreadId,
  encodeThreadId,
} from "../../src/lib/thread-id.js";

describe("thread IDs", () => {
  it("round-trips a business and conversation pair", () => {
    const data = { businessId: "biz_123", conversationId: "conv_456" };
    expect(decodeThreadId(encodeThreadId(data))).toEqual(data);
  });

  it("round-trips conversation IDs containing base64 punctuation", () => {
    // TikTok conversation IDs look like this, and the `+` in particular breaks
    // naive encodings and query strings.
    const data = {
      businessId: "biz_123",
      conversationId: "a1AbcBdeCfghDijkEF2b3+lmGn==",
    };
    expect(decodeThreadId(encodeThreadId(data))).toEqual(data);
  });

  it("produces no bare colons beyond the delimiters", () => {
    const threadId = encodeThreadId({
      businessId: "biz:with:colons",
      conversationId: "conv:with:colons",
    });
    expect(threadId.split(":")).toHaveLength(3);
    expect(decodeThreadId(threadId).conversationId).toBe("conv:with:colons");
  });

  it("derives a channel ID from the business account", () => {
    // Pinned to a literal rather than re-derived from the implementation,
    // which would pass under any encoding change applied on both sides.
    const threadId = encodeThreadId({
      businessId: "biz_123",
      conversationId: "conv_456",
    });
    expect(threadId).toBe("tiktok:Yml6XzEyMw:Y29udl80NTY");
    expect(channelIdFromThreadId(threadId)).toBe("tiktok:Yml6XzEyMw");
  });

  it("rejects a thread ID with trailing junk instead of silently accepting it", () => {
    // Base64url decoding discards invalid characters, so without a
    // canonicality check many strings would alias to one conversation — and a
    // corrupted one would decode to a plausible but wrong ID.
    const threadId = encodeThreadId({
      businessId: "biz_123",
      conversationId: "conv_456",
    });
    expect(() => decodeThreadId(`${threadId}$$$`)).toThrow(/Invalid TikTok thread ID/);
  });

  it.each([
    ["wrong adapter", "slack:YmJi:Y2Nj"],
    ["too few segments", "tiktok:YmJi"],
    ["too many segments", "tiktok:YmJi:Y2Nj:ZGRk"],
    ["empty", ""],
  ])("rejects a malformed thread ID (%s)", (_label, threadId) => {
    expect(() => decodeThreadId(threadId)).toThrow(/Invalid TikTok thread ID/);
  });

  it("rejects encoding without a conversation ID", () => {
    expect(() =>
      encodeThreadId({ businessId: "biz_123", conversationId: "" }),
    ).toThrow(/conversationId is required/);
  });
});
