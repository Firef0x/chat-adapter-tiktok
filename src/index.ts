export { TikTokAdapter } from "./adapter.js";
export { createTikTokAdapter, tiktok } from "./factory.js";
export {
  type AccessTokenProvider,
  mapTikTokError,
  TikTokApiClient,
} from "./lib/api-client.js";
export { TikTokFormatConverter } from "./lib/format-converter.js";
export {
  channelIdFromThreadId,
  decodeThreadId,
  encodeThreadId,
} from "./lib/thread-id.js";
export { TikTokTokenManager } from "./lib/token-manager.js";
export {
  parseSignatureHeader,
  signWebhookBody,
  verifyWebhookSignature,
} from "./lib/webhook.js";
export { TIKTOK_CODE, TIKTOK_MESSAGING_SCOPES } from "./types.js";
export type {
  TikTokAdapterConfig,
  TikTokApiEnvelope,
  TikTokCapabilityData,
  TikTokCode,
  TikTokContentBase,
  TikTokConversation,
  TikTokConversationListData,
  TikTokConversationType,
  TikTokEuMessageContent,
  TikTokMarkReadContent,
  TikTokMessageContent,
  TikTokMessageListData,
  TikTokParticipant,
  TikTokRawMessage,
  TikTokReferral,
  TikTokReferralContent,
  TikTokRestMessage,
  TikTokRestMessageType,
  TikTokRestRole,
  TikTokSendMessageData,
  TikTokSendMessageRequest,
  TikTokSendMessageType,
  TikTokTemplatePayload,
  TikTokThreadId,
  TikTokTokenResponse,
  TikTokTokens,
  TikTokWebhookContent,
  TikTokWebhookEnvelope,
  TikTokWebhookEventName,
  TikTokWebhookMessageType,
  TikTokWebhookRole,
  TikTokWebhookUser,
} from "./types.js";
