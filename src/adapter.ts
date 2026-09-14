import crypto from "node:crypto";

import { extractCard, extractFiles, NetworkError, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Author,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  Attachment,
  ChannelInfo,
  FileUpload,
  FormattedContent,
  ListThreadsOptions,
  ListThreadsResult,
  Logger,
  RawMessage,
  ThreadInfo,
  ThreadSummary,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, emoji, Message, NotImplementedError } from "chat";

import { TikTokApiClient } from "./lib/api-client.js";
import { BoundedSet } from "./lib/bounded-set.js";
import { TikTokFormatConverter } from "./lib/format-converter.js";
import {
  ADAPTER_NAME,
  channelIdFromThreadId,
  decodeChannelId,
  decodeThreadId,
  encodeThreadId,
} from "./lib/thread-id.js";
import {
  canSendImage,
  fetchMediaBytes,
  fetchUrlBytes,
  getMediaDownloadUrl,
  toImageBuffer,
  uploadImage,
} from "./lib/media.js";
import { cardToTemplate } from "./lib/template.js";
import { TikTokTokenManager } from "./lib/token-manager.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./lib/webhook.js";
import type {
  TikTokAdapterConfig,
  TikTokBusinessProfile,
  TikTokConversationListData,
  TikTokConversationType,
  TikTokMessageContent,
  TikTokMessageListData,
  TikTokRawMessage,
  TikTokReferralContent,
  TikTokRestMessage,
  TikTokSendMessageData,
  TikTokSendMessageRequest,
  TikTokThreadId,
  TikTokWebhookEnvelope,
} from "./types.js";

/** TikTok rejects text longer than this outright. */
const MAX_TEXT_LENGTH = 6000;

/**
 * Conversations listed per page by default.
 *
 * Kept small because `listThreads` issues one extra request per conversation,
 * and TikTok's rate limit is per app rather than per account.
 */
const DEFAULT_THREAD_PAGE_SIZE = 20;

/** Credentials without which the adapter cannot do anything useful. */
const REQUIRED_CREDENTIALS = [
  "appId",
  "appSecret",
  "businessId",
  "accessToken",
  "refreshToken",
] as const;

/**
 * The file extension of a URL's path, lowercased, or `null`.
 *
 * Query strings carry expiry parameters on TikTok's sticker URLs, so the path
 * has to be isolated before looking for a suffix.
 */
function extensionFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,4})$/i.exec(path);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

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
  private readonly fetchImpl: typeof fetch;

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
    this.fetchImpl = config.fetchImpl ?? fetch;

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
      maxRateLimitRetries: config.maxRateLimitRetries,
      rateLimitRetryDelayMs: config.rateLimitRetryDelayMs,
      sleepImpl: config.sleepImpl,
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

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    // Read the raw bytes first: the HMAC covers exactly what was sent, and a
    // parsed-then-re-serialized body will not reproduce it.
    const rawBody = await request.text();
    const logId = request.headers.get("x-tt-logid") ?? undefined;

    const verification = verifyWebhookSignature({
      header: request.headers.get(SIGNATURE_HEADER),
      rawBody,
      appSecret: this.config.appSecret,
      toleranceSeconds: this.config.signatureToleranceSeconds,
    });

    if (!verification.valid) {
      this.logger.warn("Rejected TikTok webhook", { reason: verification.reason, logId });
      return new Response("Invalid signature", { status: 401 });
    }

    return this.handleVerifiedWebhook(rawBody, options, logId);
  }

  /**
   * Handle a delivery whose signature has already been verified.
   *
   * Used by {@link TikTokWebhookRouter}, which verifies once for the whole
   * app. Re-verifying here would look like prudence and is in fact a bug: the
   * signature carries a timestamp checked against a five-second tolerance, and
   * the router may have spent that budget loading a tenant. The second check
   * would then reject a delivery the first accepted, and since that answer is
   * not 2xx, TikTok would retry it forever.
   *
   * The caller is responsible for having verified against the same app secret.
   * That is why this is not exported from the package: reaching it requires
   * holding an adapter instance and ignoring this warning.
   *
   * @internal
   */
  async handleVerifiedWebhook(
    rawBody: string,
    options?: WebhookOptions,
    logId?: string,
  ): Promise<Response> {
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

  /**
   * Whether this adapter is configured for the given app secret.
   *
   * Lets a router refuse an adapter belonging to a different TikTok app at
   * registration, rather than letting every one of its deliveries fail. The
   * comparison is constant-time so it cannot be used to probe the secret.
   */
  usesAppSecret(appSecret: string): boolean {
    const mine = Buffer.from(this.config.appSecret, "utf8");
    const theirs = Buffer.from(appSecret, "utf8");
    return mine.length === theirs.length && crypto.timingSafeEqual(mine, theirs);
  }

  private async processEnvelope(rawBody: string, options?: WebhookOptions): Promise<void> {
    const envelope = JSON.parse(rawBody) as TikTokWebhookEnvelope;

    // One app URL receives webhooks for every authorized account, so an
    // envelope for a different business must be refused rather than processed
    // with this connection's credentials.
    if (envelope.user_openid !== this.config.businessId) {
      this.logger.warn("Ignoring TikTok webhook for a different business", {
        event: envelope.event,
      });
      return;
    }

    // A referral announces an arrival rather than a message: no message_id,
    // no type, so it cannot travel the message path at all.
    if (envelope.event === "im_referral_msg") {
      await this.dispatchReferral(envelope);
      return;
    }

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

    if (content.type === "reaction") {
      this.dispatchReactions(this.chat, content, threadId, options);
      return;
    }

    await this.chat.processMessage(this, threadId, async () => this.parseMessage(content), options);
  }

  /**
   * Report how a user arrived, when they came from an ad or a tiktok.me link.
   *
   * Chat SDK has no event for attribution, and the payload carries no message,
   * so this goes to the host's `onReferral` callback instead. A host that has
   * not asked for it gets a debug line rather than silence, since the arrival
   * is otherwise invisible until the user speaks.
   */
  private async dispatchReferral(envelope: TikTokWebhookEnvelope): Promise<void> {
    const content = JSON.parse(envelope.content) as TikTokReferralContent;

    if (!content.conversation_id || !content.referral) {
      // The type declares both as present. Guarding rather than reaching
      // through with `?.` keeps the declaration honest: a payload missing
      // either is not a referral this can describe.
      this.logger.debug("Ignoring an incomplete TikTok referral");
      return;
    }

    if (!this.config.onReferral) {
      this.logger.debug("A TikTok referral arrived but no onReferral is configured", {
        source: content.referral.source,
      });
      return;
    }

    try {
      await this.config.onReferral({
        threadId: this.encodeThreadId({
          businessId: this.config.businessId,
          conversationId: content.conversation_id,
        }),
        businessId: this.config.businessId,
        conversationId: content.conversation_id,
        referral: content.referral,
        raw: content,
      });
    } catch (error) {
      // The host's own failure must not turn into a retried webhook, which
      // would replay the same referral and fail the same way.
      this.logger.error("The onReferral handler failed", { error });
    }
  }

  /**
   * Deliver a reaction payload as reaction events.
   *
   * A reaction is not a message: routing it through `processMessage` would put
   * a bare "[reaction]" into the conversation and discard which emoji was
   * used, whether it was added or removed, and which message it applied to.
   *
   * One payload can carry several entries, and each is dispatched separately
   * so a host sees one event per reaction.
   */
  private dispatchReactions(
    chat: ChatInstance,
    content: TikTokMessageContent,
    threadId: string,
    options?: WebhookOptions,
  ): void {
    const entries = content.reaction ?? [];
    if (entries.length === 0) {
      // The payload said "reaction" and carried none, so the parsing
      // assumption is wrong — and the ID is already recorded as seen, so a
      // redelivery will not surface it either.
      this.logger.warn("A TikTok reaction payload carried no reactions", {
        messageId: content.message_id,
      });
      return;
    }

    const author = this.authorOf(content);

    for (const entry of entries) {
      // AI emoji are images rather than characters, so the URL is the only
      // identity available for them.
      const rawEmoji = entry.emoji ?? entry.ai_emoji_url;
      if (!rawEmoji || !entry.original_msg_id) {
        this.logger.debug("Ignoring an unusable TikTok reaction entry", {
          messageId: content.message_id,
        });
        continue;
      }

      chat.processReaction(
        {
          // Optional in the SDK's type but required at runtime: without it
          // the event is dropped before any handler runs.
          adapter: this,
          added: entry.operation === "ADD",
          // TikTok sends the character itself and the SDK exposes no reverse
          // lookup from a character to a well-known name, so the character
          // becomes the name. Compare against `rawEmoji`, not identity.
          emoji: emoji.custom(rawEmoji),
          rawEmoji,
          messageId: entry.original_msg_id,
          threadId,
          // Each entry names its own reactor, so a batched payload must not
          // attribute every reaction to whoever the payload header names. The
          // SDK drops events whose user is the bot itself, so getting this
          // wrong can silence a genuine reaction.
          user: { ...author, userId: entry.unique_identifier || author.userId },
          raw: entry,
        },
        options,
      );
    }
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

  /** The sender of an inbound payload, shared by messages and reactions. */
  private authorOf(content: TikTokMessageContent): Author {
    const isOwnEcho = this.isOwnEcho(content);
    return {
      userId: content.from_user?.id ?? content.unique_identifier ?? "",
      userName: content.from ?? "",
      fullName: content.from ?? "",
      isBot: isOwnEcho,
      isMe: isOwnEcho,
    };
  }

  parseMessage(raw: TikTokRawMessage): Message<TikTokRawMessage> {
    const content = raw as TikTokMessageContent;
    const text = this.extractText(content);

    return new Message<TikTokRawMessage>({
      id: content.message_id,
      threadId: this.encodeThreadId({
        businessId: this.config.businessId,
        conversationId: content.conversation_id,
      }),
      text,
      formatted: this.converter.toAst(text),
      raw,
      author: this.authorOf(content),
      metadata: {
        dateSent: toDate(content.timestamp),
        edited: false,
      },
      attachments: this.inboundAttachments(content),
    });
  }

  /**
   * Describe inbound media as attachments the host can download on demand.
   *
   * The bytes are not fetched during parsing: most messages are never asked
   * for their media, the download URL has to be requested separately, and it
   * expires after 24 hours — so resolving it eagerly would waste two requests
   * per message and could hand out a stale URL. `fetchData` defers all of that
   * to the first caller that actually wants the file.
   */
  private inboundAttachments(content: TikTokMessageContent): Attachment[] {
    // Stickers and emoji arrive as plain URLs rather than media IDs, so they
    // need no download-URL request and no auth header. A sticker URL is good
    // for 30 days; an emoji URL does not expire.
    const directUrl = content.sticker?.url ?? content.emoji?.url;
    if (directUrl) {
      const extension = extensionFromUrl(directUrl);

      return [
        {
          type: "image",
          // A bare "sticker" gives a consumer nothing to infer a type from.
          name: extension ? `${content.type}.${extension}` : content.type,
          mimeType: extension ? `image/${extension === "jpg" ? "jpeg" : extension}` : undefined,
          url: directUrl,
          fetchData: async () => fetchUrlBytes(directUrl, this.fetchImpl),
        },
      ];
    }

    const mediaId = content.image?.media_id ?? content.video?.media_id;
    if (!mediaId) {
      return [];
    }

    const isImage = content.type === "image";
    const mediaType = isImage ? "IMAGE" : "VIDEO";

    return [
      {
        type: isImage ? "image" : "video",
        name: `${mediaType.toLowerCase()}-${mediaId}`,
        fetchData: async () => {
          const url = await getMediaDownloadUrl(this.api, {
            businessId: this.config.businessId,
            conversationId: content.conversation_id,
            messageId: content.message_id,
            mediaId,
            mediaType,
          });
          return fetchMediaBytes(url, await this.tokens.getAccessToken(), this.fetchImpl);
        },
      },
    ];
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
        // The webhook path dispatches reactions as events and never reaches
        // here; this remains only for a host calling parseMessage directly.
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

    return { ...base, message_type: "TEXT", text: { body: this.renderSendableText(message) } };
  }

  /**
   * Flatten a postable to text TikTok will accept.
   *
   * Shared by the plain and quoted-reply paths so both reject the same things
   * before spending a request.
   */
  private renderSendableText(message: AdapterPostableMessage): string {
    const text = this.converter.renderPostable(message);

    if (!text) {
      throw new ValidationError(ADAPTER_NAME, "Cannot send an empty message to TikTok.");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(
        ADAPTER_NAME,
        `Message text is ${text.length} characters; TikTok allows at most ${MAX_TEXT_LENGTH}.`,
      );
    }

    return text;
  }

  /**
   * Build an image send, or `null` when the message carries no image.
   *
   * TikTok forbids text and an image in one message, and allows one image per
   * message. Rather than quietly splitting the content into several sends —
   * which would consume several slots of a messaging window capped as low as
   * ten — the combination is rejected so the caller decides.
   */
  private async buildImageSendBody(
    conversationId: string,
    message: AdapterPostableMessage,
  ): Promise<TikTokSendMessageRequest | null> {
    const files = extractFiles(message);
    if (files.length === 0) {
      return null;
    }

    if (files.length > 1) {
      throw new ValidationError(
        ADAPTER_NAME,
        `TikTok accepts one image per message; got ${files.length}. Send them as separate messages.`,
      );
    }

    if (this.converter.renderPostable(message).trim()) {
      throw new ValidationError(
        ADAPTER_NAME,
        "TikTok cannot combine text and an image in one message. Send them separately.",
      );
    }

    const file = files[0] as FileUpload;
    const data = await toImageBuffer(file.data);
    if (!data) {
      throw new ValidationError(ADAPTER_NAME, `Could not read the attachment "${file.filename}".`);
    }

    // Region-gated on both sides of the conversation, so it is checked per
    // conversation. Skipping the check turns an unsupported region into an
    // opaque parameter error.
    if (!(await canSendImage(this.api, this.config.businessId, conversationId))) {
      throw new ValidationError(
        ADAPTER_NAME,
        "This conversation cannot receive images. TikTok gates image support by the regions of both participants.",
      );
    }

    const mediaId = await uploadImage(this.api, {
      businessId: this.config.businessId,
      data,
      filename: file.filename,
      mimeType: file.mimeType,
    });

    return {
      business_id: this.config.businessId,
      recipient_type: "CONVERSATION",
      recipient: conversationId,
      message_type: "IMAGE",
      image: { media_id: mediaId },
    };
  }

  /**
   * Reply to a specific message, quoting it.
   *
   * TikTok supports this only for text: `referenced_message_info` requires
   * `message_type: "TEXT"`, so a card is flattened to text rather than sent as
   * a template, and an image cannot be a quoted reply at all.
   *
   * The referenced message must itself be a text, image, or shared post —
   * quoting a template or a reaction is rejected by the platform, not here,
   * since only TikTok knows what the referenced message was.
   */
  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<TikTokRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);

    if (extractFiles(message).length > 0) {
      throw new ValidationError(
        ADAPTER_NAME,
        "TikTok supports text-only quoted replies. Send the image as its own message.",
      );
    }

    const text = this.renderSendableText(message);

    return this.send(threadId, {
      business_id: this.config.businessId,
      recipient_type: "CONVERSATION",
      recipient: conversationId,
      message_type: "TEXT",
      text: { body: text },
      referenced_message_info: { referenced_message_id: messageId },
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<TikTokRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);
    const body =
      (await this.buildImageSendBody(conversationId, message)) ??
      this.buildSendBody(conversationId, message);

    return this.send(threadId, body);
  }

  /**
   * Share one of the business account's own posts into a conversation.
   *
   * TikTok allows sharing only posts the account itself published, and takes
   * the post's `item_id` rather than a URL. There is no Chat SDK concept this
   * maps onto, so it is exposed as its own method rather than squeezed into a
   * postable.
   *
   * A shared post is its own message type, so it cannot carry a caption —
   * send text separately if you need one.
   */
  async sharePost(threadId: string, itemId: string): Promise<RawMessage<TikTokRawMessage>> {
    const { conversationId } = this.decodeThreadId(threadId);

    if (!itemId.trim()) {
      throw new ValidationError(ADAPTER_NAME, "A post ID is required to share a post.");
    }

    return this.send(threadId, {
      business_id: this.config.businessId,
      recipient_type: "CONVERSATION",
      recipient: conversationId,
      message_type: "SHARE_POST",
      share_post: { item_id: itemId },
    });
  }

  /**
   * Perform a send and record the resulting message ID.
   *
   * Shared by every outbound path so the echo-suppression bookkeeping cannot
   * be forgotten by one of them.
   */
  private async send(
    threadId: string,
    body: TikTokSendMessageRequest,
  ): Promise<RawMessage<TikTokRawMessage>> {
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

  private async sendSenderAction(threadId: string, action: "TYPING" | "MARK_READ"): Promise<void> {
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
    messages.sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());

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

  /**
   * List the account's conversations.
   *
   * This is the cheap listing: one call per page, returning identifiers and
   * update times without message content. Prefer it over {@link listThreads}
   * when the conversation IDs are all you need, since `listThreads` must fetch
   * each conversation's messages to satisfy the Chat SDK contract.
   *
   * TikTok covers only the last 90 days and caps a page at 100.
   */
  async listConversations(options?: {
    cursor?: number;
    limit?: number;
    conversationType?: TikTokConversationType;
  }): Promise<TikTokConversationListData> {
    return this.api.request<TikTokConversationListData>({
      method: "GET",
      path: "business/message/conversation/list/",
      query: {
        business_id: this.config.businessId,
        conversation_type: options?.conversationType ?? "SINGLE",
        cursor: options?.cursor,
        limit: options?.limit,
      },
    });
  }

  /**
   * List conversations as Chat SDK thread summaries.
   *
   * `ThreadSummary` requires a `rootMessage`, which TikTok's conversation list
   * does not return — so this costs **one additional request per
   * conversation**. The default limit is deliberately small because of that,
   * and because TikTok's rate limit is per app rather than per account. Use
   * {@link listConversations} when the identifiers alone would do.
   *
   * A conversation whose messages cannot be read is skipped rather than
   * failing the page: one inaccessible thread should not hide the rest.
   */
  async listThreads(
    channelId: string,
    options?: ListThreadsOptions,
  ): Promise<ListThreadsResult<TikTokRawMessage>> {
    const businessId = decodeChannelId(channelId);
    if (businessId !== this.config.businessId) {
      throw new ValidationError(
        ADAPTER_NAME,
        `This adapter is connected to a different business account than ${channelId}.`,
      );
    }

    const limit = options?.limit ?? DEFAULT_THREAD_PAGE_SIZE;
    const page = await this.listConversations({
      cursor: options?.cursor ? Number(options.cursor) : undefined,
      limit,
    });

    const threads: Array<ThreadSummary<TikTokRawMessage>> = [];

    for (const conversation of page.conversations ?? []) {
      const threadId = this.encodeThreadId({
        businessId: this.config.businessId,
        conversationId: conversation.conversation_id,
      });

      let rootMessage: Message<TikTokRawMessage> | undefined;
      try {
        // Sequential on purpose. Promise.all would fire one request per
        // conversation at once, and TikTok rate-limits per app — so the
        // parallel version would trip 40100 on exactly the pages large enough
        // to be worth listing.
        // oxlint-disable-next-line no-await-in-loop
        const { messages } = await this.fetchMessages(threadId, { limit: 1 });
        rootMessage = messages[0];
      } catch (error) {
        this.logger.warn("Could not read a TikTok conversation while listing", {
          error,
        });
        continue;
      }

      if (rootMessage) {
        threads.push({
          id: threadId,
          rootMessage,
          lastReplyAt: toDate(conversation.update_time),
        });
      }
    }

    return {
      threads,
      nextCursor: page.has_more ? String(page.cursor) : undefined,
    };
  }

  /**
   * Fetch the business account's profile.
   *
   * The channel is the business account itself — TikTok direct messages have
   * no other grouping — so this returns the account's own name and avatar.
   */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const businessId = decodeChannelId(channelId);

    const profile = await this.api.request<TikTokBusinessProfile>({
      method: "GET",
      path: "business/get/",
      query: {
        business_id: businessId,
        fields: JSON.stringify(["username", "display_name", "profile_image"]),
      },
    });

    return {
      id: channelId,
      name: profile.display_name ?? profile.username,
      isDM: true,
      metadata: {
        username: profile.username,
        profileImage: profile.profile_image,
      },
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
