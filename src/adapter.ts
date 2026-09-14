import { ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";

import { TikTokApiClient } from "./lib/api-client.js";
import { BoundedSet } from "./lib/bounded-set.js";
import { TikTokFormatConverter } from "./lib/format-converter.js";
import {
  ADAPTER_NAME,
  channelIdFromThreadId,
  decodeThreadId,
  encodeThreadId,
} from "./lib/thread-id.js";
import { TikTokTokenManager } from "./lib/token-manager.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./lib/webhook.js";
import type {
  TikTokAdapterConfig,
  TikTokMessageContent,
  TikTokMessageListData,
  TikTokRawMessage,
  TikTokSendMessageData,
  TikTokSendMessageRequest,
  TikTokThreadId,
  TikTokWebhookEnvelope,
} from "./types.js";

/** TikTok rejects text longer than this outright. */
const MAX_TEXT_LENGTH = 6000;

/**
 * Chat SDK adapter for the TikTok Business Messaging API.
 *
 * Inbound messages arrive as webhooks; outbound replies go through the send
 * endpoint. Everything TikTok cannot do — reactions, edits, deletes — throws
 * rather than failing quietly.
 */
export class TikTokAdapter implements Adapter<TikTokThreadId, TikTokRawMessage> {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  readonly botUserId: string;

  /**
   * TikTok serves only the 20 most recent messages and offers no pagination,
   * so the SDK keeps its own history for this platform.
   */
  readonly persistThreadHistory = true;

  private chat: ChatInstance | null = null;
  private logger: Logger;

  private readonly config: TikTokAdapterConfig;
  private readonly tokens: TikTokTokenManager;
  private readonly api: TikTokApiClient;
  private readonly converter = new TikTokFormatConverter();

  /** Message IDs already delivered to the host, to survive webhook retries. */
  private readonly seenMessages = new BoundedSet(1000);
  /** Message IDs this runtime sent, to recognize TikTok's echo of them. */
  private readonly sentMessages = new BoundedSet(1000);

  constructor(config: TikTokAdapterConfig & { fetchImpl?: typeof fetch }) {
    this.config = config;
    this.userName = config.userName ?? "tiktok-bot";
    this.botUserId = config.businessId;
    this.logger = config.logger ?? new ConsoleLogger();

    this.tokens = new TikTokTokenManager({
      appId: config.appId,
      appSecret: config.appSecret,
      businessId: config.businessId,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      accessTokenExpiresAt: config.accessTokenExpiresAt,
      refreshTokenExpiresAt: config.refreshTokenExpiresAt,
      onTokenRefresh: config.onTokenRefresh,
      baseUrl: config.baseUrl,
      apiVersion: config.apiVersion,
      fetchImpl: config.fetchImpl,
      logger: this.logger,
    });

    this.api = new TikTokApiClient({
      tokens: this.tokens,
      baseUrl: config.baseUrl,
      apiVersion: config.apiVersion,
      fetchImpl: config.fetchImpl,
    });
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(ADAPTER_NAME);
  }

  // -------------------------------------------------------------------------
  // Thread IDs
  // -------------------------------------------------------------------------

  encodeThreadId(data: TikTokThreadId): string {
    return encodeThreadId(data);
  }

  decodeThreadId(threadId: string): TikTokThreadId {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
  }

  /** Every TikTok conversation is one-to-one. */
  isDM(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    // Read the raw bytes first: the HMAC covers exactly what was sent, and a
    // parsed-then-re-serialized body will not reproduce it.
    const rawBody = await request.text();

    const verification = verifyWebhookSignature({
      header: request.headers.get(SIGNATURE_HEADER),
      rawBody,
      appSecret: this.config.appSecret,
      toleranceSeconds: this.config.signatureToleranceSeconds,
    });

    if (!verification.valid) {
      this.logger.warn("Rejected TikTok webhook", {
        reason: verification.reason,
        logId: request.headers.get("x-tt-logid") ?? undefined,
      });
      return new Response("Invalid signature", { status: 401 });
    }

    try {
      this.processEnvelope(rawBody, options);
    } catch (error) {
      // A malformed payload must not trigger TikTok's retry loop — replaying
      // it would fail identically every time.
      this.logger.error("Failed to process TikTok webhook", { error });
    }

    return new Response("OK", { status: 200 });
  }

  private processEnvelope(rawBody: string, options?: WebhookOptions): void {
    const envelope = JSON.parse(rawBody) as TikTokWebhookEnvelope;

    // Only these two carry a usable message. `im_receive_msg_eu` is
    // deliberately stripped by TikTok — no content, no conversation ID — so
    // there is nothing to deliver.
    if (envelope.event !== "im_receive_msg" && envelope.event !== "im_send_msg") {
      this.logger.debug("Ignoring TikTok event", { event: envelope.event });
      return;
    }

    // `content` is a JSON-encoded string, not an object.
    const content = JSON.parse(envelope.content) as TikTokMessageContent;

    if (!content.message_id || !content.conversation_id) {
      this.logger.debug("Ignoring TikTok event without a message", {
        event: envelope.event,
      });
      return;
    }

    // TikTok retries on any non-2xx, so the same message arrives repeatedly.
    if (!this.seenMessages.add(content.message_id)) {
      this.logger.debug("Ignoring duplicate TikTok message", {
        messageId: content.message_id,
      });
      return;
    }

    const threadId = this.encodeThreadId({
      businessId: envelope.user_openid,
      conversationId: content.conversation_id,
    });

    this.chat?.processMessage(
      this,
      threadId,
      async () => this.parseMessage(content),
      options,
    );
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  parseMessage(raw: TikTokRawMessage): Message<TikTokRawMessage> {
    const content = raw as TikTokMessageContent;
    const text = this.extractText(content);

    // `im_send_msg` fires for the business account's own messages, including
    // echoes of what this adapter just sent. Marking those `isMe` is what
    // stops the bot from answering itself; a message the business sent from
    // the TikTok app is a human colleague, not this runtime.
    const isOwnEcho = this.sentMessages.has(content.message_id);
    const isFromBusiness = content.from_user?.id === this.config.businessId;

    return new Message<TikTokRawMessage>({
      id: content.message_id,
      threadId: this.encodeThreadId({
        businessId: this.config.businessId,
        conversationId: content.conversation_id,
      }),
      text,
      formatted: this.converter.toAst(text),
      raw,
      author: {
        userId: content.from_user?.id ?? content.unique_identifier ?? "",
        userName: content.from ?? "",
        fullName: content.from ?? "",
        isBot: isOwnEcho,
        isMe: isOwnEcho,
      },
      metadata: {
        dateSent: new Date(content.timestamp),
        edited: false,
      },
      attachments: [],
    });
  }

  /**
   * Reduce any inbound message type to text.
   *
   * Media arrives as an ID that needs a separate authenticated download, which
   * this release does not implement. Rather than presenting those messages as
   * empty — which reads as "the user sent nothing" — each becomes a visible
   * placeholder naming what arrived.
   */
  private extractText(content: TikTokMessageContent): string {
    switch (content.type) {
      case "text":
        return content.text?.body ?? "";
      case "image":
        return "[image]";
      case "video":
        return "[video]";
      case "sticker":
        return "[sticker]";
      case "emoji":
        return "[emoji]";
      case "share_post":
        return content.share_post?.embed_url
          ? `[shared post] ${content.share_post.embed_url}`
          : "[shared post]";
      case "template":
        return content.template?.elements?.[0]?.title ?? "[template]";
      case "reaction":
        return "[reaction]";
      default:
        return "";
    }
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<TikTokRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message);

    if (!text) {
      throw new ValidationError(
        ADAPTER_NAME,
        "Cannot send an empty message to TikTok.",
      );
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Message text is ${text.length} characters; TikTok allows at most ${MAX_TEXT_LENGTH}.`,
      );
    }

    const body: TikTokSendMessageRequest = {
      business_id: this.config.businessId,
      recipient_type: "CONVERSATION",
      recipient: conversationId,
      message_type: "TEXT",
      text: { body: text },
    };

    const data = await this.api.request<TikTokSendMessageData>({
      method: "POST",
      path: "business/message/send/",
      body,
    });

    const messageId = data.message?.message_id ?? "";
    if (messageId) {
      // Remember it so the `im_send_msg` echo is recognized as our own.
      this.sentMessages.add(messageId);
    }

    return { id: messageId, raw: data, threadId };
  }

  // -------------------------------------------------------------------------
  // Sender actions
  // -------------------------------------------------------------------------

  async startTyping(threadId: string): Promise<void> {
    await this.sendSenderAction(threadId, "TYPING");
  }

  async markAsRead(threadId: string): Promise<void> {
    await this.sendSenderAction(threadId, "MARK_READ");
  }

  private async sendSenderAction(
    threadId: string,
    action: "TYPING" | "MARK_READ",
  ): Promise<void> {
    const { conversationId } = this.decodeThreadId(threadId);
    await this.api.request<TikTokSendMessageData>({
      method: "POST",
      path: "business/message/send/",
      body: {
        business_id: this.config.businessId,
        recipient_type: "CONVERSATION",
        recipient: conversationId,
        message_type: "SENDER_ACTION",
        sender_action: action,
      } satisfies TikTokSendMessageRequest,
    });
  }

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  /**
   * Fetch recent messages.
   *
   * TikTok returns the 20 most recent and offers no cursor, so `limit` can
   * only narrow that set and `nextCursor` is always absent.
   */
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<TikTokRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);

    const data = await this.api.request<TikTokMessageListData>({
      method: "GET",
      path: "business/message/content/list/",
      query: {
        business_id: this.config.businessId,
        conversation_id: conversationId,
      },
    });

    const messages = (data.messages ?? []).map((raw) =>
      this.parseMessage(raw as unknown as TikTokRawMessage),
    );

    const limited =
      options?.limit && options.limit < messages.length
        ? messages.slice(-options.limit)
        : messages;

    return { messages: limited, nextCursor: undefined };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: true,
      metadata: {},
    };
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  // -------------------------------------------------------------------------
  // Unsupported by the platform
  //
  // Chat SDK requires these methods, but TikTok's messaging API has no
  // equivalent. They throw so a caller finds out immediately, instead of
  // believing an edit or reaction was recorded.
  // -------------------------------------------------------------------------

  addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    return Promise.reject(
      new NotImplementedError("TikTok does not support reactions", ADAPTER_NAME),
    );
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    return Promise.reject(
      new NotImplementedError("TikTok does not support reactions", ADAPTER_NAME),
    );
  }

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<TikTokRawMessage>> {
    return Promise.reject(
      new NotImplementedError("TikTok does not support editing messages", ADAPTER_NAME),
    );
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    return Promise.reject(
      new NotImplementedError("TikTok does not support deleting messages", ADAPTER_NAME),
    );
  }
}
