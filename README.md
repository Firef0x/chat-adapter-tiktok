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
| `signatureToleranceSeconds` | `number` | `5` | Permitted webhook timestamp drift. This is what prevents replay |
| `apiVersion` | `string` | `"v1.3"` | API version segment |
| `baseUrl` | `string` | TikTok's host | Override the API host. Intended for testing |
| `logger` | `Logger` | Chat SDK's | Logger override |

## Platform setup

1. Create a **verified TikTok Business Account**. Personal accounts cannot use
   the Business Messaging API.
2. Register an app in the TikTok developer portal and apply for
   **Business Messaging API** access.
3. Request the messaging scopes: `message.list.read`, `message.list.send`, and
   `message.list.manage`.
4. Complete the OAuth flow for the business account. The token response's
   `open_id` is the `business_id` used everywhere else in the API — there is no
   separate business ID field.
5. Register a publicly reachable HTTPS webhook URL and subscribe to the
   `im_receive_msg` and `im_send_msg` events.

This adapter does not perform the authorization-code exchange; supply the
resulting tokens through config and it manages the refresh cycle from there.

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
| Images and media | ❌ | Planned for v0.2. Inbound media arrives as a placeholder |
| Reactions | ❌ | No platform API; throws `NotImplementedError` |
| Edit and delete | ❌ | No platform API; throws `NotImplementedError` |
| Group threads | ❌ | TikTok direct messages are 1:1 only |
| Starting a conversation | ❌ | Not permitted by the platform |
| Streaming | ❌ | No platform API |

### Cards and buttons

A card with a short question and one to three plain buttons is sent as a TikTok
**Q&A button card**, which renders as real tappable buttons. When the user taps
one, TikTok delivers their choice as a normal text message.

Anything that does not fit degrades to plain text rather than being dropped —
more than three buttons, a button label over 20 characters, a question over 40,
or a card carrying link buttons or select options:

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
