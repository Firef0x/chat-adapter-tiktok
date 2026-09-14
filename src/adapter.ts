import { extractCard, NetworkError, ValidationError } from "@chat-adapter/shared";
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
import { cardToTemplate } from "./lib/template.js";
import { TikTokTokenManager } from "./lib/token-manager.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./lib/webhook.js";
import type {
  TikTokAdapterConfig,
  TikTokMessageContent,
  TikTokMessageListData,
  TikTokRawMessage,
  TikTokRestMessage,
  TikTokSendMessageData,
  TikTokSendMessageRequest,
  TikTokThreadId,
  TikTokWebhookEnvelope,
} from "./types.js";

/** TikTok rejects text longer than this outright. */
const MAX_TEXT_LENGTH = 6000;

/** Credentials without which the adapter cannot do anything useful. */
const REQUIRED_CREDENTIALS = [
  "appId",
  "appSecret",
  "businessId",
  "accessToken",
  "refreshToken",
] as const;

/**
 * Convert a TikTok epoch-millisecond stamp to a Date.
 *
 * A missing or malformed value would otherwise produce an `Invalid Date`,
 * which throws no error and compares false against everything — silently
 * corrupting ordering downstream.
 */
function toDate(timestamp: number | undefined): Date {
  return Number.isFinite(timestamp) ? new Date(timestamp as number) : new Date();
}

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
  private readonly useTemplates: boolean;

  /** Message IDs already delivered to the host, to survive webhook retries. */
  private readonly seenMessages = new BoundedSet(1000);
  /** Message IDs this runtime sent, to recognize TikTok's echo of them. */
  private readonly sentMessages = new BoundedSet(1000);

  constructor(config: TikTokAdapterConfig & { fetchImpl?: typeof fetch }) {
    // The factory validates too, but the class is exported directly. An empty
    // appSecret is the dangerous case: `createHmac` accepts it happily, so
    // every webhook would verify against a key anyone could guess.
    for (const key of REQUIRED_CREDENTIALS) {
      if (!config[key]) {
        throw new ValidationError(ADAPTER_NAME, `TikTok ${key} is required.`);
      }
    }

    // Copied so a caller mutating their config object later cannot silently
    // change which account this adapter talks to or which secret it trusts.
    this.config = { ...config };
    this.userName = config.userName ?? "tiktok-bot";
    this.botUserId = config.businessId;
    this.logger = config.logger ?? new ConsoleLogger();
    this.useTemplates = config.useTemplates ?? true;

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
      // A getter, not the value: `initialize()` replaces this.logger with the
      // host's, and the token manager must follow that swap.
      logger: () => this.logger,
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

    const logId = request.headers.get("x-tt-logid") ?? undefined;

    try {
      await this.processEnvelope(rawBody, options);
    } catch (error) {
      // A malformed payload must not trigger TikTok's retry loop — replaying
      // it would fail identically every time. The log carries TikTok's own
      // request identifier, which their support needs to trace a delivery.
      this.logger.error("Failed to process TikTok webhook", { error, logId });
    }

    return new Response("OK", { status: 200 });
  }

  private async processEnvelope(
    rawBody: string,
    options?: WebhookOptions,
  ): Promise<void> {
    const envelope = JSON.parse(rawBody) as TikTokWebhookEnvelope;

    // Only these two carry a usable message. `im_receive_msg_eu` is
    // deliberately stripped by TikTok — no content, no conversation ID — so
    // there is nothing to deliver.
    if (envelope.event !== "im_receive_msg" && envelope.event !== "im_send_msg") {
      this.logger.debug("Ignoring TikTok event", { event: envelope.event });
      return;
    }

    // One app URL receives webhooks for every authorized account, so an
    // envelope for a different business must be refused rather than processed
    // with this connection's credentials.
    if (envelope.user_openid !== this.config.businessId) {
      this.logger.warn("Ignoring TikTok webhook for a different business", {
        event: envelope.event,
      });
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

    // Without this the message is accepted, silently dropped, and — because
    // it would already be recorded as seen — never recoverable on redelivery.
    if (!this.chat) {
      this.logger.error(
        "TikTok adapter received a webhook before initialize() was called; the message was dropped.",
        { messageId: content.message_id, event: envelope.event },
      );
      return;
    }

    // TikTok retries on any non-2xx, so the same message arrives repeatedly.
    if (this.seenMessages.has(content.message_id)) {
      this.logger.debug("Ignoring duplicate TikTok message", {
        messageId: content.message_id,
      });
      return;
    }

    const threadId = this.encodeThreadId({
      businessId: this.config.businessId,
      conversationId: content.conversation_id,
    });

    // Recorded only once dispatch is actually under way, so a message that
    // never reached the host is not remembered as delivered.
    this.seenMessages.add(content.message_id);

    await this.chat.processMessage(
      this,
      threadId,
      async () => this.parseMessage(content),
      options,
    );
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Decide whether a message is this runtime's own reply coming back.
   *
   * `im_send_msg` fires for every message the business account sends,
   * including echoes of this adapter's own API calls. Marking those `isMe` is
   * what stops the bot from answering itself.
   *
   * Membership of `sentMessages` alone is not enough: the echo can arrive
   * before the send response that supplies the ID, so the set may not be
   * populated yet. TikTok stamps each message with the surface it came from,
   * so a business-account message tagged `API` is one this integration sent,
   * while `APP` or `WEB` is a human colleague typing in TikTok itself — who
   * should reach the bot as an ordinary message.
   */
  private isOwnEcho(content: TikTokMessageContent): boolean {
    if (this.sentMessages.has(content.message_id)) {
      return true;
    }

    const isFromBusiness = content.from_user?.id === this.config.businessId;
    return isFromBusiness && content.message_tag?.source === "API";
  }

  parseMessage(raw: TikTokRawMessage): Message<TikTokRawMessage> {
    const content = raw as TikTokMessageContent;
    const text = this.extractText(content);

    const isOwnEcho = this.isOwnEcho(content);

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
        dateSent: toDate(content.timestamp),
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
        return content.text?.body || "[empty message]";
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
        return this.templateToText(content) || "[template]";
      case "reaction":
        return "[reaction]";
      default:
        // A type TikTok added after this release. Returning "" would present
        // it to the bot as an empty user turn, and nobody would ever learn the
        // new type exists.
        this.logger.warn("Unrecognized TikTok message type", {
          type: content.type,
          messageId: content.message_id,
        });
        return "[unsupported message]";
    }
  }

  /**
   * Render an inbound template as its title followed by its reply options.
   *
   * The buttons are the substance of a template message — dropping them would
   * leave a bot reading "Pick one:" with nothing to pick from.
   */
  private templateToText(content: TikTokMessageContent): string {
    const lines: string[] = [];

    for (const element of content.template?.elements ?? []) {
      if (element.title) {
        lines.push(element.title);
      }
      for (const button of element.buttons ?? []) {
        if (button.text) {
          lines.push(`• ${button.text}`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Choose how to represent an outbound message.
   *
   * A card with one to three plain buttons and a short question becomes a Q&A
   * button card, which TikTok renders as real tappable buttons. Anything else
   * becomes plain text, which can carry any content — so the fallback loses
   * interactivity, never information.
   */
  private buildSendBody(
    conversationId: string,
    message: AdapterPostableMessage,
  ): TikTokSendMessageRequest {
    const base = {
      business_id: this.config.businessId,
      recipient_type: "CONVERSATION" as const,
      recipient: conversationId,
    };

    if (this.useTemplates) {
      const card = extractCard(message);
      const template = card ? cardToTemplate(card) : null;
      if (template) {
        return { ...base, message_type: "TEMPLATE", template };
      }
    }

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

    return { ...base, message_type: "TEXT", text: { body: text } };
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<TikTokRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const body = this.buildSendBody(conversationId, message);

    const data = await this.api.request<TikTokSendMessageData>({
      method: "POST",
      path: "business/message/send/",
      body,
    });

    const messageId = data.message?.message_id;
    if (!messageId) {
      // An empty ID is legitimate for SENDER_ACTION, which never reaches here.
      // For a real send it means TikTok reported success with a malformed
      // body: delivery is unconfirmed, and without the ID the echo of this
      // message cannot be suppressed — so the bot would answer itself.
      throw new NetworkError(
        ADAPTER_NAME,
        "TikTok accepted the send but returned no message_id, so delivery is unconfirmed.",
      );
    }

    // Remember it so the `im_send_msg` echo is recognized as our own.
    this.sentMessages.add(messageId);

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

    const messages: Array<Message<TikTokRawMessage>> = [];
    for (const rest of data.messages ?? []) {
      const parsed = this.parseRestMessage(rest, conversationId);
      if (parsed) {
        messages.push(parsed);
      }
    }

    // TikTok does not document the ordering of this endpoint, so it is sorted
    // rather than assumed: `limit` must trim the oldest, not an arbitrary end.
    messages.sort(
      (a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime(),
    );

    // `limit: 0` means none. Testing truthiness would return everything, the
    // opposite of what the caller asked for.
    const limit = options?.limit;
    const limited =
      limit !== undefined && limit >= 0 && limit < messages.length
        ? messages.slice(messages.length - limit)
        : messages;

    return { messages: limited, nextCursor: undefined };
  }

  /**
   * Convert a message from the REST history endpoint.
   *
   * The REST and webhook representations are different shapes with different
   * casing, so this cannot reuse {@link parseMessage}. Two fields the webhook
   * supplies are simply absent here: the conversation ID, which the caller
   * already knows and passes in, and the sender's identity, which this
   * endpoint's response shape does not confirm — so the author is reported as
   * unknown rather than guessed at.
   *
   * Returns `null` for a message that cannot be identified, which is skipped
   * rather than surfaced as a broken entry.
   */
  private parseRestMessage(
    rest: TikTokRestMessage,
    conversationId: string,
  ): Message<TikTokRawMessage> | null {
    if (!rest.message_id) {
      this.logger.warn("Skipping TikTok history entry with no message_id");
      return null;
    }

    const text = this.extractRestText(rest);

    return new Message<TikTokRawMessage>({
      id: rest.message_id,
      threadId: this.encodeThreadId({
        businessId: this.config.businessId,
        conversationId,
      }),
      text,
      formatted: this.converter.toAst(text),
      raw: rest,
      author: {
        userId: "",
        userName: "",
        fullName: "",
        isBot: "unknown",
        isMe: false,
      },
      metadata: { dateSent: toDate(rest.timestamp), edited: false },
      attachments: [],
    });
  }

  /** The REST vocabulary is UPPERCASE, unlike the webhook's. */
  private extractRestText(rest: TikTokRestMessage): string {
    switch (rest.message_type) {
      case "TEXT":
        return rest.text?.body || "[empty message]";
      case "IMAGE":
        return "[image]";
      case "VIDEO":
        return "[video]";
      case "STICKER":
        return "[sticker]";
      case "EMOJI":
        return "[emoji]";
      case "SHARE_POST":
        return rest.share_post?.embed_url
          ? `[shared post] ${rest.share_post.embed_url}`
          : "[shared post]";
      case "TEMPLATE":
        return "[template]";
      default:
        return "[unsupported message]";
    }
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
