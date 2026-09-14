import { ValidationError } from "@chat-adapter/shared";

import type { TikTokThreadId } from "../types.js";

export const ADAPTER_NAME = "tiktok";

/**
 * Encode a business account and conversation into a Chat SDK thread ID.
 *
 * Both segments are base64url-encoded. Conversation IDs are base64-like and
 * routinely contain `+` and `=`, which would otherwise collide with the `:`
 * delimiter or be mangled in transport.
 */
export function encodeThreadId(data: TikTokThreadId): string {
  if (!data.businessId) {
    throw new ValidationError(ADAPTER_NAME, "businessId is required");
  }
  if (!data.conversationId) {
    throw new ValidationError(ADAPTER_NAME, "conversationId is required");
  }

  const business = Buffer.from(data.businessId).toString("base64url");
  const conversation = Buffer.from(data.conversationId).toString("base64url");
  return `${ADAPTER_NAME}:${business}:${conversation}`;
}

/** Decode a thread ID produced by {@link encodeThreadId}. */
export function decodeThreadId(threadId: string): TikTokThreadId {
  const parts = threadId.split(":");
  if (parts.length !== 3 || parts[0] !== ADAPTER_NAME) {
    throw new ValidationError(
      ADAPTER_NAME,
      `Invalid TikTok thread ID: ${threadId}`,
    );
  }

  const businessId = Buffer.from(parts[1] as string, "base64url").toString();
  const conversationId = Buffer.from(parts[2] as string, "base64url").toString();

  if (!businessId || !conversationId) {
    throw new ValidationError(
      ADAPTER_NAME,
      `Invalid TikTok thread ID: ${threadId}`,
    );
  }

  return { businessId, conversationId };
}

/**
 * Derive the channel ID from a thread ID.
 *
 * The business account is the channel: every conversation it owns belongs to
 * it, and TikTok has no other grouping.
 */
export function channelIdFromThreadId(threadId: string): string {
  const { businessId } = decodeThreadId(threadId);
  return `${ADAPTER_NAME}:${Buffer.from(businessId).toString("base64url")}`;
}
