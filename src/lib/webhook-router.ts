import { ValidationError } from "@chat-adapter/shared";
import type { Logger, WebhookOptions } from "chat";
import { ConsoleLogger } from "chat";

import type { TikTokAdapter } from "../adapter.js";
import type { TikTokWebhookEnvelope } from "../types.js";
import { ADAPTER_NAME } from "./thread-id.js";
import { SIGNATURE_HEADER, verifyWebhookSignature } from "./webhook.js";

/** Resolves an adapter for a business account, or `null` if it is not ours. */
export type TikTokAdapterResolver = (
  businessId: string,
) => TikTokAdapter | null | undefined | Promise<TikTokAdapter | null | undefined>;

export interface TikTokWebhookRouterOptions {
  /**
   * The app secret, which signs every delivery.
   *
   * One app serves many business accounts and signs all of their webhooks
   * with this single secret, which is what lets the router verify before it
   * knows whose message it is holding.
   */
  appSecret: string;
  /**
   * Looks up an adapter not held in memory.
   *
   * Consulted after {@link TikTokWebhookRouter.register}. A platform with more
   * tenants than it wants resident can register nothing and resolve entirely
   * from here.
   *
   * Return `null` for "not one of ours" — a permanent answer. **Throw** if the
   * lookup itself failed, such as a database being unreachable: that is
   * transient, and the two are answered differently so TikTok retries the
   * second and not the first.
   *
   * Results are not cached here: the router calls this on every delivery for
   * an unregistered account, so caching belongs to the resolver, where the
   * host controls eviction. Returning a freshly built adapter each time would
   * also discard its deduplication state, so a cache is worth having.
   */
  resolve?: TikTokAdapterResolver;
  /**
   * Permitted signature timestamp drift, in seconds. Defaults to 300.
   *
   * This is the only tolerance that applies: the router verifies once for the
   * whole app, and adapters it dispatches to do not check again.
   */
  signatureToleranceSeconds?: number;
  logger?: Logger;
}

/**
 * Routes one webhook endpoint to many per-account adapters.
 *
 * TikTok delivers every authorized account's webhooks to a single app URL, so
 * a host serving more than one business has to decide which adapter owns each
 * delivery. Doing that by hand is harder than it looks: a `Request` body can
 * only be read once, so peeking at it to find the account leaves nothing for
 * the adapter to verify.
 *
 * The router reads the body once, verifies it, and hands each adapter its own
 * request. Verification happens **before** the account is read, because the
 * account is what selects the credentials used to answer — trusting an
 * unverified body to make that choice would let anyone aim a delivery at any
 * tenant.
 */
export class TikTokWebhookRouter {
  private readonly adapters = new Map<string, TikTokAdapter>();
  private readonly options: TikTokWebhookRouterOptions;
  private readonly logger: Logger;

  constructor(options: TikTokWebhookRouterOptions) {
    // Without this, `createHmac("sha256", "")` accepts an empty key and every
    // forged delivery verifies — the same trap the adapter refuses, and the
    // documented `process.env.TIKTOK_APP_SECRET` is exactly the shape that
    // produces it when the variable is unset.
    if (!options.appSecret) {
      throw new ValidationError(ADAPTER_NAME, "TikTok appSecret is required.");
    }

    this.options = options;
    this.logger = options.logger ?? new ConsoleLogger();
  }

  /**
   * Register an adapter, keyed by the business account it serves.
   *
   * Every adapter must belong to the same TikTok app as the router, since one
   * app secret signs all of them. A mismatch is refused here rather than
   * surfacing as an endless retry of deliveries that can never verify.
   */
  register(adapter: TikTokAdapter): this {
    this.assertSameApp(adapter);

    if (this.adapters.has(adapter.botUserId)) {
      this.logger.warn("Replacing an already-registered TikTok adapter", {
        businessId: adapter.botUserId,
      });
    }

    this.adapters.set(adapter.botUserId, adapter);
    return this;
  }

  private assertSameApp(adapter: TikTokAdapter): void {
    if (!adapter.usesAppSecret(this.options.appSecret)) {
      throw new ValidationError(
        ADAPTER_NAME,
        `The adapter for ${adapter.botUserId} uses a different app secret than this router. One router serves one TikTok app.`,
      );
    }
  }

  /** Stop routing to a business account. */
  unregister(businessId: string): boolean {
    return this.adapters.delete(businessId);
  }

  /** The business accounts currently held in memory. */
  get registered(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Verify a delivery and hand it to the adapter that owns it.
   *
   * - `401` when the signature does not verify.
   * - `200` when no adapter owns the account, or the payload is unusable.
   *   Both are permanent, and TikTok retries anything that is not 2xx, so
   *   answering otherwise would buy an endless replay of a delivery that can
   *   never succeed.
   * - `503` when the resolver itself failed. That one *is* worth retrying, so
   *   a database blip does not silently discard a message.
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    // Read once. Everything downstream works from these bytes, because the
    // body of a Request cannot be consumed twice.
    const rawBody = await request.text();
    const signature = request.headers.get(SIGNATURE_HEADER);
    const logId = request.headers.get("x-tt-logid") ?? undefined;

    const verification = verifyWebhookSignature({
      header: signature,
      rawBody,
      appSecret: this.options.appSecret,
      toleranceSeconds: this.options.signatureToleranceSeconds,
    });

    if (!verification.valid) {
      this.logger.warn("Rejected TikTok webhook", { reason: verification.reason, logId });
      return new Response("Invalid signature", { status: 401 });
    }

    let businessId: string | undefined;
    try {
      businessId = (JSON.parse(rawBody) as TikTokWebhookEnvelope).user_openid;
    } catch (error) {
      this.logger.error("Could not parse a TikTok webhook envelope", { error, logId });
      return new Response("OK", { status: 200 });
    }

    if (!businessId) {
      this.logger.warn("A TikTok webhook carried no business account", { logId });
      return new Response("OK", { status: 200 });
    }

    let adapter: TikTokAdapter | null | undefined;
    try {
      adapter = this.adapters.get(businessId) ?? (await this.options.resolve?.(businessId));
    } catch (error) {
      // The lookup broke, not the delivery. Ask TikTok to come back.
      this.logger.error("Could not resolve a TikTok business account", {
        error,
        businessId,
        logId,
      });
      return new Response("Resolver unavailable", { status: 503 });
    }

    if (!adapter) {
      // Nothing registered and nothing to ask is not an answer about this
      // account — it is a router that is not wired up yet, which a delivery
      // moments later would find ready. Discarding it permanently would lose
      // the messages that arrive during startup.
      if (this.adapters.size === 0 && !this.options.resolve) {
        this.logger.error("A TikTok webhook arrived before any adapter was registered", {
          businessId,
          logId,
        });
        return new Response("Router not ready", { status: 503 });
      }

      // Named, because this path discards the delivery permanently and
      // "tenant X went quiet" is otherwise undiagnosable from the logs.
      this.logger.warn("No TikTok adapter is registered for this business account", {
        businessId,
        logId,
      });
      return new Response("OK", { status: 200 });
    }

    // A resolver may hand back an adapter from another app, which would make
    // every delivery for it unverifiable. Refused here rather than thrown:
    // `register` throws at wiring time, where an operator sees it, but at
    // request time an escaping exception becomes a 500 and TikTok retries a
    // misconfiguration that can never succeed. Permanent, like an unknown
    // tenant, so it gets the same answer.
    try {
      this.assertSameApp(adapter);
    } catch (error) {
      this.logger.error("A resolved TikTok adapter belongs to a different app", {
        error,
        businessId,
        logId,
      });
      return new Response("OK", { status: 200 });
    }

    // The body is passed already verified. Handing over a rebuilt Request for
    // the adapter to check again would re-run the timestamp tolerance under a
    // later clock, so a slow tenant lookup would turn a good delivery into a
    // 401 — and TikTok retries anything that is not 2xx.
    return adapter.handleVerifiedWebhook(rawBody, options, logId);
  }
}
