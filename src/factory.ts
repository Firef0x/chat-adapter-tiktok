import { ValidationError } from "@chat-adapter/shared";

import { TikTokAdapter } from "./adapter.js";
import { ADAPTER_NAME } from "./lib/thread-id.js";
import type { TikTokAdapterConfig } from "./types.js";

const ENV_VARS = {
  appId: "TIKTOK_APP_ID",
  appSecret: "TIKTOK_APP_SECRET",
  businessId: "TIKTOK_BUSINESS_ID",
  accessToken: "TIKTOK_ACCESS_TOKEN",
  refreshToken: "TIKTOK_REFRESH_TOKEN",
} as const;

/**
 * Create a TikTok adapter, falling back to environment variables.
 *
 * Every credential is required: TikTok has no anonymous or app-only mode for
 * messaging, and a missing one would otherwise surface much later as an
 * opaque API rejection.
 */
export function createTikTokAdapter(
  config?: Partial<TikTokAdapterConfig> & { fetchImpl?: typeof fetch },
): TikTokAdapter {
  const resolved = {} as Record<keyof typeof ENV_VARS, string>;

  for (const [key, envVar] of Object.entries(ENV_VARS) as Array<
    [keyof typeof ENV_VARS, string]
  >) {
    const value = config?.[key] ?? process.env[envVar];
    if (!value) {
      throw new ValidationError(
        ADAPTER_NAME,
        `TikTok ${key} is required. Pass it in config or set ${envVar}.`,
      );
    }
    resolved[key] = value;
  }

  return new TikTokAdapter({ ...config, ...resolved });
}

/** Shorthand for {@link createTikTokAdapter}. */
export const tiktok = createTikTokAdapter;
