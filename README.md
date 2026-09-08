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
| `custom_pages` | Raw HTML pages authored from the admin panel, served back at `/page/<slug>` |

## Routes

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/api/layout` | GET | none | Public — returns the current box layout |
| `/api/layout` | POST | `X-Edit-Key` | Saves a new layout |
| `/api/config` | GET | none | Public — returns trigger words + on/off state + custom redirects |
| `/api/config` | POST | `X-Edit-Key` | Saves config. Admin's trigger/enabled fields are force-overwritten server-side no matter what's submitted (see below) |
| `/api/chat` | GET | none | Public — returns chat history |
| `/api/chat` | POST | **none, by design** | Anyone who reaches the chat page can post. See security notes |
| `/api/chat/clear` | POST | `X-Edit-Key` | Wipes all chat messages |
| `/api/pages` | GET | none | Public — returns the list of custom pages |
| `/api/pages` | POST | `X-Edit-Key` | Saves/replaces the custom pages array. Slugs may be nested (`test/about-us`) |
| `/page/<slug>` | GET | none | Serves a stored custom page's raw HTML |

All `POST` routes except `/api/chat` require an `X-Edit-Key` header matching the `EDIT_PASSWORD` secret set below.

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

`/api/chat`'s `POST` route has **no password check at all**, on purpose — anyone who reaches the chat page should be able to post. Worth knowing:

- No rate limiting. Someone could script requests directly to `/api/chat`, bypassing the page's UI entirely, and flood it. Message count is capped at 200 (oldest drop off) and name/message length are capped, which bounds *storage* growth but doesn't stop spam from filling that window.
- No moderation or profanity filtering.
- If you want real protection: [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) in front of the POST, or a [Durable Object](https://developers.cloudflare.com/durable-objects/) for per-IP rate limiting. Both are meaningfully more setup than what's here, and intentionally left out to keep this deployable in one pass.

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
