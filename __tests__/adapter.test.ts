import { ValidationError } from "@chat-adapter/shared";
import { NotImplementedError } from "chat";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TikTokAdapter } from "../src/adapter.js";
import { signWebhookBody } from "../src/lib/webhook.js";
import type { TikTokMessageContent } from "../src/types.js";
import { TIKTOK_CODE } from "../src/types.js";

const APP_SECRET = "app_secret_value";
const BUSINESS_ID = "biz_123";
const USER_ID = "user_789";
const CONVERSATION_ID = "conv+abc==";

function okResponse(data: unknown) {
  return {
    json: async () => ({ code: 0, message: "OK", request_id: "req_1", data }),
  } as unknown as Response;
}

function errorResponse(code: number, message = "nope") {
  return {
    json: async () => ({ code, message, request_id: "req_1", data: {} }),
  } as unknown as Response;
}

function messageContent(
  overrides: Partial<TikTokMessageContent> = {},
): TikTokMessageContent {
  return {
    from: "someuser",
    to: "acmebrand",
    unique_identifier: USER_ID,
    from_user: { id: USER_ID, role: "personal_account" },
    to_user: { id: BUSINESS_ID, role: "business_account" },
    conversation_id: CONVERSATION_ID,
    message_id: "msg_1",
    timestamp: 1_700_000_000_000,
    type: "text",
    text: { body: "hello there" },
    scene_type: 0,
    is_follower: false,
    message_tag: { source: "APP" },
    ...overrides,
  };
}

function webhookRequest(
  event: string,
  content: unknown,
  options: { secret?: string; seconds?: number } = {},
) {
  const body = JSON.stringify({
    client_key: "app_1",
    event,
    create_time: Math.floor(Date.now() / 1000),
    user_openid: BUSINESS_ID,
    content: JSON.stringify(content),
  });
  const seconds = options.seconds ?? Math.floor(Date.now() / 1000);
  const header = signWebhookBody(body, options.secret ?? APP_SECRET, seconds);

  return new Request("https://example.com/webhooks/tiktok", {
    method: "POST",
    headers: { "tiktok-signature": header, "content-type": "application/json" },
    body,
  });
}

function build(fetchImpl = vi.fn(async () => okResponse({}))) {
  const adapter = new TikTokAdapter({
    appId: "app_1",
    appSecret: APP_SECRET,
    businessId: BUSINESS_ID,
    accessToken: "access_1",
    refreshToken: "refresh_1",
    accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    fetchImpl: fetchImpl as never,
  });
  return { adapter, fetchImpl };
}

/** Minimal ChatInstance stand-in that records dispatched messages. */
function attachChat(adapter: TikTokAdapter) {
  const processed: Array<{ threadId: string; factory: () => Promise<unknown> }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const chat = {
    getLogger: () => logger,
    processMessage: (
      _adapter: unknown,
      threadId: string,
      factory: () => Promise<unknown>,
    ) => {
      processed.push({ threadId, factory });
    },
  };
  return { chat, processed, logger };
}

describe("TikTokAdapter", () => {
  let adapter: TikTokAdapter;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ adapter, fetchImpl } = build());
  });

  describe("identity", () => {
    it("reports every conversation as a DM", () => {
      expect(adapter.isDM()).toBe(true);
    });

    it("opts into SDK-side history, since TikTok serves only 20 messages", () => {
      expect(adapter.persistThreadHistory).toBe(true);
    });
  });

  describe("handleWebhook", () => {
    beforeEach(async () => {
      const { chat } = attachChat(adapter);
      await adapter.initialize(chat as never);
    });

    it("accepts a correctly signed inbound message", async () => {
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg", messageContent()),
      );

      expect(response.status).toBe(200);
      expect(processed).toHaveLength(1);
    });

    it("rejects a wrongly signed request with 401 and ingests nothing", async () => {
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg", messageContent(), { secret: "wrong" }),
      );

      expect(response.status).toBe(401);
      expect(processed).toHaveLength(0);
    });

    it("rejects a replayed request", async () => {
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg", messageContent(), {
          seconds: Math.floor(Date.now() / 1000) - 3600,
        }),
      );

      expect(response.status).toBe(401);
      expect(processed).toHaveLength(0);
    });

    it("ingests a retried delivery only once", async () => {
      // TikTok retries on any non-2xx, so the same message_id reappears.
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      await adapter.handleWebhook(webhookRequest("im_receive_msg", messageContent()));
      await adapter.handleWebhook(webhookRequest("im_receive_msg", messageContent()));

      expect(processed).toHaveLength(1);
    });

    it("ignores the stripped EU event, which carries no content", async () => {
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg_eu", {
          to: "acmebrand",
          to_user: { id: BUSINESS_ID, role: "business_account" },
          timestamp: Date.now(),
        }),
      );

      expect(response.status).toBe(200);
      expect(processed).toHaveLength(0);
    });

    it("ignores read receipts and other non-message events", async () => {
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      await adapter.handleWebhook(
        webhookRequest("im_mark_read_msg", messageContent({ message_id: "" })),
      );

      expect(processed).toHaveLength(0);
    });

    it("answers 200 on a malformed payload so TikTok stops retrying it", async () => {
      // A body that cannot be parsed will never parse — retrying is pointless.
      const { chat, logger } = attachChat(adapter);
      await adapter.initialize(chat as never);

      const body = JSON.stringify({
        client_key: "app_1",
        event: "im_receive_msg",
        create_time: 1,
        user_openid: BUSINESS_ID,
        content: "{not json",
      });
      const request = new Request("https://example.com/webhooks/tiktok", {
        method: "POST",
        headers: {
          "tiktok-signature": signWebhookBody(
            body,
            APP_SECRET,
            Math.floor(Date.now() / 1000),
          ),
        },
        body,
      });

      const response = await adapter.handleWebhook(request);

      expect(response.status).toBe(200);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("self-echo", () => {
    it("marks TikTok's echo of our own send as isMe so the bot ignores it", async () => {
      // im_send_msg fires for API sends too. Without this the bot would read
      // its own reply as new input and answer itself.
      const sendFetch = vi.fn(async () =>
        okResponse({ message: { message_id: "msg_sent_1" } }),
      );
      const { adapter: local } = build(sendFetch);
      const { chat, processed } = attachChat(local);
      await local.initialize(chat as never);

      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await local.postMessage(threadId, "hi from the bot");

      await local.handleWebhook(
        webhookRequest(
          "im_send_msg",
          messageContent({
            message_id: "msg_sent_1",
            from_user: { id: BUSINESS_ID, role: "business_account" },
            to_user: { id: USER_ID, role: "personal_account" },
          }),
        ),
      );

      expect(processed).toHaveLength(1);
      const message = (await processed[0]?.factory()) as { author: Record<string, unknown> };
      expect(message.author.isMe).toBe(true);
      expect(message.author.isBot).toBe(true);
    });

    it("leaves a human agent's message from the TikTok app as not isMe", async () => {
      // Sent by the business account but not by this runtime — a colleague.
      const { chat, processed } = attachChat(adapter);
      await adapter.initialize(chat as never);

      await adapter.handleWebhook(
        webhookRequest(
          "im_send_msg",
          messageContent({
            message_id: "msg_from_human",
            from_user: { id: BUSINESS_ID, role: "business_account" },
          }),
        ),
      );

      const message = (await processed[0]?.factory()) as { author: Record<string, unknown> };
      expect(message.author.isMe).toBe(false);
    });
  });

  describe("parseMessage", () => {
    it("normalizes a text message", () => {
      const message = adapter.parseMessage(messageContent());
      expect(message.text).toBe("hello there");
      expect(message.id).toBe("msg_1");
      expect(message.author.userId).toBe(USER_ID);
      expect(message.metadata.dateSent.getTime()).toBe(1_700_000_000_000);
    });

    it("renders unsupported types as visible placeholders, not silence", () => {
      // An empty string would read as "the user sent nothing".
      expect(adapter.parseMessage(messageContent({ type: "image", text: undefined })).text).toBe(
        "[image]",
      );
      expect(adapter.parseMessage(messageContent({ type: "sticker", text: undefined })).text).toBe(
        "[sticker]",
      );
    });

    it("treats inbound text literally rather than as markdown", () => {
      const message = adapter.parseMessage(
        messageContent({ text: { body: "*not emphasis*" } }),
      );
      expect(message.text).toBe("*not emphasis*");
    });
  });

  describe("postMessage", () => {
    it("sends text to the conversation and returns the message ID", async () => {
      const sendFetch = vi.fn(async () =>
        okResponse({ message: { message_id: "msg_out" } }),
      );
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      const result = await local.postMessage(threadId, "hello");

      expect(result.id).toBe("msg_out");
      const [url, init] = sendFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/business/message/send/");
      expect(JSON.parse(init.body as string)).toMatchObject({
        business_id: BUSINESS_ID,
        recipient_type: "CONVERSATION",
        recipient: CONVERSATION_ID,
        message_type: "TEXT",
        text: { body: "hello" },
      });
    });

    it("flattens a markdown postable to plain text", async () => {
      const sendFetch = vi.fn(async () =>
        okResponse({ message: { message_id: "msg_out" } }),
      );
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await local.postMessage(threadId, { markdown: "**bold** text" });

      const body = JSON.parse(
        (sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.text.body).toBe("bold text");
    });

    it("rejects an empty message before calling the API", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await expect(adapter.postMessage(threadId, "")).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("rejects text beyond TikTok's 6000-character limit locally", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await expect(
        adapter.postMessage(threadId, "x".repeat(6001)),
      ).rejects.toThrow(/at most 6000/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("surfaces a blocked message as a non-retryable error", async () => {
      const sendFetch = vi.fn(async () => errorResponse(TIKTOK_CODE.MESSAGE_BLOCKED));
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await expect(local.postMessage(threadId, "hi")).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe("sender actions", () => {
    it("sends a typing indicator via SENDER_ACTION", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await adapter.startTyping(threadId);

      const body = JSON.parse(
        (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body).toMatchObject({
        message_type: "SENDER_ACTION",
        sender_action: "TYPING",
      });
    });

    it("marks a conversation read via SENDER_ACTION", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await adapter.markAsRead(threadId);

      const body = JSON.parse(
        (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
      );
      expect(body.sender_action).toBe("MARK_READ");
    });
  });

  describe("fetchMessages", () => {
    it("returns messages and never a cursor, since TikTok has no paging", async () => {
      const listFetch = vi.fn(async () =>
        okResponse({
          messages: [
            messageContent({ message_id: "m1" }),
            messageContent({ message_id: "m2" }),
          ],
          participants: [],
        }),
      );
      const { adapter: local } = build(listFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      const result = await local.fetchMessages(threadId);

      expect(result.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(result.nextCursor).toBeUndefined();
    });

    it("percent-encodes the conversation ID in the query", async () => {
      const listFetch = vi.fn(async () => okResponse({ messages: [], participants: [] }));
      const { adapter: local } = build(listFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await local.fetchMessages(threadId);

      expect(listFetch.mock.calls[0]?.[0]).toContain("conv%2Babc%3D%3D");
    });
  });

  describe("unsupported operations", () => {
    it.each([
      ["addReaction", () => adapter.addReaction("t", "m", "👍")],
      ["removeReaction", () => adapter.removeReaction("t", "m", "👍")],
      ["editMessage", () => adapter.editMessage("t", "m", "x")],
      ["deleteMessage", () => adapter.deleteMessage("t", "m")],
    ])("throws NotImplementedError from %s", async (_label, call) => {
      await expect(call()).rejects.toBeInstanceOf(NotImplementedError);
    });
  });
});
