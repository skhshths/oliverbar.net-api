# oliverbar.net-api

A tiny [Cloudflare Worker](https://workers.dev) + [KV](https://developers.cloudflare.com/kv/) backend for [oliverbar.net](https://github.com/skhshths/oliverbar.net) — a static site with hidden, keyword-triggered pages. This Worker is what lets that site's state (trigger words, on/off toggles, box layout, chat, self-serve pages) be shared with **every visitor**, instead of being stuck in each visitor's own browser (`localStorage`).

It's currently deployed behind `api.oliverbar.net` (JSON endpoints) and `pages.oliverbar.net` (served custom-page HTML) — two custom domains routed to the same Worker, purely so links copied out of the admin panel read as content pages rather than API calls.

No database, no SQL — everything here is a handful of JSON blobs in Workers KV, which is the right tool for exactly that.

## What it stores

| Key in KV | Purpose |
|---|---|
| `layout` | The interactive page's draggable box layout |
| `site_config` | The four built-in pages' trigger words / enabled state, plus custom redirects |
| `chat_messages` | The global chat's message history (capped at 200), each with an `id`, `reactions`, and `edited`/`deleted` flags |
| `chat_pinned` | Snapshots of pinned global chat messages |
| `chat_names` | Claimed chat display names — hashed+salted PIN, avatar, status, and a `blocked` list per name (never the PIN itself) |
| `chat_session:<token>` | A logged-in chat identity, valid for 7 days — see below |
| `chat_presence:<lowerName>` | One key per logged-in name currently active, expiring after 30s — backs the "online now" badge |
| `typing:global:<lowerName>` / `typing:dm:<convId>:<lowerName>` | "Still typing" flags, expiring after 5s |
| `dm_conversations:<convId>` | A conversation's participant list (2 or more people) |
| `dm_messages:<convId>` | One conversation's full message history (capped at 300) |
| `dm_threads:<lowerName>` | One person's DM inbox — their conversations with a preview of the latest message each |
| `dm_read:<convId>:<lowerName>` | When a participant last read a conversation — backs read receipts |
| `last_seen:<lowerName>` | Last activity timestamp per name, never expires — backs "last seen 5m ago" once `chat_presence` has expired |
| `lifetime_stats` | Running totals (messages, DMs, accounts) that survive the capped arrays above rolling old entries off — backs the admin Dashboard |
| `custom_pages` | Raw HTML pages authored from the admin panel, served back at `/page/<slug>` |
| `page_token:<token>` | Short-lived (60s), single-use tokens minted right before navigating to a `/page/<slug>` — see below |
| `guest_pass:<token>` | Multi-use, admin-created, time-boxed access to one Custom Page — see below |
| `secret_note:<id>` | An unread burn-after-reading note, deleted the moment it's viewed |
| `trigger_stats` | Usage counts per trigger word, for the admin panel's Experimental tab and Dashboard |
| `presence:<id>` | One key per open tab, expiring after 30s — a rough "how many people right now" count (anonymous, unrelated to `chat_presence`) |

## Routes

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/layout` | GET | none | Public — returns the current box layout |
| `/api/layout` | POST | `X-Edit-Key` | Saves a new layout |
| `/api/config` | GET | none | Public — returns trigger words + on/off state + custom redirects |
| `/api/config` | POST | `X-Edit-Key` | Saves config. Admin's trigger/enabled fields are force-overwritten server-side no matter what's submitted (see below) |
| `/api/chat/login` | POST | none | Claims a name (first use) or verifies its PIN (later uses), returns a session token — see below |
| `/api/chat/session` | GET | `X-Chat-Session` | Checks whether a saved session token is still valid, and who it belongs to |
| `/api/chat/change-pin` | POST | `X-Chat-Session` | Self-service — sets a new PIN for your own name |
| `/api/chat/release-me` | POST | `X-Chat-Session` | Self-service — deletes your own account, freeing the name |
| `/api/chat/profile` | GET | `X-Chat-Session` | Batch-fetches avatar + status for `?names=a,b,c` |
| `/api/chat/profile` | POST | `X-Chat-Session` | Sets your own avatar + status |
| `/api/chat/block` / `/api/chat/unblock` | POST | `X-Chat-Session` | Add/remove a name from your own block list |
| `/api/chat/blocks` | GET | `X-Chat-Session` | Your own block list |
| `/api/chat/presence` | POST | `X-Chat-Session` | Marks your name "online" for 30 seconds |
| `/api/chat/presence` | GET | `X-Chat-Session` | For `?names=a,b,c`, returns `{name: {online, lastSeen}}` |
| `/api/typing` | POST | `X-Chat-Session` | Marks you as typing in global chat or one DM (`{scope, convId}`), expires in 5s |
| `/api/typing` | GET | `X-Chat-Session` | Who's currently typing in a given scope |
| `/api/chat` | GET | none | Public — returns global chat history |
| `/api/chat` | POST | `X-Chat-Session` | Posts to global chat as whoever the session belongs to |
| `/api/chat/edit` / `/api/chat/delete` | POST | `X-Chat-Session` | Edit or soft-delete your own global chat message |
| `/api/chat/react` | POST | `X-Chat-Session` | Toggle your own emoji reaction on a global chat message |
| `/api/chat/pinned` | GET | none | Public — currently pinned global chat messages |
| `/api/chat/pin` / `/api/chat/unpin` | POST | `X-Edit-Key` | Admin-only — pin/unpin a global chat message |
| `/api/dm/start` | POST | `X-Chat-Session` | Finds or creates a conversation with 1+ other people (`{participants: [names]}`) |
| `/api/dm/send` | POST | `X-Chat-Session` | Sends a message into a conversation (`{convId, text}`) |
| `/api/dm/threads` | GET | `X-Chat-Session` | Lists the logged-in user's conversations with a preview of each |
| `/api/dm/messages` | GET | `X-Chat-Session` | Full history + read receipts for one conversation (`?convId=`) |
| `/api/dm/edit` / `/api/dm/delete` | POST | `X-Chat-Session` | Edit or soft-delete your own message in a conversation |
| `/api/dm/react` | POST | `X-Chat-Session` | Toggle your own emoji reaction on a DM |
| `/api/dm/read` | POST | `X-Chat-Session` | Marks a conversation read up to now, for read receipts |
| `/api/chat/names` | GET | `X-Edit-Key` | Admin-only — lists every claimed name, avatar, status, and when claimed (never the PIN) |
| `/api/chat/names/release` | POST | `X-Edit-Key` | Admin-only — frees a claimed name so it can be claimed fresh |
| `/api/chat/clear` | POST | `X-Edit-Key` | Wipes all global chat messages and pins (DMs are untouched) |
| `/api/admin/dashboard` | GET | `X-Edit-Key` | Admin-only — aggregated totals for the Dashboard tab |
| `/api/admin/export` | GET | `X-Edit-Key` | Admin-only — downloads `{config, pages}` as one backup |
| `/api/admin/import` | POST | `X-Edit-Key` | Admin-only — restores `{config, pages}` from a backup, overwriting both |
| `/api/admin/kv` | GET | `X-Edit-Key` | Admin-only — lists the allowlisted keys the raw KV inspector can read |
| `/api/admin/kv/value` | GET | `X-Edit-Key` | Admin-only — raw value of one allowlisted key (`?key=`) |
| `/api/admin/guest-pass` | POST | `X-Edit-Key` | Admin-only — mints a multi-use, time-boxed pass to one Custom Page (`{slug, minutes}`) |
| `/api/config/disable-custom` | POST | none | Disables one custom redirect by id — called after a one-time trigger fires |
| `/api/pages/random` | GET | none | Picks a random enabled Custom Page slug — backs "random page" triggers |
| `/api/notes/create` | POST | `X-Edit-Key` | Admin-only — creates a burn-after-reading note, returns its id |
| `/api/pages` | GET | none | Public — returns the list of custom pages |
| `/api/pages` | POST | `X-Edit-Key` | Saves/replaces the custom pages array. Slugs may be nested (`test/about-us`) |
| `/api/pages/token` | POST | none | Mints a short-lived, single-use token for viewing `/page/<slug>` — see below |
| `/api/stats/trigger` | POST | none | Fire-and-forget — increments a trigger's usage counter |
| `/api/stats/trigger` | GET | `X-Edit-Key` | Admin-only — returns usage counts per trigger |
| `/api/presence/ping` | POST | none | Marks a tab as "here" for 30 seconds |
| `/api/presence/count` | GET | `X-Edit-Key` | Admin-only — how many tabs pinged in the last 30 seconds |
| `/page/<slug>` | GET | `?t=` or `?g=` | Serves a stored custom page's raw HTML — a single-use token or a valid guest pass, see below |
| `/secret/<id>` | GET | none | Serves and immediately deletes a burn-after-reading note |

All routes marked `X-Edit-Key` require that header to match the `EDIT_PASSWORD` secret set below. Routes marked `X-Chat-Session` require that header to hold a valid token from `/api/chat/login` — see below.

## How `/page/<slug>` is locked down

`pages.oliverbar.net` is a different origin than `oliverbar.net`, so the sessionStorage guard the built-in hidden pages use (set a flag before navigating, consume it on load) can't reach it — a browser won't share sessionStorage across origins. Instead:

1. Right before navigating to a custom page, the site calls `POST /api/pages/token` with the target `slug`. The Worker mints a random token, stores `page_token:<token> → {slug}` in KV with a 60-second TTL, and hands the token back.
2. The site appends it as `?t=<token>` and navigates.
3. `GET /page/<slug>` requires that token: missing, expired, or minted for a different slug all redirect to `https://oliverbar.net/` instead of serving the page. The token is deleted the moment it's checked, whether or not it was valid — so a reload of the same URL always bounces, same as the built-in pages.

This mirrors the existing sessionStorage guard's actual security level (a casual "don't bookmark or reload into this" gate, not a defense against someone reading the client-side source) — see the Security model section below.

### Guest passes: the multi-use variant

Single-use tokens are the right shape for "the visitor already knows the trigger word." They're the wrong shape for "share this page with someone who doesn't." `POST /api/admin/guest-pass` (admin-only) mints a `guest_pass:<token> → {slug}` with a TTL you choose (1 minute to 24 hours) — checked, but **never deleted**, on every `GET /page/<slug>?g=<token>` until it expires on its own. That's the whole difference from the `?t=` flow: a guest pass is meant to be reused by whoever has the link, for as long as its window is open.

## Trigger mechanics: aliases, one-time, scheduled, random

Custom redirects (in `site_config.custom`) support a few optional fields beyond `trigger`/`destination`/`enabled`, all validated leniently (missing = old behavior, exactly as before these existed):

- `aliases: string[]` — up to 5 extra trigger words that all lead to the same place.
- `oneTime: boolean` — once matched, `index.html` calls `POST /api/config/disable-custom` with the redirect's id, which sets `enabled: false` server-side. No auth needed: reaching that call already required typing the trigger word, the same trust level as the usage-counter ping.
- `activeFrom` / `activeUntil` — epoch-millisecond bounds; outside that window, the redirect is treated as if `enabled: false`. Checked client-side in `index.html`'s `checkTriggers()`.
- `random: boolean` — ignores `destination` entirely; on match, the client calls `GET /api/pages/random` for a random Custom Page slug and navigates there through the normal token flow instead.

## Backup, restore, and the raw KV inspector

Three small admin-only tools, all in the Dashboard/Experimental tabs:

- **Backup/restore** (`GET /api/admin/export`, `POST /api/admin/import`) round-trips `{config, pages}` — the trigger config and Custom Pages — as one JSON file. Deliberately excludes chat/DM data; this is a config backup, not a data export. Import re-applies the same admin-lockout backstop as a normal config save (admin's trigger/enabled can't come back wrong from a backup either).
- **Raw KV inspector** (`GET /api/admin/kv`, `GET /api/admin/kv/value?key=`) reads directly from KV for debugging, but only keys on a hardcoded allowlist (`KV_INSPECTOR_ALLOWLIST` in `index.js`): `site_config`, `custom_pages`, `chat_messages`, `chat_pinned`, `trigger_stats`, `lifetime_stats`, `layout`. Everything DM-, session-, token-, or PIN-related is deliberately excluded — the point of the allowlist is that even the admin password can't turn into a way to read someone's private messages.
- **Burn-after-reading notes** (`POST /api/notes/create`, `GET /secret/<id>`) are admin-created (not a public feature — otherwise this Worker would double as a free anonymous paste bin for anyone). Reading one deletes it immediately, so the link only ever works once, for whoever opens it first. Unread notes expire after 30 days regardless.

## Why the admin trigger can never be locked out

Earlier iterations let the `admin` entry's trigger word and enabled flag be edited like any other — which meant it was possible to accidentally disable or rename your way out of the one page that lets you undo it. Now the Worker hard-codes `admin`'s trigger as `"ADMIN"` and forces `enabled: true` on every `/api/config` save, regardless of what's submitted. The front-end also grays this row out, but this is the actual backstop — enforced server-side, not just hidden in the UI.

## Prerequisites

- [Node.js](https://nodejs.org) (any recent LTS)
- A Cloudflare account (free tier is fine)

## Setup

1. **Clone this repo** and open a terminal inside it.

2. **Install dependencies** (this installs Wrangler, Cloudflare's CLI):
   ```
   npm install
   ```

3. **Log in to Cloudflare:**
   ```
   npx wrangler login
   ```

4. **Create your own KV namespace** (only needed if you're standing up a separate instance rather than deploying to the existing `x92-layout-api` Worker this repo is already wired to):
   ```
   npx wrangler kv namespace create LAYOUT_KV
   ```
   This prints an `id` — paste it into `wrangler.jsonc` in place of the existing one.

5. **Set the edit password as a secret** (kept out of source, unlike the front-end's client-side password check):
   ```
   npx wrangler secret put EDIT_PASSWORD
   ```
   Use the same password the site's editor/admin pages expect — see [oliverbar.net](https://github.com/skhshths/oliverbar.net).

6. **Deploy:**
   ```
   npx wrangler deploy
   ```
   Wrangler prints your Worker's `*.workers.dev` URL. If you're pointing custom domains at it (like `api.oliverbar.net` / `pages.oliverbar.net` here), add those under **Cloudflare dashboard → Worker → Settings → Domains & Routes → Add → Custom Domain**. This also runs automatically on every push to `main` if the repo is connected via Cloudflare's Git integration (Workers Builds).

7. **Wire it up to the site** — paste the Worker's URL (or custom domain) into the `API_BASE` constant near the top of every page in the site repo that has one: `index.html`, the admin page, the interactive page, and the chat page. Re-upload to Cloudflare Pages.

## About the "custom pages" feature

The admin panel's Custom Pages section lets you paste raw HTML, stored in KV and served directly by this Worker at `/page/<slug>` — no Cloudflare Pages deployment needed. This deliberately avoids ever putting a real Cloudflare API token in browser JavaScript: a token with permission to deploy to your Pages project would let anyone who reads the page source redeploy the entire site, which is a far bigger risk than anything else here. Serving stored HTML from the Worker sidesteps that: the write is gated by `EDIT_PASSWORD`, the read is public by design (the point is for visitors to see the page).

Slugs may be nested (`test`, `test/about-us`, `test/about-us/team`, ...) — one or more lowercase/number/dash segments separated by slashes, validated both client-side and again here server-side.

## About the chat feature

There's still **no admin password** involved in chatting — anyone who reaches the chat page can log in and post. What logging in means:

- `POST /api/chat/login` with `{name, pin}`. The first time a given name (case-insensitive) is used, that call **claims** it: the PIN is hashed (PBKDF2-SHA256, random per-name salt, via the Workers runtime's Web Crypto support) and stored in `chat_names`. The raw PIN is never stored or logged. Every later login under that name must supply the matching PIN, or the request is rejected with 401.
- A successful login returns a session token (`chat_session:<token>`, valid 7 days) instead of requiring the PIN again on every message. Posting to global chat and everything DM-related reads the display name from this token, never from anything the client claims in the request body — so nobody can post or DM as a name they haven't logged into. Messages always render with the exact casing the name was first claimed with, so `bob` and `Bob` can't be used to blur who's who.
- `GET /api/chat/session` lets the site silently check whether a token it already has (e.g. saved in `localStorage` from a previous visit) is still good, which is what makes "log back in and see your history" work without re-entering a PIN every time within that week.
- The admin panel's Accounts tab lists every claimed name (`GET /api/chat/names`) and can free one up (`POST /api/chat/names/release`) if it needs to change hands. Anyone can also do this to themselves via `POST /api/chat/release-me`, and change their own PIN via `POST /api/chat/change-pin` without knowing the old one (the session itself is proof enough).
- Each account also carries a self-service **avatar** (a short emoji, `GET`/`POST /api/chat/profile`) and **status line** (max 40 characters, same endpoint), both freely visible to anyone logged in — think of them as public, not secrets.
- **Blocking** (`POST /api/chat/block` / `/unblock`, `GET /api/chat/blocks`) is per-account and enforced server-side for 1:1 conversations: if someone has blocked you, `/api/dm/start` and `/api/dm/send` both refuse outright. It isn't enforced for group conversations (3+ people) — a deliberate scope cut, documented as a limitation rather than silently half-working. Global chat isn't filtered server-side either; the block list is just exposed for the chat page to filter its own rendering.
- **Typing indicators** (`POST`/`GET /api/typing`) work via a KV key per identity with a few seconds' TTL, refreshed by a client-side ping loop — not meant to be precise, "as of the last few seconds."
- **Presence** (`POST`/`GET /api/chat/presence`) now returns `{online, lastSeen}` per name instead of a bare boolean: `online` comes from the same short-TTL heartbeat as before, `lastSeen` comes from `last_seen:<lowerName>` (touched on login, posting, and every presence ping), which never expires — so the chat page can show "online" or "last seen 5m ago" once the heartbeat itself has lapsed.
- Every account also tracks a lifetime **`messageCount`** (global + DM combined), returned from `/api/chat/profile` and the admin's `/api/chat/names` — the chat page derives simple achievement badges from it client-side (nothing server-enforced, just a threshold check).
- **Edit and delete** (`POST /api/chat/edit` / `/api/chat/delete`) only work on your own messages (checked server-side against the session name, not just hidden client-side). Delete is a soft tombstone — the message stays in the array with `deleted: true` and `text: null` so the conversation doesn't jump around, and reactions are cleared.
- **Reactions** (`POST /api/chat/react`) toggle: react again with the same emoji to remove it. Stored inline on the message as `reactions: { "👍": ["Alice", "Bob"] }`.
- **Pinned messages** (`GET /api/chat/pinned`, `POST /api/chat/pin` / `/unpin`) are admin-only to set — gated by `X-Edit-Key`, same as everything else the admin password protects — but public to read, since the point is for every visitor to see them.
- This is still a lightweight claim system, not a real account system — there's no rate limiting on PIN guesses, and a very short PIN is guessable. It stops casual impersonation, not a determined attacker.
- No rate limiting on posting either way. Someone could script requests directly to `/api/chat` (with a valid session token), bypassing the page's UI entirely, and flood it. Message count is capped at 200 (oldest drop off) and name/message/PIN lengths are capped, which bounds *storage* growth but doesn't stop spam from filling that window.
- No moderation or profanity filtering.
- If you want real protection: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) in front of login, or a [Durable Object](https://developers.cloudflare.com/durable-objects/) for per-IP rate limiting and atomic name claims (the current read-modify-write on `chat_names` has a small race window under simultaneous first-claims). Both are meaningfully more setup than what's here, and intentionally left out to keep this deployable in one pass.

## About direct messages

DMs reuse the same login/session system as global chat, with two key differences: **reading is gated** (only a conversation's participants can fetch its history), and conversations can have **more than two people**.

- `POST /api/dm/start` with `{participants: [names]}` finds an existing conversation with exactly that set of people (self included, compared case-insensitively regardless of order) or creates a new one, storing `dm_conversations:<convId> → {participants, createdAt}`. This is what makes group chats and 1:1s the same underlying concept — a 1:1 is just a 2-person conversation.
- `POST /api/dm/send` with `{convId, text}` — the sender comes from the session token, never the request body, and the Worker checks the sender is actually a participant before accepting. Messages live in `dm_messages:<convId>`, capped at 300, same shape as global chat (`id`, `text`, `ts`, `reactions`, `edited`/`deleted`) but with `from` instead of `name`.
- Every send updates **every** participant's `dm_threads:<lowerName>` inbox index (conversation id, participant list, last message preview) so `GET /api/dm/threads` can render a conversation list without fetching every conversation's full history.
- `GET /api/dm/messages?convId=<id>` returns `{messages, participants, reads}` for the logged-in user — the messages, the full participant list, and everyone's last-read timestamp (see read receipts below). This is the "log in and see your history" part.
- **Read receipts**: `POST /api/dm/read` records a per-participant last-read timestamp for a conversation (`dm_read:<convId>:<lowerName>`). The chat page shows "Seen" under your own last message once every other participant's last-read timestamp is at or past it — for a group, that means everyone, not just one person.
- Edit/delete/react work the same as global chat (`/api/dm/edit`, `/api/dm/delete`, `/api/dm/react`), scoped to the conversation and checked against the session name.
- There's still no admin visibility into DM content by design — the Accounts tab shows *who* has claimed a name, never what they've said to anyone. If you want the admin to be able to moderate DMs later, that's a deliberate addition to make, not an oversight.
- Groups are capped at 12 people (`MAX_GROUP_PARTICIPANTS`) — an arbitrary but generous limit for a personal project, easy to raise in `index.js` if you need more.

## About the experimental features and the Dashboard

A few small, low-stakes additions:

- **Trigger usage stats** — `index.html` fires a fire-and-forget `POST /api/stats/trigger` every time a trigger word matches. Purely a curiosity counter (which pages get used most); the write side has no auth since it's just a counter increment.
- **Live presence** — `index.html` quietly pings `POST /api/presence/ping` every 20 seconds with a random per-tab id, no UI change. Each ping is a KV key with a 30-second TTL, so `GET /api/presence/count` (admin-only) is "how many tabs pinged recently" — a fun, rough number, not precise analytics. `KV.list()` is capped at 1000 keys for this, plenty for a personal site. (This is separate from `chat_presence`, which tracks logged-in identities rather than anonymous tabs.)
- **The Dashboard tab** (`GET /api/admin/dashboard`) rolls several of the above into one call: lifetime message/DM counts (from `lifetime_stats`, which isn't affected by the capped message arrays rolling old entries off), total claimed accounts, the single most-used trigger, and the live presence count. It's the new default landing tab in the admin panel.

## Security model, and its limits

- Reads are intentionally public — visitors need to see current state.
- Writes require the `X-Edit-Key` header to match the `EDIT_PASSWORD` secret. The front-end sends this automatically once you've unlocked the editor/admin page with the password.
- This is a reasonable gate for a personal/hobby project, not bank-grade security: the password travels in a plain HTTP header (mitigated by Cloudflare's automatic HTTPS, but visible to anyone with access to the requesting browser), and there's no rate-limiting on guessing it. Don't put anything truly sensitive behind this.
- `Access-Control-Allow-Origin: "*"` is left open so it works regardless of your Pages domain. Once you know your final domain, you can tighten this in `index.js` by replacing `"*"` with your exact origin — that stops *other* sites from silently issuing requests to this API using a visitor's browser, though it doesn't change what the password already protects.
- Custom-page HTML is served exactly as submitted, `<script>` tags included. Only the `EDIT_PASSWORD` holder can create one, consistent with this project's trust model — but there's no sandboxing of what a custom page can do once visited.

## Updating

Any time you edit `index.js` or `wrangler.jsonc`, redeploy with:
```
npx wrangler deploy
```
