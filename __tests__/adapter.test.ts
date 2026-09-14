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

function messageContent(overrides: Partial<TikTokMessageContent> = {}): TikTokMessageContent {
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

/**
 * A message as the REST history endpoint returns it: UPPERCASE `message_type`
 * and no `conversation_id`, unlike the webhook payload.
 */
function restMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: "m1",
    message_type: "TEXT",
    timestamp: 1_700_000_000_000,
    text: { body: "from history" },
    ...overrides,
  };
}

/** The reactor's user ID from a recorded reaction event. */
function userIdOf(entry?: { event?: Record<string, unknown> }): string | undefined {
  return (entry?.event?.user as { userId?: string } | undefined)?.userId;
}

/** Minimal ChatInstance stand-in that records dispatched messages. */
function attachChat() {
  const processed: Array<{ threadId: string; factory: () => Promise<unknown> }> = [];
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const chat = {
    getLogger: () => logger,
    processMessage: (_adapter: unknown, threadId: string, factory: () => Promise<unknown>) => {
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
      const { chat } = attachChat();
      await adapter.initialize(chat as never);
    });

    it("accepts a correctly signed inbound message", async () => {
      const { chat, processed } = attachChat();
      await adapter.initialize(chat as never);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg", messageContent()),
      );

      expect(response.status).toBe(200);
      expect(processed).toHaveLength(1);
    });

    it("rejects a wrongly signed request with 401 and ingests nothing", async () => {
      const { chat, processed } = attachChat();
      await adapter.initialize(chat as never);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg", messageContent(), { secret: "wrong" }),
      );

      expect(response.status).toBe(401);
      expect(processed).toHaveLength(0);
    });

    it("rejects a replayed request", async () => {
      const { chat, processed } = attachChat();
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
      const { chat, processed } = attachChat();
      await adapter.initialize(chat as never);

      await adapter.handleWebhook(webhookRequest("im_receive_msg", messageContent()));
      await adapter.handleWebhook(webhookRequest("im_receive_msg", messageContent()));

      expect(processed).toHaveLength(1);
    });

    it("ignores the stripped EU event, which carries no content", async () => {
      const { chat, processed } = attachChat();
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
      const { chat, processed } = attachChat();
      await adapter.initialize(chat as never);

      await adapter.handleWebhook(
        webhookRequest("im_mark_read_msg", messageContent({ message_id: "" })),
      );

      expect(processed).toHaveLength(0);
    });

    it("answers 200 on a malformed payload so TikTok stops retrying it", async () => {
      // A body that cannot be parsed will never parse — retrying is pointless.
      const { chat, logger } = attachChat();
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
          "tiktok-signature": signWebhookBody(body, APP_SECRET, Math.floor(Date.now() / 1000)),
        },
        body,
      });

      const response = await adapter.handleWebhook(request);

      expect(response.status).toBe(200);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("robustness", () => {
    it("does not crash the process when the host handler rejects", async () => {
      // processMessage returns a promise; leaving it unawaited made a failing
      // host handler an unhandled rejection, which kills the worker.
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const chat = {
        getLogger: () => logger,
        processMessage: () => Promise.reject(new Error("handler blew up")),
      };
      await adapter.initialize(chat as never);

      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on("unhandledRejection", onRejection);

      const response = await adapter.handleWebhook(
        webhookRequest("im_receive_msg", messageContent()),
      );
      await new Promise((resolve) => setImmediate(resolve));
      process.off("unhandledRejection", onRejection);

      expect(response.status).toBe(200);
      expect(rejections).toHaveLength(0);
      expect(logger.error).toHaveBeenCalled();
    });

    it("reports a webhook that arrives before initialize instead of eating it", async () => {
      // Silently dropping it would also poison the dedupe cache, so even a
      // redelivery could never recover the message.
      const { adapter: uninitialized } = build();

      const response = await uninitialized.handleWebhook(
        webhookRequest("im_receive_msg", messageContent()),
      );

      expect(response.status).toBe(200);
    });

    it("refuses a webhook addressed to a different business account", async () => {
      // One app URL receives webhooks for every authorized account.
      const { chat, processed, logger } = attachChat();
      await adapter.initialize(chat as never);

      const body = JSON.stringify({
        client_key: "app_1",
        event: "im_receive_msg",
        create_time: Math.floor(Date.now() / 1000),
        user_openid: "SOMEONE_ELSES_BUSINESS",
        content: JSON.stringify(messageContent()),
      });
      const request = new Request("https://example.com/webhooks/tiktok", {
        method: "POST",
        headers: {
          "tiktok-signature": signWebhookBody(body, APP_SECRET, Math.floor(Date.now() / 1000)),
        },
        body,
      });

      expect((await adapter.handleWebhook(request)).status).toBe(200);
      expect(processed).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("rejects empty credentials at construction", () => {
      // createHmac accepts an empty key, so every webhook would verify against
      // a secret anyone could guess.
      expect(
        () =>
          new TikTokAdapter({
            appId: "app_1",
            appSecret: "",
            businessId: BUSINESS_ID,
            accessToken: "a",
            refreshToken: "r",
          }),
      ).toThrow(ValidationError);
    });
  });

  describe("self-echo", () => {
    it("marks TikTok's echo of our own send as isMe so the bot ignores it", async () => {
      // im_send_msg fires for API sends too. Without this the bot would read
      // its own reply as new input and answer itself.
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_sent_1" } }));
      const { adapter: local } = build(sendFetch);
      const { chat, processed } = attachChat();
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

    it("recognizes an echo that arrives before the send response", async () => {
      // The race the sent-ID set cannot win: TikTok's message_tag.source
      // identifies an API-originated message without needing the send to have
      // returned yet.
      const message = adapter.parseMessage(
        messageContent({
          message_id: "never_recorded",
          from_user: { id: BUSINESS_ID, role: "business_account" },
          to_user: { id: USER_ID, role: "personal_account" },
          message_tag: { source: "API" },
        }),
      );

      expect(message.author.isMe).toBe(true);
      expect(message.author.isBot).toBe(true);
    });

    it("fails a send that returns no message_id rather than losing echo protection", async () => {
      // Reporting success with id "" left the echo unrecognized, so the bot
      // would answer its own reply.
      const sendFetch = vi.fn(async () => okResponse({ message: {} }));
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await expect(local.postMessage(threadId, "hi")).rejects.toThrow(/no message_id/);
    });

    it("leaves a human agent's message from the TikTok app as not isMe", async () => {
      // Sent by the business account but not by this runtime — a colleague.
      const { chat, processed } = attachChat();
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

    it("renders an inbound template with its reply options", () => {
      // The buttons are the substance of a template; a bot that only sees the
      // title has nothing to choose from.
      const message = adapter.parseMessage(
        messageContent({
          type: "template",
          text: undefined,
          template: {
            type: "qa_button_card",
            elements: [
              {
                title: "How can we help?",
                buttons: [
                  { text: "Track my order", type: "REPLY", id: "track" },
                  { text: "Talk to a human", type: "REPLY", id: "human" },
                ],
              },
            ],
          },
        }),
      );

      expect(message.text).toContain("How can we help?");
      expect(message.text).toContain("Track my order");
      expect(message.text).toContain("Talk to a human");
    });

    it("falls back to a placeholder for a template with no content", () => {
      const message = adapter.parseMessage(
        messageContent({ type: "template", text: undefined, template: undefined }),
      );
      expect(message.text).toBe("[template]");
    });

    it("treats inbound text literally rather than as markdown", () => {
      const message = adapter.parseMessage(messageContent({ text: { body: "*not emphasis*" } }));
      expect(message.text).toBe("*not emphasis*");
    });
  });

  describe("postMessage", () => {
    it("sends text to the conversation and returns the message ID", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_out" } }));
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
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_out" } }));
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await local.postMessage(threadId, { markdown: "**bold** text" });

      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.text.body).toBe("bold text");
    });

    it("sends a fitting card as a Q&A button card", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_out" } }));
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await local.postMessage(threadId, {
        card: {
          type: "card",
          title: "How can we help?",
          children: [
            {
              type: "actions",
              children: [{ type: "button", id: "track", label: "Track order" }],
            },
          ],
        },
      } as never);

      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.message_type).toBe("TEMPLATE");
      expect(body.template).toMatchObject({
        type: "QA_BUTTON_CARD",
        title: "How can we help?",
        buttons: [{ type: "REPLY", title: "Track order", id: "track" }],
      });
      expect(body.text).toBeUndefined();
    });

    it("falls back to text for a card that cannot be a template", async () => {
      // Four buttons exceeds the documented maximum of three.
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_out" } }));
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await local.postMessage(threadId, {
        card: {
          type: "card",
          title: "Pick one",
          children: [
            {
              type: "actions",
              children: [
                { type: "button", id: "a", label: "A" },
                { type: "button", id: "b", label: "B" },
                { type: "button", id: "c", label: "C" },
                { type: "button", id: "d", label: "D" },
              ],
            },
          ],
        },
      } as never);

      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.message_type).toBe("TEXT");
      // The options must still be visible, not silently dropped.
      expect(body.text.body).toContain("A");
      expect(body.text.body).toContain("D");
    });

    it("honours useTemplates: false by always sending text", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_out" } }));
      const local = new TikTokAdapter({
        appId: "app_1",
        appSecret: APP_SECRET,
        businessId: BUSINESS_ID,
        accessToken: "access_1",
        refreshToken: "refresh_1",
        accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        useTemplates: false,
        fetchImpl: sendFetch as never,
      });
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await local.postMessage(threadId, {
        card: {
          type: "card",
          title: "How can we help?",
          children: [
            {
              type: "actions",
              children: [{ type: "button", id: "track", label: "Track order" }],
            },
          ],
        },
      } as never);

      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.message_type).toBe("TEXT");
      expect(body.text.body).toContain("Track order");
    });

    it("rejects an empty message before calling the API", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await expect(adapter.postMessage(threadId, "")).rejects.toBeInstanceOf(ValidationError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("rejects text beyond TikTok's 6000-character limit locally", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await expect(adapter.postMessage(threadId, "x".repeat(6001))).rejects.toThrow(/at most 6000/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("surfaces a blocked message as a non-retryable error", async () => {
      const sendFetch = vi.fn(async () => errorResponse(TIKTOK_CODE.MESSAGE_BLOCKED));
      const { adapter: local } = build(sendFetch);
      const threadId = local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });

      await expect(local.postMessage(threadId, "hi")).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("sender actions", () => {
    it("sends a typing indicator via SENDER_ACTION", async () => {
      const threadId = adapter.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      await adapter.startTyping(threadId);

      const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
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

      const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.sender_action).toBe("MARK_READ");
    });
  });

  describe("fetchMessages", () => {
    function listFetchOf(messages: unknown[]) {
      return vi.fn(async () => okResponse({ messages, participants: [] }));
    }

    function threadFor(local: TikTokAdapter) {
      return local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
    }

    it("reads REST-shaped history rather than assuming the webhook shape", async () => {
      // Previously these were cast into the webhook parser, so every message
      // came back with empty text — or threw on the absent conversation_id.
      const { adapter: local } = build(listFetchOf([restMessage()]));

      const result = await local.fetchMessages(threadFor(local));

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.text).toBe("from history");
      expect(result.messages[0]?.id).toBe("m1");
      expect(result.nextCursor).toBeUndefined();
    });

    it("takes the conversation from the thread, since history omits it", async () => {
      const { adapter: local } = build(listFetchOf([restMessage()]));
      const threadId = threadFor(local);

      const result = await local.fetchMessages(threadId);

      expect(result.messages[0]?.threadId).toBe(threadId);
    });

    it("maps UPPERCASE REST types to placeholders", async () => {
      const { adapter: local } = build(
        listFetchOf([restMessage({ message_type: "IMAGE", text: undefined })]),
      );

      const result = await local.fetchMessages(threadFor(local));

      expect(result.messages[0]?.text).toBe("[image]");
    });

    it("skips an entry with no message_id instead of failing the page", async () => {
      const { adapter: local } = build(listFetchOf([restMessage(), { message_type: "TEXT" }]));

      const result = await local.fetchMessages(threadFor(local));

      expect(result.messages).toHaveLength(1);
    });

    it("returns messages oldest first regardless of TikTok's ordering", async () => {
      const { adapter: local } = build(
        listFetchOf([
          restMessage({ message_id: "newer", timestamp: 2000 }),
          restMessage({ message_id: "older", timestamp: 1000 }),
        ]),
      );

      const result = await local.fetchMessages(threadFor(local));

      expect(result.messages.map((m) => m.id)).toEqual(["older", "newer"]);
    });

    it("keeps the newest when a limit trims the page", async () => {
      const { adapter: local } = build(
        listFetchOf([
          restMessage({ message_id: "a", timestamp: 1000 }),
          restMessage({ message_id: "b", timestamp: 2000 }),
          restMessage({ message_id: "c", timestamp: 3000 }),
        ]),
      );

      const result = await local.fetchMessages(threadFor(local), { limit: 2 });

      expect(result.messages.map((m) => m.id)).toEqual(["b", "c"]);
    });

    it("treats limit 0 as none rather than everything", async () => {
      // `options.limit &&` made 0 falsy, returning the whole page.
      const { adapter: local } = build(listFetchOf([restMessage(), restMessage()]));

      const result = await local.fetchMessages(threadFor(local), { limit: 0 });

      expect(result.messages).toEqual([]);
    });

    it("gives a usable date when history omits the timestamp", async () => {
      // `new Date(undefined)` is an Invalid Date, which corrupts ordering
      // silently because it compares false against everything.
      const { adapter: local } = build(listFetchOf([restMessage({ timestamp: undefined })]));

      const result = await local.fetchMessages(threadFor(local));

      expect(Number.isNaN(result.messages[0]?.metadata.dateSent.getTime())).toBe(false);
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

  describe("reply", () => {
    function threadFor(local: TikTokAdapter) {
      return local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
    }

    it("quotes the referenced message as a TEXT send", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_r" } }));
      const { adapter: local } = build(sendFetch);

      const result = await local.reply(threadFor(local), "msg_original", "sure thing");

      expect(result.id).toBe("msg_r");
      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body).toMatchObject({
        message_type: "TEXT",
        text: { body: "sure thing" },
        referenced_message_info: { referenced_message_id: "msg_original" },
      });
    });

    it("flattens a card rather than sending a template", async () => {
      // referenced_message_info requires message_type TEXT, so a quoted reply
      // can never be a template.
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_r" } }));
      const { adapter: local } = build(sendFetch);

      await local.reply(threadFor(local), "msg_original", {
        card: {
          type: "card",
          title: "How can we help?",
          children: [{ type: "actions", children: [{ type: "button", id: "t", label: "Track" }] }],
        },
      } as never);

      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.message_type).toBe("TEXT");
      expect(body.template).toBeUndefined();
      expect(body.text.body).toContain("Track");
    });

    it("refuses an image as a quoted reply", async () => {
      const sendFetch = vi.fn();
      const { adapter: local } = build(sendFetch);

      await expect(
        local.reply(threadFor(local), "msg_original", {
          files: [{ data: Buffer.from("png"), filename: "a.png", mimeType: "image/png" }],
        } as never),
      ).rejects.toThrow(/text-only quoted replies/);
      expect(sendFetch).not.toHaveBeenCalled();
    });

    it("applies the same text limits as a plain send", async () => {
      const sendFetch = vi.fn();
      const { adapter: local } = build(sendFetch);

      await expect(local.reply(threadFor(local), "m", "")).rejects.toThrow(/empty message/);
      await expect(local.reply(threadFor(local), "m", "x".repeat(6001))).rejects.toThrow(
        /at most 6000/,
      );
      expect(sendFetch).not.toHaveBeenCalled();
    });

    it("records the reply so its echo is recognized", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_r" } }));
      const { adapter: local } = build(sendFetch);

      await local.reply(threadFor(local), "msg_original", "hi");
      const echo = local.parseMessage(
        messageContent({
          message_id: "msg_r",
          from_user: { id: BUSINESS_ID, role: "business_account" },
        }),
      );

      expect(echo.author.isMe).toBe(true);
    });
  });

  describe("sharePost", () => {
    function threadFor(local: TikTokAdapter) {
      return local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
    }

    it("sends the post by item_id, not a URL", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_share" } }));
      const { adapter: local } = build(sendFetch);

      const result = await local.sharePost(threadFor(local), "item_1");

      expect(result.id).toBe("msg_share");
      const body = JSON.parse((sendFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body).toMatchObject({
        message_type: "SHARE_POST",
        share_post: { item_id: "item_1" },
        recipient: CONVERSATION_ID,
      });
      expect(body.text).toBeUndefined();
    });

    it("records the share so its echo is recognized", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: { message_id: "msg_share" } }));
      const { adapter: local } = build(sendFetch);

      await local.sharePost(threadFor(local), "item_1");
      const echo = local.parseMessage(
        messageContent({
          message_id: "msg_share",
          from_user: { id: BUSINESS_ID, role: "business_account" },
        }),
      );

      expect(echo.author.isMe).toBe(true);
    });

    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
    ])("rejects a %s post ID before calling the API", async (_label, itemId) => {
      // The sibling send paths use `.trim()` for their emptiness checks, so
      // this one must too or a blank ID reaches TikTok.
      const sendFetch = vi.fn();
      const { adapter: local } = build(sendFetch);

      await expect(local.sharePost(threadFor(local), itemId)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(sendFetch).not.toHaveBeenCalled();
    });

    it("fails a share that returns no message_id", async () => {
      const sendFetch = vi.fn(async () => okResponse({ message: {} }));
      const { adapter: local } = build(sendFetch);

      await expect(local.sharePost(threadFor(local), "item_1")).rejects.toThrow(/no message_id/);
    });
  });

  describe("rate-limit configuration", () => {
    it("passes the retry settings through to the API client", async () => {
      // These were declared on the adapter config but never forwarded, so
      // configuring them silently did nothing.
      const slept: number[] = [];
      const throttledThenOk = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(TIKTOK_CODE.RATE_LIMITED, "slow down"))
        .mockResolvedValueOnce(okResponse({ message: { message_id: "msg_1" } }));

      const local = new TikTokAdapter({
        appId: "app_1",
        appSecret: APP_SECRET,
        businessId: BUSINESS_ID,
        accessToken: "access_1",
        refreshToken: "refresh_1",
        accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        rateLimitRetryDelayMs: 42,
        fetchImpl: throttledThenOk as never,
        sleepImpl: async (ms: number) => {
          slept.push(ms);
        },
      });

      await local.postMessage(
        local.encodeThreadId({ businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }),
        "hi",
      );

      expect(slept).toEqual([42]);
      expect(throttledThenOk).toHaveBeenCalledTimes(2);
    });

    it("honours maxRateLimitRetries of 0", async () => {
      const slept: number[] = [];
      const alwaysThrottled = vi.fn(async () =>
        errorResponse(TIKTOK_CODE.RATE_LIMITED, "slow down"),
      );

      const local = new TikTokAdapter({
        appId: "app_1",
        appSecret: APP_SECRET,
        businessId: BUSINESS_ID,
        accessToken: "access_1",
        refreshToken: "refresh_1",
        accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        maxRateLimitRetries: 0,
        fetchImpl: alwaysThrottled as never,
        sleepImpl: async (ms: number) => {
          slept.push(ms);
        },
      });

      await expect(
        local.postMessage(
          local.encodeThreadId({ businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }),
          "hi",
        ),
      ).rejects.toThrow();
      expect(alwaysThrottled).toHaveBeenCalledTimes(1);
      expect(slept).toEqual([]);
    });
  });

  describe("referral attribution", () => {
    const referralContent = {
      from: "someuser",
      to: "acmebrand",
      unique_identifier: USER_ID,
      from_user: { id: USER_ID, role: "personal_account" },
      to_user: { id: BUSINESS_ID, role: "business_account" },
      conversation_id: CONVERSATION_ID,
      timestamp: 1_700_000_000_000,
      referral: {
        source: "ad",
        ad: {
          advertiser_id: "adv_1",
          ad_id: "ad_1",
          timestamp: 1_700_000_000_000,
          ad_name: "Spring sale",
          embed_url: "https://tiktok.com/v/1",
          message_material_id: "mat_1",
        },
      },
    };

    function buildWith(onReferral?: (event: unknown) => void) {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const local = new TikTokAdapter({
        appId: "app_1",
        appSecret: APP_SECRET,
        businessId: BUSINESS_ID,
        accessToken: "access_1",
        refreshToken: "refresh_1",
        accessTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        onReferral: onReferral as never,
        fetchImpl: vi.fn() as never,
      });
      return { local, logger };
    }

    it("reports which ad or link brought the user in", async () => {
      // The attribution appears nowhere else: the event carries no message, so
      // it is unreachable from the message stream.
      const seen: Array<Record<string, unknown>> = [];
      const { local, logger } = buildWith((event) => {
        seen.push(event as Record<string, unknown>);
      });
      await local.initialize({ getLogger: () => logger } as never);

      const response = await local.handleWebhook(
        webhookRequest("im_referral_msg", referralContent),
      );

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        threadId: local.encodeThreadId({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        }),
      });
      const referral = seen[0]?.referral as { ad?: { ad_id?: string } } | undefined;
      expect(referral?.ad?.ad_id).toBe("ad_1");
    });

    it("logs rather than failing when no handler is configured", async () => {
      const { local, logger } = buildWith(undefined);
      await local.initialize({ getLogger: () => logger } as never);

      const response = await local.handleWebhook(
        webhookRequest("im_referral_msg", referralContent),
      );

      expect(response.status).toBe(200);
      // The specific message, not merely "some debug line" — the fall-through
      // path for an unhandled event also logs at debug, so a looser assertion
      // would pass with the whole feature deleted.
      expect(logger.debug).toHaveBeenCalledWith(
        "A TikTok referral arrived but no onReferral is configured",
        expect.anything(),
      );
    });

    it("does not turn a failing handler into a retried webhook", async () => {
      // Returning non-2xx would replay the same referral, failing identically.
      const { local, logger } = buildWith(() => {
        throw new Error("handler blew up");
      });
      await local.initialize({ getLogger: () => logger } as never);

      const response = await local.handleWebhook(
        webhookRequest("im_referral_msg", referralContent),
      );

      expect(response.status).toBe(200);
      expect(logger.error).toHaveBeenCalled();
    });

    it.each([
      ["no conversation", { conversation_id: "" }],
      ["no referral data", { referral: undefined }],
    ])("ignores an incomplete referral (%s)", async (_label, overrides) => {
      const seen: unknown[] = [];
      const { local, logger } = buildWith((event) => seen.push(event));
      await local.initialize({ getLogger: () => logger } as never);

      await local.handleWebhook(
        webhookRequest("im_referral_msg", { ...referralContent, ...overrides }),
      );

      expect(seen).toHaveLength(0);
      expect(logger.debug).toHaveBeenCalledWith("Ignoring an incomplete TikTok referral");
    });

    it("refuses a referral addressed to a different business", async () => {
      // Otherwise another account's attribution would be reported as this
      // account's, stamped with this adapter's businessId.
      const seen: unknown[] = [];
      const { local, logger } = buildWith((event) => seen.push(event));
      await local.initialize({ getLogger: () => logger } as never);

      const body = JSON.stringify({
        client_key: "app_1",
        event: "im_referral_msg",
        create_time: Math.floor(Date.now() / 1000),
        user_openid: "SOMEONE_ELSES_BUSINESS",
        content: JSON.stringify(referralContent),
      });
      const request = new Request("https://example.com/webhooks/tiktok", {
        method: "POST",
        headers: {
          "tiktok-signature": signWebhookBody(body, APP_SECRET, Math.floor(Date.now() / 1000)),
        },
        body,
      });

      expect((await local.handleWebhook(request)).status).toBe(200);
      expect(seen).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("does not deliver a referral as a message", async () => {
      const { chat, processed } = attachChat();
      await adapter.initialize(chat as never);

      await adapter.handleWebhook(webhookRequest("im_referral_msg", referralContent));

      expect(processed).toHaveLength(0);
    });
  });

  describe("inbound reactions", () => {
    function reactionContent(entries: unknown[]) {
      return messageContent({
        message_id: "msg_reaction",
        type: "reaction",
        text: undefined,
        reaction: entries as never,
      });
    }

    async function dispatch(content: unknown) {
      const processed: unknown[] = [];
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const chat = {
        getLogger: () => logger,
        processMessage: () => processed.push({ kind: "message" }),
        processReaction: (event: unknown) => processed.push({ kind: "reaction", event }),
      };
      await adapter.initialize(chat as never);
      await adapter.handleWebhook(webhookRequest("im_receive_msg", content));
      return processed as Array<{ kind: string; event?: Record<string, unknown> }>;
    }

    it("dispatches a reaction instead of a bare placeholder message", async () => {
      // Routing it as a message would put "[reaction]" in the conversation and
      // discard the emoji, the direction, and the target message.
      const processed = await dispatch(
        reactionContent([
          {
            operation: "ADD",
            type: "EMOJI",
            emoji: "👍",
            unique_identifier: USER_ID,
            timestamp: 1,
            original_msg_id: "msg_target",
          },
        ]),
      );

      expect(processed).toHaveLength(1);
      expect(processed[0]?.kind).toBe("reaction");
      expect(processed[0]?.event).toMatchObject({
        // `adapter` is optional in the SDK's type but required at runtime:
        // without it the event is dropped before any handler runs, so the
        // whole feature silently does nothing.
        adapter,
        added: true,
        rawEmoji: "👍",
        messageId: "msg_target",
        threadId: adapter.encodeThreadId({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        }),
      });
      expect(userIdOf(processed[0])).toBe(USER_ID);
    });

    it("attributes each entry to its own reactor", async () => {
      // A batched payload must not credit every reaction to the payload
      // header's sender. The SDK drops events whose user is the bot itself,
      // so mis-attribution can silence a genuine reaction outright.
      const processed = await dispatch(
        reactionContent([
          {
            operation: "ADD",
            type: "EMOJI",
            emoji: "👍",
            unique_identifier: "reactor_a",
            timestamp: 1,
            original_msg_id: "msg_target",
          },
          {
            operation: "ADD",
            type: "EMOJI",
            emoji: "🎉",
            unique_identifier: "reactor_b",
            timestamp: 2,
            original_msg_id: "msg_target",
          },
        ]),
      );

      expect(processed.map(userIdOf)).toEqual(["reactor_a", "reactor_b"]);
    });

    it("reports a removal as added: false", async () => {
      const processed = await dispatch(
        reactionContent([
          {
            operation: "REMOVE",
            type: "EMOJI",
            emoji: "👍",
            unique_identifier: USER_ID,
            timestamp: 1,
            original_msg_id: "msg_target",
          },
        ]),
      );

      expect(processed[0]?.event).toMatchObject({ added: false });
    });

    it("emits one event per entry", async () => {
      const entry = (emoji: string) => ({
        operation: "ADD",
        type: "EMOJI",
        emoji,
        unique_identifier: USER_ID,
        timestamp: 1,
        original_msg_id: "msg_target",
      });

      const processed = await dispatch(reactionContent([entry("👍"), entry("🎉")]));

      expect(processed).toHaveLength(2);
      expect(processed.every((p) => p.kind === "reaction")).toBe(true);
    });

    it("falls back to the AI emoji URL when there is no character", async () => {
      const processed = await dispatch(
        reactionContent([
          {
            operation: "ADD",
            type: "AI_EMOJI",
            ai_emoji_url: "https://cdn/ai.png",
            unique_identifier: USER_ID,
            timestamp: 1,
            original_msg_id: "msg_target",
          },
        ]),
      );

      expect(processed[0]?.event).toMatchObject({ rawEmoji: "https://cdn/ai.png" });
    });

    it("dispatches nothing for a reaction payload with no entries", async () => {
      const processed = await dispatch(reactionContent([]));
      expect(processed).toHaveLength(0);
    });

    it("skips an entry with no target message", async () => {
      const processed = await dispatch(
        reactionContent([
          {
            operation: "ADD",
            type: "EMOJI",
            emoji: "👍",
            unique_identifier: USER_ID,
            timestamp: 1,
          },
        ]),
      );

      expect(processed).toHaveLength(0);
    });
  });

  describe("images", () => {
    const png = { data: Buffer.from("png"), filename: "a.png", mimeType: "image/png" };

    function threadFor(local: TikTokAdapter) {
      return local.encodeThreadId({
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
    }

    it("checks capability, uploads, then sends an IMAGE message", async () => {
      const calls = vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            capability_infos: [{ capability_type: "IMAGE_SEND", capability_result: true }],
          }),
        )
        .mockResolvedValueOnce(okResponse({ media_id: "media_1" }))
        .mockResolvedValueOnce(okResponse({ message: { message_id: "msg_img" } }));
      const { adapter: local } = build(calls);

      const result = await local.postMessage(threadFor(local), { files: [png] } as never);

      expect(result.id).toBe("msg_img");
      const urls = calls.mock.calls.map((c) => c[0] as string);
      expect(urls[0]).toContain("capabilities/get/");
      expect(urls[1]).toContain("media/upload/");
      const sendBody = JSON.parse((calls.mock.calls[2] as [string, RequestInit])[1].body as string);
      expect(sendBody).toMatchObject({
        message_type: "IMAGE",
        image: { media_id: "media_1" },
      });
    });

    it("refuses when the conversation cannot receive images", async () => {
      // Region-gated on both sides; skipping the check yields an opaque error.
      const calls = vi.fn(async () =>
        okResponse({
          capability_infos: [{ capability_type: "IMAGE_SEND", capability_result: false }],
        }),
      );
      const { adapter: local } = build(calls);

      await expect(local.postMessage(threadFor(local), { files: [png] } as never)).rejects.toThrow(
        /gates image support/,
      );
    });

    it("refuses text and an image together instead of quietly sending two", async () => {
      // TikTok forbids the combination, and splitting it would consume two
      // slots of a messaging window capped as low as ten.
      const calls = vi.fn();
      const { adapter: local } = build(calls);

      await expect(
        local.postMessage(threadFor(local), { raw: "caption", files: [png] } as never),
      ).rejects.toThrow(/cannot combine text and an image/);
      expect(calls).not.toHaveBeenCalled();
    });

    it("refuses more than one image per message", async () => {
      const calls = vi.fn();
      const { adapter: local } = build(calls);

      await expect(
        local.postMessage(threadFor(local), { files: [png, png] } as never),
      ).rejects.toThrow(/one image per message/);
      expect(calls).not.toHaveBeenCalled();
    });

    it("attaches inbound media without downloading it during parsing", async () => {
      // Most messages are never asked for their bytes, and the download URL
      // expires after 24 hours — so resolving eagerly would waste two requests.
      const calls = vi.fn();
      const { adapter: local } = build(calls);

      const message = local.parseMessage(
        messageContent({ type: "image", text: undefined, image: { media_id: "media_9" } }),
      );

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]?.type).toBe("image");
      expect(calls).not.toHaveBeenCalled();
    });

    it("downloads inbound media only when fetchData is called", async () => {
      const calls = vi
        .fn()
        .mockResolvedValueOnce(okResponse({ download_url: "https://cdn/x" }))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([7, 7]).buffer,
        });
      const { adapter: local } = build(calls);

      const message = local.parseMessage(
        messageContent({ type: "image", text: undefined, image: { media_id: "media_9" } }),
      );
      const bytes = await message.attachments[0]?.fetchData?.();

      expect((bytes as Buffer).length).toBe(2);
      expect(calls.mock.calls[0]?.[0]).toContain("media/download/");
    });

    it("gives a text message no attachments", () => {
      const { adapter: local } = build();
      expect(local.parseMessage(messageContent()).attachments).toEqual([]);
    });

    it.each([
      ["sticker", { sticker: { url: "https://cdn/s.png" } }],
      ["emoji", { emoji: { url: "https://cdn/e.png" } }],
    ])("exposes an inbound %s as an attachment with its URL", (type, extra) => {
      // These arrive as plain URLs, so they need no download-URL request.
      const { adapter: local } = build();

      const message = local.parseMessage(
        messageContent({ type: type as never, text: undefined, ...extra }),
      );

      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0]).toMatchObject({
        type: "image",
        // The extension comes from the URL, so a consumer can infer a type.
        name: `${type}.png`,
        mimeType: "image/png",
        url: Object.values(extra)[0]?.url,
      });
    });

    it("falls back to a bare name when the URL has no extension", () => {
      const { adapter: local } = build();

      const message = local.parseMessage(
        messageContent({ type: "sticker", text: undefined, sticker: { url: "https://cdn/s" } }),
      );

      expect(message.attachments[0]).toMatchObject({ name: "sticker" });
      expect(message.attachments[0]?.mimeType).toBeUndefined();
    });

    it("downloads a sticker without an auth header", async () => {
      // The media host needs `x-user`; a sticker URL is served directly.
      const calls = vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([9]).buffer,
      }));
      const { adapter: local } = build(calls);

      const message = local.parseMessage(
        messageContent({ type: "sticker", text: undefined, sticker: { url: "https://cdn/s.png" } }),
      );
      const bytes = await message.attachments[0]?.fetchData?.();

      expect((bytes as Buffer).length).toBe(1);
      const [url, init] = calls.mock.calls[0] as [string, RequestInit | undefined];
      expect(url).toBe("https://cdn/s.png");
      expect(init?.headers).toBeUndefined();
    });
  });

  describe("listConversations", () => {
    it("requests the conversation list with sane defaults", async () => {
      const listFetch = vi.fn(async () =>
        okResponse({ conversations: [], has_more: false, cursor: 0 }),
      );
      const { adapter: local } = build(listFetch);

      await local.listConversations();

      const url = listFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("business/message/conversation/list/");
      expect(url).toContain("conversation_type=SINGLE");
      expect(url).toContain(`business_id=${BUSINESS_ID}`);
    });

    it("returns TikTok's paging fields untouched", async () => {
      const listFetch = vi.fn(async () =>
        okResponse({
          conversations: [{ conversation_id: "c1", update_time: 1000 }],
          has_more: true,
          cursor: 42,
        }),
      );
      const { adapter: local } = build(listFetch);

      await expect(local.listConversations()).resolves.toMatchObject({
        has_more: true,
        cursor: 42,
      });
    });
  });

  describe("listThreads", () => {
    function channelId(local: TikTokAdapter) {
      return local.channelIdFromThreadId(
        local.encodeThreadId({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        }),
      );
    }

    it("builds a summary per conversation, fetching each root message", async () => {
      // ThreadSummary requires a rootMessage the conversation list does not
      // return, so this necessarily costs one extra request per conversation.
      const listAndHistory = vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            conversations: [
              { conversation_id: "c1", update_time: 1000 },
              { conversation_id: "c2", update_time: 2000 },
            ],
            has_more: false,
            cursor: 0,
          }),
        )
        .mockResolvedValue(okResponse({ messages: [restMessage()], participants: [] }));
      const { adapter: local } = build(listAndHistory);

      const result = await local.listThreads(channelId(local));

      expect(result.threads).toHaveLength(2);
      expect(result.threads[0]?.rootMessage.text).toBe("from history");
      expect(result.threads[0]?.lastReplyAt?.getTime()).toBe(1000);
      expect(listAndHistory).toHaveBeenCalledTimes(3); // one list + two histories
      expect(result.nextCursor).toBeUndefined();
    });

    it("surfaces the cursor only when TikTok reports more pages", async () => {
      const listAndHistory = vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            conversations: [{ conversation_id: "c1", update_time: 1000 }],
            has_more: true,
            cursor: 7,
          }),
        )
        .mockResolvedValue(okResponse({ messages: [restMessage()], participants: [] }));
      const { adapter: local } = build(listAndHistory);

      await expect(local.listThreads(channelId(local))).resolves.toMatchObject({
        nextCursor: "7",
      });
    });

    it("skips a conversation it cannot read rather than failing the page", async () => {
      const listAndHistory = vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({
            conversations: [
              { conversation_id: "c1", update_time: 1000 },
              { conversation_id: "c2", update_time: 2000 },
            ],
            has_more: false,
            cursor: 0,
          }),
        )
        .mockResolvedValueOnce(errorResponse(TIKTOK_CODE.NO_PERMISSION))
        .mockResolvedValue(okResponse({ messages: [restMessage()], participants: [] }));
      const { adapter: local } = build(listAndHistory);

      const result = await local.listThreads(channelId(local));

      expect(result.threads).toHaveLength(1);
    });

    it("refuses a channel belonging to a different business account", async () => {
      const { adapter: local } = build();
      const foreign = local.channelIdFromThreadId(
        local.encodeThreadId({
          businessId: "someone_else",
          conversationId: CONVERSATION_ID,
        }),
      );

      await expect(local.listThreads(foreign)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("fetchChannelInfo", () => {
    it("returns the business account's profile", async () => {
      const profileFetch = vi.fn(async () =>
        okResponse({
          display_name: "Acme Co",
          username: "acmeco",
          profile_image: "https://example.com/a.png",
        }),
      );
      const { adapter: local } = build(profileFetch);
      const channelId = local.channelIdFromThreadId(
        local.encodeThreadId({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        }),
      );

      const info = await local.fetchChannelInfo(channelId);

      expect(info.name).toBe("Acme Co");
      expect(info.id).toBe(channelId);
      expect(info.metadata).toMatchObject({ username: "acmeco" });
      expect(profileFetch.mock.calls[0]?.[0]).toContain("business/get/");
    });

    it("falls back to the username when no display name is set", async () => {
      const { adapter: local } = build(vi.fn(async () => okResponse({ username: "acmeco" })));
      const channelId = local.channelIdFromThreadId(
        local.encodeThreadId({
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
        }),
      );

      await expect(local.fetchChannelInfo(channelId)).resolves.toMatchObject({
        name: "acmeco",
      });
    });

    it("rejects a malformed channel ID", async () => {
      const { adapter: local } = build();
      await expect(local.fetchChannelInfo("tiktok:not-canonical!")).rejects.toThrow(
        /Invalid TikTok channel ID/,
      );
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
