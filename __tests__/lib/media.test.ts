import { NetworkError, ValidationError } from "@chat-adapter/shared";
import { describe, expect, it, vi } from "vitest";

import { type AccessTokenProvider, TikTokApiClient } from "../../src/lib/api-client.js";
import {
  canSendImage,
  fetchMediaBytes,
  fetchUrlBytes,
  getMediaDownloadUrl,
  MAX_IMAGE_BYTES,
  toImageBuffer,
  uploadImage,
} from "../../src/lib/media.js";

function okResponse(data: unknown) {
  return {
    status: 200,
    json: async () => ({ code: 0, message: "OK", request_id: "req_1", data }),
  } as unknown as Response;
}

function clientWith(fetchImpl: unknown) {
  const tokens: AccessTokenProvider = {
    getAccessToken: async () => "token_1",
    refreshAccessToken: async () => "token_2",
  };
  return new TikTokApiClient({ tokens, fetchImpl: fetchImpl as never });
}

describe("toImageBuffer", () => {
  it("passes a Buffer through", async () => {
    const buf = Buffer.from("abc");
    expect(await toImageBuffer(buf)).toBe(buf);
  });

  it("converts an ArrayBuffer and a Blob", async () => {
    expect((await toImageBuffer(new Uint8Array([1, 2]).buffer))?.length).toBe(2);
    expect((await toImageBuffer(new Blob(["hi"])))?.toString()).toBe("hi");
  });

  it("returns null for something it cannot read", async () => {
    expect(await toImageBuffer("nope" as never)).toBeNull();
  });
});

describe("uploadImage", () => {
  it("posts multipart without setting Content-Type by hand", async () => {
    // Setting it manually omits the boundary, producing a body the server
    // cannot parse.
    const fetchImpl = vi.fn(async () => okResponse({ media_id: "m_1" }));
    const client = clientWith(fetchImpl);

    const mediaId = await uploadImage(client, {
      businessId: "biz_1",
      data: Buffer.from("png-bytes"),
      mimeType: "image/png",
      filename: "shot.png",
    });

    expect(mediaId).toBe("m_1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("business/message/media/upload/");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("media_type")).toBe("IMAGE");
    expect((init.body as FormData).get("business_id")).toBe("biz_1");
  });

  it("rejects an unsupported type before uploading", async () => {
    // TikTok answers with a generic parameter error that names no rule.
    const fetchImpl = vi.fn();
    await expect(
      uploadImage(clientWith(fetchImpl), {
        businessId: "biz_1",
        data: Buffer.from("x"),
        mimeType: "image/gif",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an oversized image before uploading", async () => {
    const fetchImpl = vi.fn();
    await expect(
      uploadImage(clientWith(fetchImpl), {
        businessId: "biz_1",
        data: Buffer.alloc(MAX_IMAGE_BYTES + 1),
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/at most/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when TikTok returns no media_id", async () => {
    await expect(
      uploadImage(clientWith(vi.fn(async () => okResponse({}))), {
        businessId: "biz_1",
        data: Buffer.from("x"),
        mimeType: "image/png",
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("getMediaDownloadUrl", () => {
  it("requests a URL for the message's media", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ download_url: "https://cdn/x" }));

    await expect(
      getMediaDownloadUrl(clientWith(fetchImpl), {
        businessId: "biz_1",
        conversationId: "c_1",
        messageId: "m_1",
        mediaId: "media_1",
        mediaType: "IMAGE",
      }),
    ).resolves.toBe("https://cdn/x");

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ media_id: "media_1", media_type: "IMAGE" });
  });

  it("fails when no URL comes back", async () => {
    await expect(
      getMediaDownloadUrl(clientWith(vi.fn(async () => okResponse({}))), {
        businessId: "biz_1",
        conversationId: "c_1",
        messageId: "m_1",
        mediaId: "media_1",
        mediaType: "IMAGE",
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("fetchMediaBytes", () => {
  it("authenticates with x-user, not Access-Token", async () => {
    // The download host uses a third auth scheme; the wrong header reads as
    // missing media.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));

    const bytes = await fetchMediaBytes("https://cdn/x", "token_1", fetchImpl as never);

    expect(bytes.length).toBe(3);
    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers["x-user"]).toBe("token_1");
    expect(headers["Access-Token"]).toBeUndefined();
  });

  it("explains that download URLs expire", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }));
    await expect(fetchMediaBytes("https://cdn/x", "token_1", fetchImpl as never)).rejects.toThrow(
      /expire after 24 hours/,
    );
  });
});

describe("canSendImage", () => {
  it("reports true only when TikTok grants IMAGE_SEND", async () => {
    const granted = vi.fn(async () =>
      okResponse({
        capability_infos: [{ capability_type: "IMAGE_SEND", capability_result: true }],
      }),
    );
    const denied = vi.fn(async () =>
      okResponse({
        capability_infos: [{ capability_type: "IMAGE_SEND", capability_result: false }],
      }),
    );

    await expect(canSendImage(clientWith(granted), "biz_1", "c_1")).resolves.toBe(true);
    await expect(canSendImage(clientWith(denied), "biz_1", "c_1")).resolves.toBe(false);
  });

  it("sends capability_types as a JSON array in the query", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ capability_infos: [] }));
    await canSendImage(clientWith(fetchImpl), "biz_1", "c_1");

    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(url)).toContain('capability_types=["IMAGE_SEND"]');
  });

  it("treats an empty capability list as not permitted", async () => {
    await expect(
      canSendImage(clientWith(vi.fn(async () => okResponse({}))), "biz_1", "c_1"),
    ).resolves.toBe(false);
  });
});

describe("fetchUrlBytes", () => {
  it("fetches without an auth header", async () => {
    // Sticker and emoji URLs are served directly, unlike the media host.
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }));

    const bytes = await fetchUrlBytes("https://cdn/s.png", fetchImpl as never);

    expect(bytes.length).toBe(4);
    expect((fetchImpl.mock.calls[0] as [string, RequestInit | undefined])[1]).toBeUndefined();
  });

  it("reports a failed download rather than returning empty bytes", async () => {
    await expect(
      fetchUrlBytes("https://cdn/s.png", vi.fn(async () => ({ ok: false, status: 404 })) as never),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it("wraps a transport failure", async () => {
    await expect(
      fetchUrlBytes(
        "https://cdn/s.png",
        vi.fn(async () => {
          throw new Error("ECONNRESET");
        }) as never,
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
