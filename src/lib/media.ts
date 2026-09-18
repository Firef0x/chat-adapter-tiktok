import { NetworkError, ValidationError } from "@chat-adapter/shared";

import type { TikTokCapabilityData, TikTokConversationType } from "../types.js";
import type { TikTokApiClient } from "./api-client.js";
import { ADAPTER_NAME } from "./thread-id.js";

/** TikTok rejects an upload above this size. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** The only image types the upload endpoint accepts. */
export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;

/**
 * Normalize the shapes `FileUpload.data` can take.
 *
 * `toBuffer` from `@chat-adapter/shared` would do this, but it requires a
 * `PlatformName`, a closed union of four platforms that does not include
 * TikTok — passing one of the others to satisfy the type would put a wrong
 * platform name into any error it raises.
 */
export async function toImageBuffer(data: Buffer | Blob | ArrayBuffer): Promise<Buffer | null> {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  return null;
}

export interface UploadImageOptions {
  businessId: string;
  data: Buffer;
  filename?: string;
  mimeType?: string;
}

/**
 * Upload an image and return its media ID.
 *
 * Size and type are checked locally first: both limits are documented, and a
 * rejection from TikTok arrives as a generic parameter error that says nothing
 * about which rule was broken.
 *
 * The returned media ID is valid for 30 days.
 */
export async function uploadImage(
  client: TikTokApiClient,
  options: UploadImageOptions,
): Promise<string> {
  const mimeType = options.mimeType ?? "image/jpeg";

  if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    throw new ValidationError(
      ADAPTER_NAME,
      `TikTok accepts only ${SUPPORTED_IMAGE_TYPES.join(" and ")}; got ${mimeType}.`,
    );
  }

  if (options.data.byteLength > MAX_IMAGE_BYTES) {
    throw new ValidationError(
      ADAPTER_NAME,
      `Image is ${options.data.byteLength} bytes; TikTok allows at most ${MAX_IMAGE_BYTES}.`,
    );
  }

  const form = new FormData();
  form.set("business_id", options.businessId);
  form.set("media_type", "IMAGE");
  form.set(
    "file",
    new Blob([new Uint8Array(options.data)], { type: mimeType }),
    options.filename ?? "image",
  );

  const data = await client.request<{ media_id?: string }>({
    method: "POST",
    path: "business/message/media/upload/",
    formData: form,
  });

  if (!data.media_id) {
    throw new NetworkError(ADAPTER_NAME, "TikTok accepted the upload but returned no media_id.");
  }

  return data.media_id;
}

export interface MediaDownloadOptions {
  businessId: string;
  conversationId: string;
  messageId: string;
  mediaId: string;
  mediaType: "IMAGE" | "VIDEO";
}

/** Request a temporary download URL. It expires after 24 hours. */
export async function getMediaDownloadUrl(
  client: TikTokApiClient,
  options: MediaDownloadOptions,
): Promise<string> {
  const data = await client.request<{ download_url?: string }>({
    method: "POST",
    path: "business/message/media/download/",
    body: {
      business_id: options.businessId,
      conversation_id: options.conversationId,
      message_id: options.messageId,
      media_id: options.mediaId,
      media_type: options.mediaType,
    },
  });

  if (!data.download_url) {
    throw new NetworkError(ADAPTER_NAME, "TikTok returned no download_url for the media.");
  }

  return data.download_url;
}

/**
 * Fetch media bytes from a download URL.
 *
 * The URL authenticates with an `x-user` header rather than the `Access-Token`
 * every other endpoint uses — a third auth scheme, and sending the wrong
 * header returns a failure that looks like the media is missing.
 */
export async function fetchMediaBytes(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { "x-user": accessToken } });
  } catch (error) {
    throw new NetworkError(
      ADAPTER_NAME,
      "Media download failed",
      error instanceof Error ? error : undefined,
    );
  }

  if (!response.ok) {
    throw new NetworkError(
      ADAPTER_NAME,
      `Media download failed (HTTP ${response.status}). Download URLs expire after 24 hours.`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetch bytes from a plain URL.
 *
 * Sticker and emoji URLs are served directly and take no auth header — unlike
 * the media download host, which requires `x-user`.
 */
export async function fetchUrlBytes(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new NetworkError(
      ADAPTER_NAME,
      "Download failed",
      error instanceof Error ? error : undefined,
    );
  }

  if (!response.ok) {
    throw new NetworkError(ADAPTER_NAME, `Download failed (HTTP ${response.status}).`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** What TikTok said about a capability, distinguishing "no" from "no answer". */
export interface CapabilityAnswer {
  /** Whether TikTok reported on this capability at all. */
  known: boolean;
  /** Whether it is permitted. Meaningless unless `known`. */
  allowed: boolean;
}

/**
 * Ask whether images may be sent in this conversation.
 *
 * Image support is region-gated on both sides of the conversation, so it has
 * to be checked per conversation rather than once per account.
 *
 * `conversationType` must match the conversation being asked about: a
 * first-contact DM from a non-follower is `STRANGER`, and probing it as
 * `SINGLE` asks about a conversation that does not exist.
 */
export async function canSendImage(
  client: TikTokApiClient,
  businessId: string,
  conversationId: string,
  conversationType: TikTokConversationType = "SINGLE",
): Promise<CapabilityAnswer> {
  const data = await client.request<TikTokCapabilityData>({
    method: "GET",
    path: "business/message/capabilities/get/",
    query: {
      business_id: businessId,
      conversation_id: conversationId,
      conversation_type: conversationType,
      // A JSON-encoded array inside a query parameter, which is how the
      // endpoint documents it.
      capability_types: JSON.stringify(["IMAGE_SEND"]),
    },
  });

  const infos = data.capability_infos ?? [];
  const entry = infos.find((info) => info.capability_type === "IMAGE_SEND");

  // An explicit denial and a missing answer are different facts, and the
  // caller phrases a different error for each: "TikTok says no" is actionable
  // in a way that "TikTok said nothing about it" is not.
  return { known: entry !== undefined, allowed: entry?.capability_result === true };
}
