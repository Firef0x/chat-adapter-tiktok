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

  it("derives a channel ID that is the thread ID minus the conversation", () => {
    const threadId = encodeThreadId({
      businessId: "biz_123",
      conversationId: "conv_456",
    });
    expect(channelIdFromThreadId(threadId)).toBe(
      threadId.split(":").slice(0, 2).join(":"),
    );
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
