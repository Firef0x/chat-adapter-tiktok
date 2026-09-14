# chat-adapter-tiktok

[![npm version](https://img.shields.io/npm/v/chat-adapter-tiktok)](https://www.npmjs.com/package/chat-adapter-tiktok)
[![npm downloads](https://img.shields.io/npm/dm/chat-adapter-tiktok)](https://www.npmjs.com/package/chat-adapter-tiktok)
[![license](https://img.shields.io/npm/l/chat-adapter-tiktok)](./LICENSE)

TikTok Business Messaging adapter for [Chat SDK](https://chat-sdk.dev/docs).

Bridges TikTok direct messages into the platform-agnostic Chat SDK `Adapter`
interface, so your bot code stays the same whether it is talking to Slack,
WhatsApp, or TikTok.

> **Status: pre-release.** Every path is unit-tested against mocked HTTP, but
> the package has not yet been verified end to end against live TikTok
> credentials. Read [Limitations](#limitations) before depending on it.

## Installation

```bash
npm install chat chat-adapter-tiktok
```

`chat` is a peer dependency — the adapter runs inside your Chat instance.

## Usage

```typescript
import { Chat } from "chat";
import { createTikTokAdapter } from "chat-adapter-tiktok";

const chat = new Chat({
  adapter: createTikTokAdapter({
    appId: process.env.TIKTOK_APP_ID,
    appSecret: process.env.TIKTOK_APP_SECRET,
    businessId: process.env.TIKTOK_BUSINESS_ID,
    accessToken: process.env.TIKTOK_ACCESS_TOKEN,
    refreshToken: process.env.TIKTOK_REFRESH_TOKEN,

    // TikTok access tokens last 24 hours and the refresh token rotates on
    // every use. The adapter refreshes automatically and hands the new
    // credentials back here — persist them, or a restart loses the connection.
    onTokenRefresh: async (tokens) => {
      await db.saveTikTokTokens(tokens);
    },
  }),
});

chat.on("message", async (message, thread) => {
  await thread.post(`You said: ${message.text}`);
});
```

Route your webhook endpoint to the adapter:

```typescript
export async function POST(request: Request) {
  return chat.handleWebhook(request);
}
```

`tiktok` is exported as a shorthand alias for `createTikTokAdapter`.

## Environment variables

Every credential can be passed in config or read from the environment. Config
takes precedence; a missing credential throws at construction rather than
surfacing later as an opaque API rejection.

| Variable | Required | Description |
|---|---|---|
| `TIKTOK_APP_ID` | Yes | App ID from the TikTok developer portal |
| `TIKTOK_APP_SECRET` | Yes | App secret. Also verifies webhook signatures |
| `TIKTOK_BUSINESS_ID` | Yes | The connected account's `open_id` |
| `TIKTOK_ACCESS_TOKEN` | Yes | Current access token |
| `TIKTOK_REFRESH_TOKEN` | Yes | Current refresh token |

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `appId` | `string` | — | App ID. Sent as `client_id` on the token endpoints |
| `appSecret` | `string` | — | App secret, and the webhook signing key |
| `businessId` | `string` | — | The `open_id` returned by the OAuth exchange; required on every API call |
| `accessToken` | `string` | — | Current access token |
| `refreshToken` | `string` | — | Current refresh token |
| `accessTokenExpiresAt` | `number` | treated as expired | Expiry in epoch milliseconds. Omitting it forces one refresh up front |
| `refreshTokenExpiresAt` | `number` | unknown | Expiry in epoch milliseconds. Supplying it lets the adapter fail fast with a clear re-authorize error |
| `onTokenRefresh` | `(tokens) => void \| Promise<void>` | — | Called with rotated credentials. Persist them |
| `useTemplates` | `boolean` | `true` | Send fitting cards as native Q&A button cards. Set `false` to always send plain text |
| `userName` | `string` | `"tiktok-bot"` | Display name for the bot |
| `onReferral` | `(event) => void \| Promise<void>` | — | Called when a user arrives via an ad or tiktok.me link |
| `maxRateLimitRetries` | `number` | `2` | Retries for a throttled request. `0` disables |
| `rateLimitRetryDelayMs` | `number` | `1000` | First retry delay, doubling each attempt |
| `signatureToleranceSeconds` | `number` | `5` | Permitted webhook timestamp drift. This is what prevents replay |
| `apiVersion` | `string` | `"v1.3"` | API version segment |
| `baseUrl` | `string` | TikTok's host | Override the API host. Intended for testing |
| `logger` | `Logger` | Chat SDK's | Logger override |

## Serving many accounts

TikTok delivers every authorized account's webhooks to a single app URL, so a
platform serving more than one business must decide which adapter owns each
delivery. `TikTokWebhookRouter` does that:

```typescript
import { TikTokWebhookRouter } from "chat-adapter-tiktok";

const router = new TikTokWebhookRouter({ appSecret: process.env.TIKTOK_APP_SECRET });
router.register(adapterForAcme).register(adapterForGlobex);

export async function POST(request: Request) {
  return router.handleWebhook(request);
}
```

For more tenants than you want resident in memory, register nothing and
resolve on demand:

```typescript
new TikTokWebhookRouter({
  appSecret,
  resolve: async (businessId) => adapterCache.get(businessId) ?? (await loadTenant(businessId)),
});
```

Return `null` for "not one of ours" — a permanent answer, which the router
reports as `200` so TikTok stops retrying. **Throw** if the lookup itself
failed, such as a database being unreachable: that is transient, and the
router answers `503` so the delivery is retried rather than discarded.

The router does not cache resolver results, so cache in your resolver. Besides
the lookup cost, an adapter rebuilt per delivery starts with empty
deduplication state, which is what stops a retried webhook being handled twice
and stops the bot answering its own replies.

Doing this by hand is harder than it looks. A `Request` body can only be read
once, so peeking at it to find the account leaves nothing for the adapter to
verify. The router reads the body once, verifies it once, and passes the
verified bytes on.

Verification happens **before** the account is read, because the account
selects the credentials used to reply, and because an unverified body must not
be able to drive tenant lookups.

It also happens only once on purpose. TikTok's signature carries a timestamp
checked against a five-second tolerance, so a second check after a slow tenant
load would reject a delivery the first accepted — and TikTok retries anything
that is not 2xx, so that delivery would loop forever. Set
`signatureToleranceSeconds` on the *router* if your tenant lookups are slow;
it is the only tolerance in play.

Every adapter must belong to the same TikTok app as the router, since one app
secret signs them all. `register()` refuses a mismatch rather than letting
each of that adapter's deliveries fail.

## Webhook configuration

Register the callback URL programmatically instead of clicking through the
developer portal:

```typescript
import { getWebhookConfig, setWebhookConfig } from "chat-adapter-tiktok";

await setWebhookConfig({
  appId: process.env.TIKTOK_APP_ID,
  appSecret: process.env.TIKTOK_APP_SECRET,
  callbackUrl: "https://example.com/webhooks/tiktok",
});

// `null` when nothing is configured yet.
const current = await getWebhookConfig({ appId, appSecret });
```

These are **app-level**: they authenticate with the app's own ID and secret
rather than an access token, and one configuration covers every business that
has authorized the app — there is nothing to repeat per account.
`deleteWebhookConfig()` removes it.

One caution: TikTok documents the read as a `GET`, so `getWebhookConfig()` puts
the app secret in the query string, where proxies and access logs record it in
a way request bodies are not. Prefer running it from somewhere that does not
log outbound URLs.

## Referral attribution

When a user arrives through a Click-to-Message ad or a tiktok.me link, TikTok
sends a separate event carrying no message. It is therefore invisible to the
message stream, and the SDK has no event for it, so it is delivered to a
callback:

```typescript
createTikTokAdapter({
  // ...credentials
  onReferral: async ({ threadId, referral }) => {
    await attributeConversation(threadId, referral.ad?.ad_id ?? referral.short_link?.ref);
  },
});
```

## Platform setup

1. Create a **verified TikTok Business Account**. Personal accounts cannot use
   the Business Messaging API.
2. Register an app in the TikTok developer portal and apply for
   **Business Messaging API** access.
3. Request the messaging scopes: `message.list.read`, `message.list.send`, and
   `message.list.manage`.
4. Complete the OAuth flow for the business account — see
   [Authorization](#authorization) below.
5. Register a publicly reachable HTTPS webhook URL and subscribe to the
   `im_receive_msg` and `im_send_msg` events.

## Authorization

Send the operator to TikTok, then exchange the code it returns:

```typescript
import { buildAuthorizeUrl, exchangeAuthCode } from "chat-adapter-tiktok";

// 1. Redirect the operator here.
const url = buildAuthorizeUrl({
  appId: process.env.TIKTOK_APP_ID,
  redirectUri: "https://example.com/tiktok/callback",
  state: csrfToken,
});

// 2. On the callback, trade the code for credentials.
const tokens = await exchangeAuthCode({
  appId: process.env.TIKTOK_APP_ID,
  appSecret: process.env.TIKTOK_APP_SECRET,
  authCode: new URL(request.url).searchParams.get("code"),
  redirectUri: "https://example.com/tiktok/callback",
});

// 3. `tokens` is shaped for the adapter config.
const adapter = createTikTokAdapter({
  appId: process.env.TIKTOK_APP_ID,
  appSecret: process.env.TIKTOK_APP_SECRET,
  ...tokens,
});
```

The authorization code is **single-use and expires after ten minutes**, so
exchange it on the callback rather than queueing the work.

Check at setup that the grant actually carries the messaging scopes — a grant
can be valid without them, and the first symptom otherwise is a permission
error on a send:

```typescript
import { getTokenInfo, missingMessagingScopes } from "chat-adapter-tiktok";

const info = await getTokenInfo({ appId, accessToken: tokens.accessToken });
const missing = missingMessagingScopes(info.scopes);
if (missing.length > 0) {
  throw new Error(`TikTok grant is missing: ${missing.join(", ")}`);
}
```

`revokeAccessToken({ appId, appSecret, accessToken })` disconnects an account.

TikTok names the application three different ways across these endpoints —
`client_key` on the authorize URL, `client_id` on the token and revoke
endpoints, and `app_id` on token inspection and webhook configuration. The
helpers handle that; it is worth knowing if you ever call the API directly.

`businessId` comes from the response's `open_id` — the same value under a
different name, and the one every messaging call needs.

## Features

| Feature | Support | Notes |
|---|---|---|
| Inbound text | ✅ | |
| Outbound text | ✅ | Up to 6000 characters, checked before sending |
| Cards and buttons | ✅ | Native Q&A button card, with a plain-text fallback |
| Typing indicator | ✅ | Via `SENDER_ACTION` |
| Read receipts | ✅ | `markAsRead()`, via `SENDER_ACTION` |
| Webhook verification | ✅ | HMAC-SHA256 over the raw body, fails closed |
| Deduplication | ✅ | Survives retries and suppresses self-echoes |
| Message history | ⚠️ | The 20 most recent messages; TikTok offers no pagination |
| Listing conversations | ✅ | `listConversations()` is cheap; `listThreads()` costs one request per conversation |
| Channel info | ✅ | `fetchChannelInfo()` returns the business account's profile |
| OAuth | ✅ | Authorize, exchange, refresh, revoke, and scope inspection |
| Button taps | ✅ | Delivered as messages; `getButtonTapId()` recovers the button |
| Quoted replies | ✅ | `reply()`, text only — TikTok's constraint |
| Sharing your own posts | ✅ | `sharePost()`, by post ID — TikTok allows only your own |
| Webhook configuration | ✅ | Register, read, and remove the callback URL programmatically |
| Referral attribution | ✅ | `onReferral` reports the ad or link that started a conversation |
| Rate-limit backoff | ✅ | Bounded retry on TikTok's `40100` |
| Many accounts on one endpoint | ✅ | `TikTokWebhookRouter`, with eager or lazy tenant resolution |
| Stickers and emoji | ✅ | Received as attachments carrying their URL |
| Images | ✅ | Send and receive, subject to TikTok's regional gating |
| Video and other media | ⚠️ | Received as a downloadable attachment; TikTok cannot send them |
| Reactions | ⚠️ | Received as reaction events; sending throws, as TikTok has no API for it |
| Edit and delete | ❌ | No platform API; throws `NotImplementedError` |
| Group threads | ❌ | TikTok direct messages are 1:1 only |
| Starting a conversation | ❌ | Not permitted by the platform |
| Streaming | ❌ | No platform API |

### Listing conversations

`listConversations()` returns TikTok's raw conversation list — identifiers and
update times — in a single request, and is the right call when the IDs are all
you need.

`listThreads()` satisfies the Chat SDK contract instead, which requires a root
message per thread. TikTok's conversation list carries no message content, so
that costs **one extra request per conversation**; the default page is 20 for
that reason, and a conversation that cannot be read is skipped rather than
failing the whole page.

Both cover only the last 90 days, which is TikTok's retention for this
endpoint.

### Images

Send an image by attaching it to a postable; the adapter checks the
conversation's capability, uploads the file, and sends it:

```typescript
await thread.post({ files: [{ data: pngBuffer, filename: "chart.png", mimeType: "image/png" }] });
```

Inbound images and videos arrive as attachments whose bytes are **not**
downloaded during parsing. Most messages are never asked for their media, the
download URL takes a separate request, and it expires after 24 hours — so
`fetchData()` defers all of that to the first caller that wants the file:

```typescript
const bytes = await message.attachments[0]?.fetchData?.();
```

### Sharing a post

`sharePost()` sends one of the account's own posts into a conversation. TikTok
takes the post's ID rather than a URL, and allows sharing only posts the
account itself published:

```typescript
await adapter.sharePost(threadId, "7412345678901234567");
```

A shared post is its own message type and cannot carry a caption, so send any
accompanying text as a separate message.

### Reactions and stickers

A reaction arrives as a reaction event rather than a message, so the emoji,
the direction, and the message it applies to all survive:

```typescript
chat.onReaction(async (event) => {
  if (event.added) {
    console.log(`${event.rawEmoji} on ${event.messageId}`);
  }
});
```

Compare on `event.rawEmoji` rather than by identity: TikTok sends the emoji
character itself and the SDK has no reverse lookup from a character to a
well-known name, so `event.emoji` is built from the character.

Stickers and emoji arrive as attachments carrying a direct URL — no download
request and no auth header, unlike images and video. A sticker URL is valid for
30 days; an emoji URL does not expire.

### Cards and buttons

A card with a short question and one to three plain buttons is sent as a TikTok
**Q&A button card**, which renders as real tappable buttons. When the user taps
one, TikTok delivers their choice as a normal text message.

Labels longer than 20 characters are sent as a **Q&A link card** instead, which
renders inline text links and allows up to 40 — so a slightly long label costs
you the button styling, not the buttons themselves.

Anything that fits neither degrades to plain text rather than being dropped —
more than three buttons, a label over 40 characters, a question over 40, or a
card carrying link buttons or select options:

```
Order status
Shipped on Tuesday
• Track my order
• Talk to a human
```

The fallback costs interactivity, never information. Disabled buttons are left
out either way, since TikTok cannot show a disabled state and an unselectable
option is worse than an absent one. Inbound template messages are rendered the
same way.

Set `useTemplates: false` to always send plain text.

When a user taps a button, TikTok does not emit a distinct event — it sends the
button's label as an ordinary text message on their behalf, and attaches the
`id` you set on the button. `getButtonTapId()` recovers it:

```typescript
import { getButtonTapId } from "chat-adapter-tiktok";

chat.on("message", async (message, thread) => {
  const button = getButtonTapId(message.raw);
  if (button === "talk_to_human") {
    await thread.post("Connecting you to someone now.");
  }
});
```

Taps are deliberately **not** dispatched through Chat SDK's action pipeline: a
tap really is a message on TikTok, so routing it as an action would silence
hosts that only handle messages, and emitting both would deliver the same tap
twice.

## Token lifecycle

TikTok issues short-lived credentials, which is the main operational difference
from most other chat platforms:

| Credential | Lifetime | Behavior |
|---|---|---|
| Access token | 24 hours | Refreshed automatically before expiry |
| Refresh token | 1 year, **rotates on every refresh** | Requires re-authorization once it expires |

The refresh token changes every time it is used. If you do not persist the new
value from `onTokenRefresh`, the old one stops working and the connection can
only be recovered by completing OAuth again.

When the refresh token expires or is revoked, the adapter throws an
`AuthenticationError`. Treat that as "this connection needs re-authorization"
rather than a transient failure — retrying will not fix it.

## Limitations

These come from the TikTok platform, not from this adapter:

- **You cannot start a conversation.** Every conversation begins with the user,
  a tiktok.me link, or a Click-to-Message ad. There is no "open a DM" API.
- **48-hour messaging windows.** For non-mutual-follow conversations: up to 10
  messages in the 48 hours after the user's first message; unlimited messages
  for 48 hours after each subsequent user reply; and at most 3 further messages
  once 48 hours have passed without a reply.
- **Not available in the EEA, Switzerland, or the UK.** Accounts in those
  regions emit a stripped event carrying no message content, so a bot cannot
  reply to them.
- **No comment webhook.** You cannot trigger a DM from a comment on a post.
- **1:1 conversations only.** There are no group threads.
- **Reactions, edits, and deletes are unsupported.** Chat SDK requires these
  methods on every adapter, so they are present but throw `NotImplementedError`
  rather than failing silently.

## Development

```bash
npm install
npm run verify   # lint, typecheck, test, build
```

Tests mock all HTTP, so no TikTok credentials are required to run them.

## License

Apache-2.0
