# chat-adapter-tiktok — Design

**Date:** 2026-09-14
**Status:** Approved for implementation (steps 2–6)
**Context:** Evaluating TikTok as an additional messaging channel for a
Chat SDK-based bot platform

## Summary

A community-tier [Chat SDK](https://chat-sdk.dev) adapter for the TikTok Business
Messaging API v1.3, published as `chat-adapter-tiktok`. It bridges TikTok direct
messages into the platform-agnostic Chat SDK `Adapter` interface so that host
applications can treat TikTok like any other channel.

No TikTok adapter exists anywhere today: not in the Chat SDK adapter directory
(official, vendor-official, or community), not on npm, not on GitHub. The one
request for one, [vercel/chat#273](https://github.com/vercel/chat/issues/273),
was closed pending a concrete proposal. The official Business Messaging API,
however, is live and documented, so the gap is implementation effort rather than
platform feasibility.

## Goals

- Implement the Chat SDK `Adapter` contract for TikTok direct messages.
- Handle the OAuth token lifecycle TikTok imposes (24h access token, rotating
  1-year refresh token) without requiring the host to re-authorize daily.
- Verify webhooks fail-closed and process them idempotently.
- Degrade rich content predictably to plain text, since TikTok DMs carry no
  rich formatting.
- Ship unit-tested against mocked HTTP, so the package is complete and
  reviewable before TikTok app credentials are approved.

## Non-goals

- Anything requiring live credentials: end-to-end verification, onboarding
  flows, production Go/No-Go evidence. That is step 1 and is explicitly
  deferred.
- Comment-to-DM automation. TikTok exposes no comment webhook, so this is not
  buildable on the official API.
- Wiring the adapter into a host application's control plane (channel registry,
  catalog, webhook ingress). That is separate downstream work and is out of
  scope for this package.

## Platform constraints

These are properties of TikTok's API, not design choices, and they shape
everything below.

| Constraint | Consequence for the adapter |
|---|---|
| Access token expires in 24h; refresh token in 1 year and **rotates on every use** | Refresh must be automatic, and the rotated refresh token must reach the host or the connection is unrecoverable |
| Errors return **HTTP 200 with a non-zero `code`** | HTTP status is never a success signal; every response body must be inspected |
| Throttling is code `40100`, not HTTP 429 | Rate-limit detection keys on the envelope code |
| 48-hour messaging windows with message caps | Sends outside a window fail permanently — non-retryable, never retried |
| Verified Business Accounts only | Configuration is per business account, not per user |
| Users in the EEA, Switzerland, and the UK emit a stripped `im_receive_msg_eu` event | Such events carry no content or conversation ID and cannot produce a bot reply |
| No comment webhook | Only DM events are ingestible |
| Conversations cannot be initiated by the business | No `openDM`; every thread starts from an inbound event |
| 1:1 conversations only | Thread IDs need no group/room dimension |
| No official JavaScript SDK | The HTTP client is hand-written against the documented contract |
| Auth uses a custom `Access-Token` header | Not `Authorization: Bearer`, despite `token_type: "Bearer"` |

## API surface

Base URL `https://business-api.tiktok.com/open_api/v1.3/`. **Every path ends in
a trailing slash**; omitting it produces a 404.

| Purpose | Method | Path |
|---|---|---|
| Exchange auth code | POST | `/tt_user/oauth2/token/` |
| Refresh token | POST | `/tt_user/oauth2/refresh_token/` |
| Revoke token | POST | `/tt_user/oauth2/revoke/` |
| Inspect token scopes | POST | `/tt_user/token_info/get/` |
| Send message | POST | `/business/message/send/` |
| List conversations | GET | `/business/message/conversation/list/` |
| List messages | GET | `/business/message/content/list/` |
| Upload image | POST | `/business/message/media/upload/` |
| Get media download URL | POST | `/business/message/media/download/` |
| Check conversation capability | GET | `/business/message/capabilities/get/` |
| Business account profile | GET | `/business/get/` |

Conversation listing deserves a note, because the Chat SDK contract and the
platform disagree. `ThreadSummary` requires a `rootMessage`, and TikTok's
conversation list returns identifiers and timestamps with no message content —
so `listThreads` has to fetch each conversation's history, one request per
conversation. Rather than hide that cost or fabricate a placeholder message,
the adapter exposes both: `listConversations` for the cheap single-request
listing, and `listThreads` for hosts that need the SDK shape and accept the
fan-out. The default page size is small for the same reason, and the fetches
run sequentially because TikTok rate-limits per app, so a parallel burst would
trip `40100` on exactly the pages large enough to matter.

TikTok names the application **three different ways** across these endpoints:
`client_key` on the authorize URL, `client_id` on the token, refresh, and
revoke endpoints, and `app_id` on token inspection and webhook configuration.
Token inspection additionally takes no secret at all — the access token alone
identifies the grant. Using the wrong name fails with an unhelpful error, so
each helper pins the right one rather than sharing a generic credential shape.

Four auth schemes coexist, which the HTTP layer must keep straight:

- Messaging endpoints use a custom `Access-Token: <token>` header.
- OAuth endpoints use no header; credentials go in the JSON body, and the
  authorize leg names the app `client_key` while the token leg names it
  `client_id`.
- Webhook-configuration endpoints are app-level: `app_id` and `secret` travel
  as ordinary parameters, with no token at all, and one configuration covers
  every business that has authorized the app.
- Media download URLs use `x-user: <token>` instead of `Access-Token`.

Because three of those four cannot use the authenticated client, the shared
hazards — transport failure, a gateway returning HTML, and a failure reported
as HTTP 200 with a non-zero code — are handled once in `fetchEnvelope`. The
authenticated client routes through it too, passing the `Access-Token` header
as an option, so there is one transport rather than one per auth scheme.

The webhook read is a `GET`, which puts the app secret in a query string where
proxies and access logs capture it. That is TikTok's shape, not a choice, but
it is worth knowing before calling it from somewhere that logs outbound URLs.

### Retrying a throttled request

Throttling is reported as code `40100`, and the client retries it a bounded
number of times with an exponential backoff. The delay is deliberately short:
TikTok's documented recovery is five minutes for a per-minute overage and
midnight UTC for a per-day one, so no realistic in-request wait can rescue a
sustained overage — and blocking a webhook handler for minutes would be worse
than failing. What the retry does cover is a brief burst. Only `40100` is
retried; a validation error would fail identically every time.

Two shape constraints worth noting early, because they limit what the adapter
can offer:

- `/business/message/content/list/` has **no pagination** and returns only the
  20 most recent messages, so `fetchMessages` cannot honor arbitrary paging.
  Its media field names are also unconfirmed, so history builds attachments
  when they are present and stays text-only when they are not — a picture from
  history should not read as bare text while the same message arriving live
  carries a file, but nor should a guessed field name throw.
  This is also why `persistThreadHistory` should be enabled — the platform
  cannot serve history the way Slack can.
- Conversation IDs are base64-like and may contain `+`, which must be
  percent-encoded as `%2B` in query strings or the API rejects them as invalid.

## Prior art

[`chat-adapter-line`](https://github.com/PunGrumpy/chat-adapter-line) is the only
comparable community adapter listed on chat-sdk.dev. This design mirrors its
structure and conventions — module layout, use of `@chat-adapter/shared` error
classes, `node:crypto` for signature verification — because matching an
already-accepted community adapter is the cheapest path to directory listing.

Two deliberate divergences:

1. **Toolchain.** LINE uses `vite-plus` and Bun. This package uses the tsup +
   vitest toolchain from the official adapter-building guide, which is the
   mainstream, better-documented choice.
2. **Token handling.** LINE takes a static, long-lived channel access token and
   needs no refresh logic at all. TikTok's 24-hour expiry makes that approach
   fail silently after a day, so this adapter owns a token manager — the single
   largest structural difference between the two.

## Architecture

```
src/
  index.ts              public exports
  factory.ts            createTikTokAdapter, with env-var fallbacks
  types.ts              config, thread ID, TikTok wire types
  adapter.ts            TikTokAdapter implements Adapter<TikTokThreadId, TikTokRawMessage>
  lib/
    api-client.ts       fetch wrapper: auth header, envelope unwrap, error mapping
    token-manager.ts    access-token lifecycle and refresh
    webhook.ts          signature verification
    bounded-set.ts      dedupe and self-echo tracking, size-capped
    thread-id.ts        encode/decode thread IDs
    format-converter.ts postable content -> plain text
    card-to-text.ts     card flattening, buttons included
    template.ts         card -> native Q&A button card, or null
    oauth.ts            authorize URL and authorization-code exchange
    webhook-config.ts   app-level callback registration
    webhook-router.ts   one endpoint, many per-account adapters
    media.ts            image upload/download and the capability probe
__tests__/              mirrors src/, all HTTP mocked
```

Each module has one responsibility and is independently testable. `adapter.ts`
orchestrates; it holds no HTTP, crypto, or formatting logic of its own.

### Token manager

The component that carries the most risk, and the one with no equivalent in the
LINE adapter.

Responsibilities:

- Cache the access token in memory alongside its expiry timestamp.
- Refresh proactively before expiry rather than reacting to a 401, so a normal
  request never pays for a round-trip failure.
- Deduplicate concurrent refreshes by sharing one in-flight promise, so a burst
  of requests arriving at expiry produces exactly one refresh call.
- Emit refreshed credentials through an `onTokenRefresh` callback and let the
  host persist them. The adapter does not choose a storage backend.
- Distinguish refresh-token expiry from transient refresh failure: the former is
  a permanent `AuthenticationError` meaning "the operator must re-authorize"; the
  latter is retryable.

Chat SDK's `setInstallation`/`getInstallation` installation store was considered
and rejected for v0.1: it ties the package to a host-provided state adapter,
whereas a callback lets any host — including one that keeps credentials in its
own database table — own persistence with no adapter-side assumption. The
installation store remains available as a future addition rather than a
replacement.

### Webhook handling

Verification is fail-closed: any missing, malformed, or mismatched signature
rejects the request before the body is parsed as an event. HMAC comparison uses
a constant-time comparison to avoid leaking signature bytes through timing.

The signature arrives in a `Tiktok-Signature` header shaped `t=<epoch
seconds>,s=<hex>`, where `s` is an HMAC-SHA256 of the string `` `${t}.${rawBody}`
`` keyed by the app secret. Two details matter:

- The HMAC covers the **raw request bytes**. Parsing the JSON and
  re-serializing it will not round-trip, so the raw body must be read before
  anything else touches it.
- The header's parts are matched **by name**, not by position. TikTok's own
  sample indexes them positionally, which breaks if the order ever changes.

The timestamp is then checked against local time, defaulting to a 5-second
tolerance to match TikTok's sample. This is what prevents a captured request
from being replayed later, so the tolerance is configurable but deliberately
tight.

Deduplication is keyed on `message_id`, and a message is recorded as seen only
once dispatch is under way — recording it earlier would mean a message that
never reached the host was nonetheless remembered as delivered, and therefore
unrecoverable even on redelivery.

Direction is not flagged on the payload, and the sharper problem is
`im_send_msg`, which fires for the adapter's *own* API sends. Left
unrecognized, the bot ingests its own replies as new input and answers itself.

Membership of the sent-message set is not sufficient to catch this: the echo
can arrive before the send response that supplies the ID. So an echo is
identified by `from_user.id` matching the configured `business_id` *and*
`message_tag.source` being `API` — a signal available on the first webhook,
with no dependency on ordering. That pairing also keeps the case that must not
be swallowed: a message the business sent from the TikTok app carries source
`APP` or `WEB`, so a human colleague still reaches the bot normally.

Webhooks for every authorized account arrive at one app URL, so an envelope
whose `user_openid` is not the configured `business_id` is refused rather than
processed with this connection's credentials. That check runs before any event
is routed, including referrals — a referral is attribution data, and reporting
another account's under this one's `businessId` would be worse than dropping
it.

### Serving many accounts

One adapter instance serves one business account, and rejecting a foreign
envelope is correct but leaves a platform to route deliveries itself. That is
harder than it looks: a `Request` body can only be read once, so peeking at it
to find the account leaves nothing for the adapter to verify.

`TikTokWebhookRouter` reads the body once, verifies it, and passes the verified
bytes to the owning adapter.

Verifying a second time in the adapter looks like prudence and is a bug. The
signature carries a timestamp checked against a five-second tolerance, and the
router may have spent that budget loading a cold tenant; the second check would
then reject a delivery the first accepted. Because that answer is not 2xx,
TikTok would retry it — down the same slow path, forever. So the adapter
exposes an entry point that accepts an already-verified body, kept out of the
package's exports and documented as requiring the caller to have verified
against the same app secret.

That entry point is only safe because the router refuses an adapter belonging
to a different app: one app secret signs every tenant's deliveries, so an
adapter from a second app could otherwise be handed a body verified against a
secret it does not share. `register()` compares in constant time and throws.
The router also refuses an empty app secret, which `createHmac` would
otherwise accept as a key anyone can guess — the same check the adapter makes,
and the one thing a router built around verification must not skip.

Ordering is the security property. Verification precedes reading the account,
because the account selects the credentials used to reply, and because an
unverified body must not reach a tenant lookup — those are database queries,
and letting an unauthenticated caller aim them at arbitrary account IDs is a
denial-of-service surface. That ordering is not provable by a test that
registers the adapter in advance: the adapter's own verification returns 401
too, masking a router that never checked. The test therefore uses a tenant
reachable only through the resolver, and asserts the resolver was never
consulted.

Two failure modes are answered differently on purpose. An unknown account is
permanent, so it returns 200 and TikTok stops retrying. A resolver that throws
is transient — a database blip — so it returns 503 and the delivery comes
back. Collapsing them would either discard messages or replay them forever.

### Read receipts

`im_mark_read_msg` carries no message of its own, so like a referral it cannot
travel the message path, and Chat SDK has no inbound read-receipt event. It
goes to an `onReadReceipt` callback on the same terms: a host without one gets
a debug line rather than silence, and a handler that throws is logged rather
than surfaced, since a non-2xx answer would make TikTok replay a receipt that
would fail identically.

TikTok emits it only for personal accounts — a business reading its own thread
produces nothing — so the event unambiguously means the other side saw the
message. The timestamp is a high-water mark for the conversation rather than
an acknowledgement of one message.

### Referral attribution

A Click-to-Message ad or tiktok.me link produces `im_referral_msg`, which
carries no `message_id` and no `type` — it announces an arrival rather than a
message, so it cannot travel the message path at all. Chat SDK has no event
for attribution either, so it goes to an `onReferral` callback. A host that
has not configured one gets a debug line rather than silence, since the
arrival is otherwise invisible until the user speaks, and a handler that
throws is logged rather than surfaced: returning non-2xx would make TikTok
replay a referral that would fail identically.

### Reactions, quoting, and stickers

Three inbound and outbound capabilities are shaped by TikTok constraints
rather than by preference.

A **reaction** is not a message, and routing it through `processMessage` would
put a bare `[reaction]` into the conversation while discarding the emoji, the
direction, and the message it applied to. It is dispatched through
`processReaction` instead, one event per entry, since a single payload can
carry several. TikTok sends the emoji character itself and the SDK offers no
reverse lookup from a character to a well-known name, so `emoji` is built from
the character and `rawEmoji` is the value worth comparing against. Reactions
remain receive-only: there is no API to add one, so `addReaction` still throws.

A **quoted reply** requires `message_type: "TEXT"` alongside
`referenced_message_info`, so `reply()` bypasses the template path entirely — a
card is flattened to text rather than sent as a Q&A card — and an image is
rejected outright. Whether the *referenced* message is a legal target is left
to TikTok, since only TikTok knows what that message was.

**Stickers and emoji** arrive as plain URLs rather than media IDs, so they need
neither the download-URL request nor the `x-user` header that images and video
require. They become attachments carrying the URL directly.

All outbound paths funnel through one `send()` helper so the echo-suppression
bookkeeping cannot be forgotten by one of them. Sender actions deliberately sit
outside it: `SENDER_ACTION` legitimately returns an empty message ID, which
`send()` treats as a malformed response.

### Unsupported platform operations

Chat SDK's `Adapter` interface makes `addReaction`, `removeReaction`,
`editMessage`, `deleteMessage`, and `startTyping` **required** members. TikTok
supports only the last of these.

`startTyping` and `markAsRead` map onto TikTok's `SENDER_ACTION` message type
(`TYPING` and `MARK_READ`), so both are genuinely implemented — an earlier
draft of this design wrongly listed typing as unsupported.

The remaining four are implemented as explicit throws of `NotImplementedError`
rather than silent no-ops, so a host that calls them learns immediately that
the capability is absent instead of believing a message was edited or a
reaction recorded. A capability should never be advertised as available until
it has been verified.

### Error classification

Every provider failure maps to one of three outcomes, because the distinction
drives host retry behavior:

Classification keys on the envelope `code`, never the HTTP status:

| Code | Meaning | Mapped to | Retry |
|---|---|---|---|
| `40100` | Requests too frequent | `AdapterRateLimitError` | Yes |
| `51065` | System error | `NetworkError` | Yes |
| `40105` | Invalid access token | triggers one refresh, then `AuthenticationError` | Once |
| `40001` | No permission | `PermissionError` | No |
| `40002` | Parameter error | `ValidationError` | No |
| `40007` | Target does not exist | `ResourceNotFoundError` | No |
| `40064` | Blocked by direct message rules | `ValidationError` | No |
| `40908` | Unsupported file type | `ValidationError` | No |

Refresh-token expiry maps to `AuthenticationError`, distinct from a permission
denial because the operator action differs: someone must complete OAuth again.

One deliberate imprecision: TikTok documents **no** code for exceeding the
48-hour window or a message cap. `40064` is the likeliest carrier, but that is
inference. The adapter therefore classifies `40064` as non-retryable — which is
correct either way — without labeling it "outside the messaging window" in
operator-facing text. Naming it precisely requires observing real traffic,
which is step 1 work.

### Format conversion

TikTok DMs are plain text. Cards, buttons, and markdown from the host must
degrade visibly rather than silently vanish. The converter flattens Chat SDK
postable content to text, rendering interactive affordances as readable text
rather than dropping them.

`cardToFallbackText` from `@chat-adapter/shared` looked like the obvious tool
and turned out to be wrong on two counts:

- It wraps the card title in `*asterisks*`, which platforms rendering mrkdwn
  show as bold and TikTok shows verbatim.
- It renders `actions` as `null`, discarding every button. On a platform that
  cannot draw buttons, that turns "Pick one:" into a question with no visible
  options — precisely the silent loss this section exists to prevent.

Card flattening therefore lives in `lib/card-to-text.ts`, which renders titles
plainly and lists buttons, link buttons, and select options as bulleted
choices. Disabled buttons are omitted rather than listed, since TikTok cannot
convey a disabled state and an unselectable option is worse than an absent one.
Inbound `template` messages are flattened the same way: title first, reply
buttons beneath.

### Cards as native buttons

Flattening is the fallback, not the first choice. TikTok's Q&A button card
carries a question and one to three reply buttons, so a card of that shape is
sent as `message_type: "TEMPLATE"` and renders as real tappable buttons.
`lib/template.ts` performs the conversion and returns `null` whenever anything
would be lost, which sends the card down the text path instead:

- more than three buttons, or none once disabled ones are removed;
- a button label over 40 characters or an ID over 40 — TikTok defines no
  truncation, and shortening a label would change what the user is agreeing to;
- a question over 40 characters, or body prose that a title-only template
  cannot carry;
- link buttons or selects, whose URLs and option lists a template cannot
  express.

TikTok offers two card types, and the choice is made by label length rather
than left to the caller. A button card renders tappable buttons but caps
labels at 20 characters; a link card renders inline text links and allows 40.
Buttons read better, so they are preferred whenever every label fits, and a
label between 21 and 40 characters selects a link card instead of falling back
to plain text — which would otherwise discard every button over one long word.

The send and webhook representations of a template differ, which is worth
stating because it is easy to conflate them: the send request takes a flat
`template.buttons[]` whose label field is `title`, while the webhook nests
`template.elements[].buttons[]` and names that same field `text`.

A tapped button arrives as an ordinary `im_receive_msg` text message whose body
is the button label, accompanied by `reply_source_payload.reply_source_unique_id`
carrying the button ID that was sent. Routing that back as a Chat SDK action
is deferred: the plain-text path already handles the message correctly, and
the action route cannot be verified without live credentials. Button `value`
and `callbackUrl` are consequently not carried through.

Because none of this is verified against a live account, `useTemplates: false`
disables it and restores plain text for every card.

## Testing strategy

Unit tests only, all HTTP mocked. No credentials required, which is what makes
steps 2–6 deliverable ahead of step 1.

Coverage targets the failure modes that matter:

- Signature verification accepts a valid signature and rejects missing,
  malformed, wrong, and stale-timestamp ones, and verifies against raw bytes
  rather than a re-serialized body.
- Duplicate events are ingested exactly once, and an `im_send_msg` echo of the
  adapter's own send is not delivered to the host as inbound.
- Token refresh fires before expiry; concurrent requests trigger exactly one
  refresh; the rotated refresh token reaches `onTokenRefresh`; an expired
  refresh token raises the re-authorization error.
- Inbound and outbound messages convert faithfully in both directions,
  including the lowercase-webhook to uppercase-REST enum boundary.
- A non-zero envelope `code` on an HTTP 200 response is treated as a failure,
  and `40100` is classified retryable while `40064` is not.
- An `im_receive_msg_eu` event does not produce a message, since it carries no
  content or conversation ID.

Contract accuracy against the live API is explicitly *not* proven by these
tests. Wire-level types are written from TikTok's published documentation and
cross-checked against Chatwoot's working open-source implementation; any field
that cannot be confirmed from a primary source is marked as unconfirmed in the
code rather than guessed. Live verification is step 1 work.

## Delivery order

Steps are numbered as in the parent investigation.

| Step | Content | Status |
|---|---|---|
| 1 | TikTok developer app, API approval, test accounts | Deferred — blocked on external approval |
| 2 | Package scaffold | Done |
| 3 | `types.ts` | Done |
| 4 | OAuth and token manager | Done, both legs: `lib/oauth.ts` builds the authorize URL and exchanges the code, and the token manager owns the refresh cycle |
| 5 | `TikTokAdapter` class | Done |
| 6 | Format converter | Done, including native Q&A button cards |
| 7 | README, publish, directory listing | README done; publishing and the directory listing pending |

Beyond the original plan, the adapter now also covers conversation listing,
account profile, images, native Q&A button cards, quoted replies, inbound
reactions, sticker and emoji attachments, post sharing, webhook configuration,
referral attribution, throttle backoff, and the full OAuth lifecycle including
revocation and scope inspection.

Steps 2–6 have no dependency on step 1. They produce a complete, tested package
whose only unverified surface is wire-format fidelity.

## Deferred scope

- **Installation store.** See Token manager above.
- **Host integration.** Registering the adapter inside a particular application
  is separate work, tracked wherever that application lives.

## Risks

- **Wire-format drift.** Types derived from documentation may not match
  production payloads. Mitigated by cross-checking a working implementation and
  by marking unconfirmed fields; resolved only by step 1. Specifically still
  unconfirmed: which code signals a messaging-window violation, the full
  response shape of `/business/message/content/list/`, and whether any error
  ever arrives with a non-200 HTTP status.
- **Approval timeline.** TikTok app review is the critical path to any
  end-to-end evidence, and it is outside our control.
- **Product gate.** A platform may reasonably decline to support a channel that
  has no published adapter to build on. Releasing this adapter to the community
  directory changes that calculus — it makes TikTok a channel that *has* an
  adapter — but that argument should be made explicitly rather than assumed.
