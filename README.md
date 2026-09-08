# oliverbar.net-api

A tiny [Cloudflare Worker](https://workers.dev) + [KV](https://developers.cloudflare.com/kv/) backend for [oliverbar.net](https://github.com/skhshths/oliverbar.net) — a static site with hidden, keyword-triggered pages. This Worker is what lets that site's state (trigger words, on/off toggles, box layout, chat, self-serve pages) be shared with **every visitor**, instead of being stuck in each visitor's own browser (`localStorage`).

It's currently deployed behind `api.oliverbar.net` (JSON endpoints) and `pages.oliverbar.net` (served custom-page HTML) — two custom domains routed to the same Worker, purely so links copied out of the admin panel read as content pages rather than API calls.

No database, no SQL — everything here is a handful of JSON blobs in Workers KV, which is the right tool for exactly that.

## What it stores

| Key in KV | Purpose |
|---|---|
| `layout` | The interactive page's draggable box layout |
| `site_config` | The four built-in pages' trigger words / enabled state, plus custom redirects |
| `chat_messages` | The global chat's message history (capped at 200) |
| `chat_names` | Claimed chat display names — hashed+salted PIN per name, never the PIN itself |
| `chat_session:<token>` | A logged-in chat identity, valid for 7 days — see below |
| `dm_messages:<pairKey>` | One conversation's full message history (capped at 300), keyed by both participants' names, sorted |
| `dm_threads:<lowerName>` | One person's DM inbox — their conversation partners with a preview of the latest message each |
| `custom_pages` | Raw HTML pages authored from the admin panel, served back at `/page/<slug>` |
| `page_token:<token>` | Short-lived (60s), single-use tokens minted right before navigating to a `/page/<slug>` — see below |
| `trigger_stats` | Usage counts per trigger word, for the admin panel's Experimental tab |
| `presence:<id>` | One key per open tab, expiring after 30s — a rough "how many people right now" count |

## Routes

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/layout` | GET | none | Public — returns the current box layout |
| `/api/layout` | POST | `X-Edit-Key` | Saves a new layout |
| `/api/config` | GET | none | Public — returns trigger words + on/off state + custom redirects |
| `/api/config` | POST | `X-Edit-Key` | Saves config. Admin's trigger/enabled fields are force-overwritten server-side no matter what's submitted (see below) |
| `/api/chat/login` | POST | none | Claims a name (first use) or verifies its PIN (later uses), returns a session token — see below |
| `/api/chat/session` | GET | `X-Chat-Session` | Checks whether a saved session token is still valid, and who it belongs to |
| `/api/chat` | GET | none | Public — returns global chat history |
| `/api/chat` | POST | `X-Chat-Session` | Posts to global chat as whoever the session belongs to |
| `/api/dm/send` | POST | `X-Chat-Session` | Sends a direct message |
| `/api/dm/threads` | GET | `X-Chat-Session` | Lists the logged-in user's DM conversations with a preview of each |
| `/api/dm/messages` | GET | `X-Chat-Session` | Full message history with one specific person (`?with=<name>`) |
| `/api/chat/names` | GET | `X-Edit-Key` | Admin-only — lists every claimed name and when it was claimed (never the PIN) |
| `/api/chat/names/release` | POST | `X-Edit-Key` | Admin-only — frees a claimed name so it can be claimed fresh |
| `/api/chat/clear` | POST | `X-Edit-Key` | Wipes all global chat messages (DMs are untouched) |
| `/api/pages` | GET | none | Public — returns the list of custom pages |
| `/api/pages` | POST | `X-Edit-Key` | Saves/replaces the custom pages array. Slugs may be nested (`test/about-us`) |
| `/api/pages/token` | POST | none | Mints a short-lived, single-use token for viewing `/page/<slug>` — see below |
| `/api/stats/trigger` | POST | none | Fire-and-forget — increments a trigger's usage counter |
| `/api/stats/trigger` | GET | `X-Edit-Key` | Admin-only — returns usage counts per trigger |
| `/api/presence/ping` | POST | none | Marks a tab as "here" for 30 seconds |
| `/api/presence/count` | GET | `X-Edit-Key` | Admin-only — how many tabs pinged in the last 30 seconds |
| `/page/<slug>` | GET | token | Serves a stored custom page's raw HTML — only with a valid `?t=` token, see below |

All routes marked `X-Edit-Key` require that header to match the `EDIT_PASSWORD` secret set below. Routes marked `X-Chat-Session` require that header to hold a valid token from `/api/chat/login` — see below.

## How `/page/<slug>` is locked down

`pages.oliverbar.net` is a different origin than `oliverbar.net`, so the sessionStorage guard the built-in hidden pages use (set a flag before navigating, consume it on load) can't reach it — a browser won't share sessionStorage across origins. Instead:

1. Right before navigating to a custom page, the site calls `POST /api/pages/token` with the target `slug`. The Worker mints a random token, stores `page_token:<token> → {slug}` in KV with a 60-second TTL, and hands the token back.
2. The site appends it as `?t=<token>` and navigates.
3. `GET /page/<slug>` requires that token: missing, expired, or minted for a different slug all redirect to `https://oliverbar.net/` instead of serving the page. The token is deleted the moment it's checked, whether or not it was valid — so a reload of the same URL always bounces, same as the built-in pages.

This mirrors the existing sessionStorage guard's actual security level (a casual "don't bookmark or reload into this" gate, not a defense against someone reading the client-side source) — see the Security model section below.

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
- The admin panel's Accounts tab lists every claimed name (`GET /api/chat/names`) and can free one up (`POST /api/chat/names/release`) if it needs to change hands.
- This is a lightweight claim system, not a real account system — there's no rate limiting on PIN guesses, and a very short PIN is guessable. It stops casual impersonation, not a determined attacker.
- No rate limiting on posting either way. Someone could script requests directly to `/api/chat` (with a valid session token), bypassing the page's UI entirely, and flood it. Message count is capped at 200 (oldest drop off) and name/message/PIN lengths are capped, which bounds *storage* growth but doesn't stop spam from filling that window.
- No moderation or profanity filtering.
- If you want real protection: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) in front of login, or a [Durable Object](https://developers.cloudflare.com/durable-objects/) for per-IP rate limiting and atomic name claims (the current read-modify-write on `chat_names` has a small race window under simultaneous first-claims). Both are meaningfully more setup than what's here, and intentionally left out to keep this deployable in one pass.

## About direct messages

DMs reuse the same login/session system as global chat, with one key difference: **reading is gated too**. Only the two participants in a conversation can fetch its history.

- `POST /api/dm/send` with `{to, text}` — the sender comes from the session token, never the request body. Conversations are keyed by both participants' names, lowercased and sorted (`dmPairKey`), so it doesn't matter who messaged first.
- Each conversation's messages live in `dm_messages:<pairKey>`, capped at 300 (oldest drop off first), same shape as global chat but with `from` instead of `name`.
- Every send also updates **both** participants' `dm_threads:<lowerName>` entries — a lightweight inbox index (partner name + last message preview + timestamp) so `GET /api/dm/threads` can render a conversation list without fetching every thread's full history. This is what backs the sidebar in the chat page's UI.
- `GET /api/dm/messages?with=<name>` returns one conversation's full history for the logged-in user — this is the "log in and see your history" part.
- There's no delete/edit, no read receipts beyond the client-side unread dot (computed locally from `localStorage`, not synced anywhere), and no admin visibility into DM content by design — the Accounts tab shows *who* has claimed a name, never what they've said to anyone. If you want the admin to be able to moderate DMs later, that's a deliberate addition to make, not an oversight.

## About the experimental features

Two small, low-stakes additions that back the admin panel's Experimental tab:

- **Trigger usage stats** — `index.html` fires a fire-and-forget `POST /api/stats/trigger` every time a trigger word matches. Purely a curiosity counter (which pages get used most); nothing else reads it, and the write side has no auth since it's just a counter increment.
- **Live presence** — `index.html` quietly pings `POST /api/presence/ping` every 20 seconds with a random per-tab id, no UI change. Each ping is a KV key with a 30-second TTL, so `GET /api/presence/count` (admin-only) is "how many tabs pinged recently" — a fun, rough number, not precise analytics. `KV.list()` is capped at 1000 keys for this, plenty for a personal site.

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
