# chat-adapter-tiktok

TikTok Business Messaging adapter for [Chat SDK](https://chat-sdk.dev).

Bridges TikTok direct messages into the platform-agnostic Chat SDK `Adapter`
interface, so your bot code stays the same whether it is talking to Slack,
WhatsApp, or TikTok.

> **Status: work in progress.** The package is under active development and has
> not been verified end to end against live TikTok credentials. See
> [Limitations](#limitations) before depending on it.

## Installation

```bash
npm install chat-adapter-tiktok chat
```

`chat` is a peer dependency — the adapter runs inside your Chat instance.

## Requirements

- A **verified TikTok Business Account**. Personal accounts cannot use the
  Business Messaging API.
- A TikTok developer app with **Business Messaging API** access approved, giving
  you an app ID, app secret, and the OAuth credentials for a connected account.
  The messaging scopes are `message.list.read`, `message.list.send`, and
  `message.list.manage`. The `business_id` used throughout the API is the
  `open_id` returned by the OAuth token exchange.
- A publicly reachable HTTPS endpoint for webhooks.

## Usage

```typescript
import { Chat } from "chat";
import { tiktok } from "chat-adapter-tiktok";

const chat = new Chat({
  adapter: tiktok({
    appId: process.env.TIKTOK_APP_ID,
    appSecret: process.env.TIKTOK_APP_SECRET,
    businessId: process.env.TIKTOK_BUSINESS_ID,
    accessToken: process.env.TIKTOK_ACCESS_TOKEN,
    refreshToken: process.env.TIKTOK_REFRESH_TOKEN,

    // TikTok access tokens expire in ~24 hours. The adapter refreshes them
    // automatically and hands the new credentials back here so you can persist
    // them — otherwise they are lost when the process restarts.
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

## Token lifecycle

TikTok issues short-lived credentials, which is the main operational difference
from most other chat platforms:

| Credential | Lifetime | Behavior |
|---|---|---|
| Access token | 24 hours | Refreshed automatically before expiry |
| Refresh token | 1 year, **rotates on every refresh** | Requires the operator to re-authorize once it expires |

The refresh token changes every time it is used. If you do not persist the new
value from `onTokenRefresh`, the old one stops working and the connection can
only be recovered by completing OAuth again.

When the refresh token expires or is revoked, the adapter throws an
`AuthenticationError`. Treat this as "the connection needs re-authorization"
rather than a transient failure — retrying will not fix it.

## Limitations

These come from the TikTok platform, not from this adapter:

- **You cannot start a conversation.** Every conversation begins with the user,
  a tiktok.me link, or a Click-to-Message ad. There is no "open a DM" API.
- **48-hour messaging windows.** For non-mutual-follow conversations: up to 10
  messages in the 48 hours after the user's first message; unlimited messages
  for 48 hours after each subsequent user reply; and at most 3 further messages
  once 48 hours have passed without a reply.
- **Not available in the EEA, Switzerland, or the UK.** Accounts registered in
  those regions cannot use the Business Messaging API.
- **No comment webhook.** You cannot trigger a DM from a comment on an organic
  post.
- **1:1 conversations only.** There are no group threads.
- **Text only in this release.** Image attachments are planned for v0.2. Rich
  content (cards, buttons, markdown) is flattened to readable plain text, and
  inbound images, stickers, and videos arrive as a visible placeholder such as
  `[image]` rather than as empty text.
- **Reactions, edits, and deletes are unsupported** by the platform API. Chat
  SDK requires these methods on every adapter, so they are present but throw
  `NotImplementedError` rather than failing silently.

Typing indicators and read receipts *are* supported, through TikTok's
`SENDER_ACTION` message type — `startTyping()` and `markAsRead()` both work.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Tests mock all HTTP, so no TikTok credentials are needed to run them.

## License

Apache-2.0
