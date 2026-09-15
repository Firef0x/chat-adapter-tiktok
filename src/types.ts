import type { Logger } from "chat";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * OAuth credentials for a connected TikTok business account.
 *
 * The access token lasts 24 hours (`expires_in: 86400`) and the refresh token
 * one year (`refresh_token_expires_in: 31536000`). The refresh token **rotates
 * on every renewal**, so the value returned by a refresh must be persisted —
 * the previous one stops working.
 */
export interface TikTokTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds at which the access token stops working. */
  accessTokenExpiresAt: number;
  /** Unix epoch milliseconds at which the refresh token stops working. */
  refreshTokenExpiresAt: number;
  /**
   * The account's `open_id`, which TikTok's messaging endpoints call
   * `business_id`. They are the same value under two names.
   */
  businessId: string;
  /** Granted scopes, split from TikTok's comma-separated `scope` string. */
  scopes: string[];
}

/** Configuration for the TikTok adapter. */
export interface TikTokAdapterConfig {
  /** App ID from the TikTok developer portal (`client_id` on the token leg). */
  appId: string;
  /** App secret from the TikTok developer portal. Also signs webhooks. */
  appSecret: string;
  /**
   * The connected account's `business_id` — the `open_id` returned by the
   * OAuth token exchange. Required on every messaging API call, and used to
   * tell inbound messages from echoes of your own sends.
   */
  businessId: string;
  /** Current access token for the connected business account. */
  accessToken: string;
  /** Current refresh token for the connected business account. */
  refreshToken: string;
  /**
   * When the access token expires, as Unix epoch milliseconds.
   *
   * Omit it and the adapter treats the token as already expired, refreshing
   * once before the first request rather than discovering the expiry through
   * a failed call.
   */
  accessTokenExpiresAt?: number;
  /**
   * When the refresh token expires, as Unix epoch milliseconds.
   *
   * Supplying it lets the adapter fail fast with a clear "re-authorize"
   * error instead of attempting a refresh that cannot succeed.
   */
  refreshTokenExpiresAt?: number;
  /**
   * Called whenever the adapter obtains new tokens.
   *
   * The adapter keeps refreshed tokens in memory only. Persist them here, or
   * every process restart begins with a refresh — and because the refresh
   * token rotates, an unsaved one is unrecoverable.
   */
  onTokenRefresh?: (tokens: TikTokTokens) => void | Promise<void>;
  /**
   * Called when a user arrives through a Click-to-Message ad or a tiktok.me
   * link, before they have said anything.
   *
   * This is the only place the attribution appears — TikTok sends it as its
   * own event carrying no message, so it is not reachable from the message
   * stream. It is delivered here rather than through Chat SDK because the SDK
   * has no event for it.
   */
  onReferral?: (event: TikTokReferralEvent) => void | Promise<void>;
  /**
   * Called when the user marks the conversation read.
   *
   * TikTok emits this only for personal accounts: a business reading its own
   * thread produces nothing. Chat SDK has no inbound read-receipt event, so
   * it is delivered here.
   */
  onReadReceipt?: (event: TikTokReadReceiptEvent) => void | Promise<void>;
  /**
   * How many times to retry a request TikTok throttles. Defaults to 2;
   * `0` disables retrying.
   */
  maxRateLimitRetries?: number;
  /**
   * Delay before the first throttled retry, in milliseconds, doubling each
   * attempt. Defaults to 1000.
   */
  rateLimitRetryDelayMs?: number;
  /** Injectable delay for the throttled-retry backoff. Intended for testing. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Display name for the bot. Defaults to `"tiktok-bot"`. */
  userName?: string;
  /**
   * Send cards that fit TikTok's Q&A button card as real tappable buttons
   * rather than a bulleted text list. Defaults to `true`.
   *
   * Set it to `false` if your account rejects template messages; cards then
   * always degrade to plain text, which every account can send.
   */
  useTemplates?: boolean;
  /** Override the API host. Intended for testing. */
  baseUrl?: string;
  /** API version segment. Defaults to `"v1.3"`. */
  apiVersion?: string;
  /**
   * How far a webhook's signature timestamp may drift from local time, in
   * seconds. Defaults to 5, matching TikTok's own sample. Raise it only if
   * your hosts have unreliable clocks — the tolerance is what stops an
   * intercepted request from being replayed later.
   */
  signatureToleranceSeconds?: number;
  logger?: Logger;
}

/**
 * Webhook event types an app can subscribe to.
 *
 * `DIRECT_MESSAGE` is the only value TikTok documents. It is the subscription
 * category, not the per-delivery `event` name — those are the `im_*` values in
 * {@link TikTokWebhookEventName}.
 */
export type TikTokWebhookEventType = "DIRECT_MESSAGE";

/** An app's webhook registration. */
export interface TikTokWebhookConfig {
  appId: string;
  eventType: TikTokWebhookEventType;
  callbackUrl: string;
}

/** A user having read the conversation up to a point in time. */
export interface TikTokReadReceiptEvent {
  /** The conversation, as a Chat SDK thread ID. */
  threadId: string;
  businessId: string;
  conversationId: string;
  /** Everything sent before this instant has been seen. */
  readAt: Date;
  /** The full parsed payload, for anything not surfaced above. */
  raw: TikTokMarkReadContent;
}

/** A user arriving through an ad or a tiktok.me link. */
export interface TikTokReferralEvent {
  /** The conversation the user landed in, as a Chat SDK thread ID. */
  threadId: string;
  /** The business account that received them. */
  businessId: string;
  conversationId: string;
  /** Where they came from, verbatim from TikTok. */
  referral: TikTokReferralContent["referral"];
  /** The full parsed payload, for anything not surfaced above. */
  raw: TikTokReferralContent;
}

/**
 * Decoded thread ID components.
 *
 * TikTok direct messages are always one-to-one between a business account and
 * a user, so a conversation needs no group or room dimension.
 */
export interface TikTokThreadId {
  /** The business account that owns the conversation. */
  businessId: string;
  /**
   * The conversation itself. Note these are base64-like and may contain `+`,
   * which must be percent-encoded as `%2B` in query strings.
   */
  conversationId: string;
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

/**
 * Every TikTok endpoint wraps its result in this envelope.
 *
 * Failures arrive as **HTTP 200 with a non-zero `code`**, so the HTTP status
 * alone never tells you whether a call succeeded.
 */
export interface TikTokApiEnvelope<TData> {
  code: number;
  message: string;
  request_id: string;
  data: TData;
}

/** Business Messaging API return codes. `0` means success. */
export const TIKTOK_CODE = {
  OK: 0,
  /** No permission to perform the related operation. */
  NO_PERMISSION: 40_001,
  /** Missing, invalid, unsupported, or incompatible parameters. */
  INVALID_PARAM: 40_002,
  /** The operation target does not exist. */
  NOT_FOUND: 40_007,
  /**
   * Message blocked by direct message rules.
   *
   * TikTok documents no dedicated code for exceeding the 48-hour reply window
   * or the per-window message cap; this is the most likely code to carry them,
   * but that is inference, not documentation. Do not present it to operators
   * as specifically meaning "outside the messaging window".
   */
  MESSAGE_BLOCKED: 40_064,
  /** Requests made too frequently. This — not HTTP 429 — signals throttling. */
  RATE_LIMITED: 40_100,
  /** Invalid or incorrect access token. */
  INVALID_ACCESS_TOKEN: 40_105,
  /** Unsupported file type. */
  UNSUPPORTED_FILE_TYPE: 40_908,
  /** Transient server-side error; safe to retry. */
  SYSTEM_ERROR: 51_065,
} as const;

export type TikTokCode = (typeof TIKTOK_CODE)[keyof typeof TIKTOK_CODE];

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Response body of the token exchange and refresh endpoints.
 *
 * `open_id` is the value the messaging endpoints call `business_id`; there is
 * no separate business ID field.
 */
export interface TikTokTokenResponse {
  access_token: string;
  token_type: string;
  /** Comma-separated, e.g. `"message.list.read,message.list.send"`. */
  scope: string;
  /** Access token lifetime in seconds. Observed: 86400. */
  expires_in: number;
  refresh_token: string;
  /** Refresh token lifetime in seconds. Observed: 31536000. */
  refresh_token_expires_in: number;
  open_id: string;
}

/** Scopes required to read and send direct messages. */
export const TIKTOK_MESSAGING_SCOPES = [
  "message.list.read",
  "message.list.send",
  "message.list.manage",
] as const;

// ---------------------------------------------------------------------------
// REST message types
//
// The REST API and the webhook payloads use different casing for the same
// concepts — REST is UPPERCASE, webhooks are lowercase. They are deliberately
// modelled as separate types so one cannot be passed where the other belongs.
// ---------------------------------------------------------------------------

/** Message types as reported by the REST message-list endpoint. */
export type TikTokRestMessageType =
  | "TEXT"
  | "IMAGE"
  | "SHARE_POST"
  | "VIDEO"
  | "EMOJI"
  | "STICKER"
  | "TEMPLATE"
  | "OTHER";

/** Message types accepted by the send endpoint. Narrower than inbound. */
export type TikTokSendMessageType = "TEXT" | "IMAGE" | "SHARE_POST" | "TEMPLATE" | "SENDER_ACTION";

export type TikTokRestRole = "BUSINESS_ACCOUNT" | "PERSONAL_ACCOUNT";

export type TikTokConversationType = "STRANGER" | "SINGLE";

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/** A reply-button template. `QA_LINK_CARD` allows longer button titles. */
export interface TikTokTemplatePayload {
  type: "QA_BUTTON_CARD" | "QA_LINK_CARD";
  /** Max 40 characters. */
  title: string;
  /** One to three buttons. Title max 20 chars for button cards, 40 for link. */
  buttons: Array<{ type: "REPLY"; title: string; id: string }>;
}

/**
 * Request body for `POST /business/message/send/`.
 *
 * A message carries exactly one content field matching its `message_type`.
 * Text and image cannot be combined. `referenced_message_info` is valid only
 * with `message_type: "TEXT"`. `direct_reply` is mutually exclusive with
 * `recipient_type`/`recipient`.
 */
export interface TikTokSendMessageRequest {
  business_id: string;
  /** `"CONVERSATION"` is the only supported value. Omit with `direct_reply`. */
  recipient_type?: "CONVERSATION";
  /** The conversation ID. Omit with `direct_reply`. */
  recipient?: string;
  message_type: TikTokSendMessageType;
  /** Max 6000 characters including spaces and emoji. */
  text?: { body: string };
  image?: { media_id: string };
  /** Your own posts only. */
  share_post?: { item_id: string };
  template?: TikTokTemplatePayload;
  sender_action?: "TYPING" | "MARK_READ";
  referenced_message_info?: { referenced_message_id: string };
  direct_reply?: {
    reply_type: "COMMENT_REPLY";
    comment_reply: { comment_id: string };
  };
}

/**
 * Response data for a send.
 *
 * `message_id` is the empty string for `SENDER_ACTION`, since nothing is
 * actually delivered.
 */
export interface TikTokSendMessageData {
  message: { message_id: string };
}

/**
 * What the adapter reports as the platform's raw message.
 *
 * This is the `TRawMessage` generic of the Chat SDK `Adapter` interface: the
 * webhook content for inbound messages, and the send result for outbound ones.
 */
export type TikTokRawMessage = TikTokMessageContent | TikTokRestMessage | TikTokSendMessageData;

// ---------------------------------------------------------------------------
// Conversations and history
// ---------------------------------------------------------------------------

/** Referral data describing how a user arrived in a conversation. */
export interface TikTokReferral {
  ad?: Array<{
    advertiser_id: string;
    ad_id: string;
    /**
     * Epoch **seconds** here. The same field is epoch milliseconds on the
     * `im_referral_msg` webhook — TikTok is inconsistent between the two.
     */
    timestamp: number;
    ad_name: string;
    embed_url: string;
    message_material_id: string;
  }>;
  short_link?: Array<{
    ref: string;
    prefilled_message: string;
    prefilled_message_audit_status: "PASS" | "REJECT";
  }>;
}

export interface TikTokConversation {
  conversation_id: string;
  /** Epoch milliseconds. */
  update_time: number;
  referral?: TikTokReferral;
}

/**
 * Response data for `GET /business/message/conversation/list/`.
 *
 * Covers the last 90 days, up to 100 conversations per page.
 */
export interface TikTokConversationListData {
  conversations: TikTokConversation[];
  has_more: boolean;
  cursor: number;
}

/** A participant in a conversation. */
export interface TikTokParticipant {
  role: TikTokRestRole;
  id: string;
  display_name: string;
  profile_image: string;
  /** Present only when `role` is `"PERSONAL_ACCOUNT"`. */
  is_follower?: boolean;
}

/**
 * Response data for `GET /business/message/content/list/`.
 *
 * This endpoint has **no pagination** — it returns the 20 most recent messages
 * and nothing older.
 */
export interface TikTokMessageListData {
  messages: TikTokRestMessage[];
  participants: TikTokParticipant[];
}

/**
 * A message as returned by the REST message-list endpoint.
 *
 * Only the identifiers are confirmed. The content fields below are modelled on
 * the send endpoint, which uses the same UPPERCASE vocabulary, but the
 * published response example was never retrieved in full — so anything beyond
 * `message_id` and `message_type` is UNCONFIRMED and must be treated as
 * possibly absent.
 *
 * Note there is no index signature: extra fields still arrive at runtime and
 * are ignored, and leaving it off keeps a misspelled field a compile error.
 */
export interface TikTokRestMessage {
  message_id: string;
  message_type: TikTokRestMessageType;
  /** Epoch milliseconds. UNCONFIRMED. */
  timestamp?: number;
  /** UNCONFIRMED; modelled on the send endpoint's shape. */
  text?: { body?: string };
  /** UNCONFIRMED. */
  image?: { media_id?: string };
  /** UNCONFIRMED. */
  video?: { media_id?: string };
  /** UNCONFIRMED. */
  sticker?: { url?: string };
  /** UNCONFIRMED. */
  emoji?: { url?: string };
  /** UNCONFIRMED. */
  share_post?: { embed_url?: string; video_id?: string };
}

/**
 * Response data for `GET /business/get/`.
 *
 * The requested `fields` decide which keys come back; `display_name` and
 * `profile_image` are the documented defaults.
 */
export interface TikTokBusinessProfile {
  display_name?: string;
  profile_image?: string;
  username?: string;
}

/** Per-conversation capability probe, e.g. whether images may be sent. */
export interface TikTokCapabilityData {
  capability_infos: Array<{
    capability_type: string;
    capability_result: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * The outer webhook envelope.
 *
 * `content` is a **JSON-encoded string**, not an object — it must be parsed
 * separately after signature verification.
 */
export interface TikTokWebhookEnvelope {
  /** Your app ID. */
  client_key: string;
  event: TikTokWebhookEventName | string;
  /** Epoch **seconds**. */
  create_time: number;
  /** The receiving business account's `business_id`. */
  user_openid: string;
  /** JSON-encoded payload; parse to one of the `content` types below. */
  content: string;
}

export type TikTokWebhookEventName =
  /** The business sent a message. Also echoes your own API sends. */
  | "im_send_msg"
  /** A user outside the EEA, Switzerland, and the UK sent a message. */
  | "im_receive_msg"
  /** A user inside the EEA, Switzerland, or the UK sent a message. */
  | "im_receive_msg_eu"
  /** The user arrived via a Click-to-Message ad or tiktok.me link. */
  | "im_referral_msg"
  /** A personal-account user marked the conversation read. */
  | "im_mark_read_msg"
  | "im_auto_message_config_update"
  | "im_auto_message_audit_update"
  | "im_receive_high_intent_comment";

/** Webhook-side message types. Lowercase, unlike their REST counterparts. */
export type TikTokWebhookMessageType =
  | "text"
  | "image"
  | "share_post"
  | "video"
  | "emoji"
  | "sticker"
  | "reaction"
  | "template";

/** Webhook-side role. Lowercase, unlike its REST counterpart. */
export type TikTokWebhookRole = "business_account" | "personal_account";

export interface TikTokWebhookUser {
  id: string;
  role: TikTokWebhookRole;
}

/** Fields shared by every conversation-scoped webhook payload. */
export interface TikTokContentBase {
  /** TikTok username of the sender. */
  from: string;
  /** TikTok username of the receiver. */
  to: string;
  /** Stable user identifier, consistent across APIs. */
  unique_identifier: string;
  from_user: TikTokWebhookUser;
  to_user: TikTokWebhookUser;
  conversation_id: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

/**
 * Parsed `content` for `im_send_msg` and `im_receive_msg`.
 *
 * There is no direction flag. `im_send_msg` fires for everything the business
 * account sends, including echoes of your own API calls, so an outbound echo
 * is identified by `from_user.id` matching your `business_id` together with
 * `message_tag.source` being `API` — which distinguishes it from a human
 * colleague replying in the TikTok app.
 */
export interface TikTokMessageContent extends TikTokContentBase {
  message_id: string;
  type: TikTokWebhookMessageType;
  text?: { body: string };
  image?: { media_id: string };
  share_post?: { embed_url: string; video_id: string };
  video?: { media_id: string };
  /** URL valid for 30 days. */
  sticker?: { url: string };
  /** URL does not expire. */
  emoji?: { url: string };
  reaction?: Array<{
    operation: "ADD" | "REMOVE";
    type: "EMOJI" | "AI_EMOJI";
    emoji?: string;
    ai_emoji_url?: string;
    unique_identifier: string;
    timestamp: number;
    original_msg_id: string;
  }>;
  template?: {
    type: "qa_button_card" | "qa_link_card";
    elements: Array<{
      title: string;
      buttons: Array<{ text: string; type: "REPLY"; id: string }>;
    }>;
  };
  referenced_message_info?: { referenced_message_id: string };
  /** Absent when the message was not sent by an automation. */
  auto_message_type?: "WELCOME_MESSAGE" | "SUGGESTED_QUESTION" | "AUTO_REPLY";
  /** Present on `im_receive_msg` only. */
  reply_source_payload?: {
    reply_source_msg_id: string;
    reply_source_unique_id: string;
  };
  /** `0` means a normal conversation. */
  scene_type: number;
  is_follower: boolean;
  message_tag: {
    source: "APP" | "WEB" | "API" | "OTHERS" | "UNKNOWN_SOURCE";
  };
}

/**
 * Parsed `content` for `im_receive_msg_eu`.
 *
 * Deliberately stripped for EEA, Swiss, and UK users: no message content, no
 * `conversation_id`, no sender identity. There is nothing here to deliver to a
 * bot — it signals only that a message arrived.
 */
export interface TikTokEuMessageContent {
  to: string;
  to_user: TikTokWebhookUser;
  /** Epoch milliseconds. */
  timestamp: number;
}

/** Parsed `content` for `im_mark_read_msg`. */
export interface TikTokMarkReadContent extends TikTokContentBase {
  read: {
    /** Epoch milliseconds. */
    last_read_timestamp: number;
  };
}

/**
 * Parsed `content` for `im_referral_msg`.
 *
 * Carries no `message_id` and no `type` — it announces an arrival, not a
 * message.
 */
export interface TikTokReferralContent extends TikTokContentBase {
  referral: {
    source: "ad" | "short_link";
    ad?: {
      advertiser_id: string;
      ad_id: string;
      /** Epoch milliseconds here, unlike the conversation-list variant. */
      timestamp: number;
      ad_name: string;
      embed_url: string;
      message_material_id: string;
    };
    short_link?: {
      ref: string;
      prefilled_message: string;
      prefilled_message_audit_status: "PASS" | "REJECT";
    };
  };
}

/** Any parsed webhook `content` the adapter recognizes. */
export type TikTokWebhookContent =
  | TikTokMessageContent
  | TikTokEuMessageContent
  | TikTokMarkReadContent
  | TikTokReferralContent;
