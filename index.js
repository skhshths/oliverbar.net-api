const ADMIN_TRIGGER_FIXED = "ADMIN"; // permanently fixed, cannot be changed via the admin UI or the API
const ROOT_SITE = "https://oliverbar.net/"; // where /page/<slug> bounces to when there's no valid access token

const DEFAULT_CONFIG = {
  admin:       { label: "Admin",       trigger: ADMIN_TRIGGER_FIXED, enabled: true },
  interactive: { label: "Interactive", trigger: "interactive",       enabled: true },
  portfolio:   { label: "Portfolio",   trigger: "portfolio",         enabled: true },
  chat:        { label: "Chat",        trigger: "chat",              enabled: true },
  custom: [],
};

const MAX_CHAT_MESSAGES = 200;
const MAX_DM_MESSAGES = 300;
const MAX_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 500;
const MIN_PIN_LENGTH = 3;
const MAX_PIN_LENGTH = 32;
const MAX_STATUS_LENGTH = 40;
const MAX_AVATAR_LENGTH = 4;
const MAX_EMOJI_LENGTH = 8;
const MAX_GROUP_PARTICIPANTS = 12;
const PBKDF2_ITERATIONS = 100000;

const PAGE_TOKEN_TTL_SECONDS = 60; // how long a minted /page/ access token stays valid if unused
const PRESENCE_TTL_SECONDS = 30; // an anonymous site-wide presence ping counts as "here" for this long
const CHAT_PRESENCE_TTL_SECONDS = 30; // same idea, but tied to a logged-in name for the "online now" badge
const TYPING_TTL_SECONDS = 5; // how long a "still typing" flag lasts without a fresh ping
const CHAT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // how long a chat login stays valid

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// PIN hashing for the chat "claim a name" system — PBKDF2 with a random
// per-name salt, via the Workers runtime's built-in Web Crypto support.
// Nothing here is stronger than the rest of this project's "casual, not
// bank-grade" security model, but it does mean the PIN itself is never
// stored or logged in the clear.
async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(pin), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

// Generic JSON KV helpers — used by the newer routes below to cut down
// on repeating the same get/parse/fallback dance everywhere.
async function getJSON(env, key, fallback) {
  const stored = await env.LAYOUT_KV.get(key);
  if (!stored) return fallback;
  try { return JSON.parse(stored); } catch (e) { return fallback; }
}
async function putJSON(env, key, value, opts) {
  await env.LAYOUT_KV.put(key, JSON.stringify(value), opts || {});
}

// Looks up (or claims) a name against the in-memory `names` map — the
// caller is responsible for loading it from KV first and saving it back
// afterward. Mutates `names` in place when claiming a brand-new name.
// Returns `claimed: true` on a fresh claim, so callers can track totals.
async function claimOrVerifyName(names, rawName, pin) {
  const key = rawName.toLowerCase();
  if (names[key]) {
    const candidateHash = await hashPin(pin, names[key].saltHex);
    if (candidateHash !== names[key].hashHex) {
      return { ok: false, error: "That name is already claimed — wrong PIN." };
    }
    // Always the casing the name was first claimed with, so "Bob" and
    // "bob" can't be used to blur who's who.
    return { ok: true, name: names[key].name };
  }
  const saltHex = randomHex(16);
  const hashHex = await hashPin(pin, saltHex);
  names[key] = {
    name: rawName, saltHex: saltHex, hashHex: hashHex, createdAt: Date.now(),
    avatar: "", status: "", blocked: [],
  };
  return { ok: true, name: rawName, claimed: true };
}

// Resolves the logged-in chat display name from the X-Chat-Session
// header, minted by /api/chat/login. Used to gate posting to global
// chat and everything DM-related — reading global chat stays public.
async function getSessionName(request, env) {
  const token = request.headers.get("X-Chat-Session") || "";
  if (!token) return null;
  const stored = await env.LAYOUT_KV.get("chat_session:" + token);
  if (!stored) return null;
  try {
    const data = JSON.parse(stored);
    return data && typeof data.name === "string" ? data.name : null;
  } catch (e) {
    return null;
  }
}

// A stable way to compare two participant lists regardless of order or
// casing — used to find an existing conversation instead of creating a
// duplicate every time the same group messages each other.
function participantSetKey(names) {
  return names.map(function (n) { return n.toLowerCase(); }).sort().join(",");
}

// Updates `ownerName`'s DM inbox with a fresh preview of `conversation`.
async function upsertThread(env, ownerName, conversation, message) {
  const key = "dm_threads:" + ownerName.toLowerCase();
  const threads = await getJSON(env, key, []);
  const existing = threads.find(function (t) { return t.convId === conversation.id; });
  if (existing) {
    existing.participants = conversation.participants;
    existing.lastTs = message.ts;
    existing.lastText = message.deleted ? null : message.text;
    existing.lastFrom = message.from;
  } else {
    threads.push({
      convId: conversation.id,
      participants: conversation.participants,
      lastTs: message.ts,
      lastText: message.deleted ? null : message.text,
      lastFrom: message.from,
    });
  }
  await putJSON(env, key, threads);
}

async function bumpLifetimeStat(env, field) {
  const stats = await getJSON(env, "lifetime_stats", {});
  stats[field] = (stats[field] || 0) + 1;
  await putJSON(env, "lifetime_stats", stats);
}

async function loadNames(env) {
  return getJSON(env, "chat_names", {});
}
async function saveNames(env, names) {
  await putJSON(env, "chat_names", names);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Edit-Key, X-Chat-Session",
    };

    // Shorthand for the newer routes below — captures corsHeaders so
    // each route body doesn't have to repeat the same response shape.
    function respond(data, status) {
      return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    async function readBody(request) {
      try {
        const text = await request.text();
        return { ok: true, data: JSON.parse(text) };
      } catch (e) {
        return { ok: false };
      }
    }
    function requireSession(name) {
      return name ? null : respond({ error: "Not logged in" }, 401);
    }
    function requireEditKey(request) {
      const editKey = request.headers.get("X-Edit-Key") || "";
      return editKey === env.EDIT_PASSWORD ? null : respond({ error: "Unauthorized" }, 401);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ---------- Box layout (the "interactive" page's canvas) ----------
    if (url.pathname === "/api/layout" && request.method === "GET") {
      const stored = await env.LAYOUT_KV.get("layout");
      return new Response(stored || "[]", {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/layout" && request.method === "POST") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body;
      try {
        body = await request.text();
        JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await env.LAYOUT_KV.put("layout", body);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Site config: fixed pages + custom redirects ----------
    if (url.pathname === "/api/config" && request.method === "GET") {
      const stored = await env.LAYOUT_KV.get("site_config");
      return new Response(stored || JSON.stringify(DEFAULT_CONFIG), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/config" && request.method === "POST") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body, parsed;
      try {
        body = await request.text();
        parsed = JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const requiredKeys = ["admin", "interactive", "portfolio", "chat"];
      const fixedValid = requiredKeys.every(function (k) {
        return (
          parsed[k] &&
          typeof parsed[k].trigger === "string" &&
          parsed[k].trigger.length > 0 &&
          typeof parsed[k].enabled === "boolean"
        );
      });
      if (!fixedValid) {
        return new Response(JSON.stringify({ error: "Malformed config" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (parsed.custom !== undefined) {
        if (!Array.isArray(parsed.custom)) {
          return new Response(JSON.stringify({ error: "custom must be an array" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
        const customValid = parsed.custom.every(function (item) {
          return (
            item &&
            typeof item.id === "string" && item.id.length > 0 &&
            typeof item.trigger === "string" && item.trigger.length > 0 &&
            typeof item.destination === "string" && item.destination.length > 0 &&
            typeof item.enabled === "boolean"
          );
        });
        if (!customValid) {
          return new Response(JSON.stringify({ error: "Malformed custom entry" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      } else {
        parsed.custom = [];
      }

      // Hard safety rules, enforced here regardless of what the client
      // sent: admin can never be disabled, and its trigger word can
      // never be anything other than the fixed value. This is what
      // actually guarantees it — the admin UI also locks both of
      // these visually, but this is the real backstop.
      parsed.admin.enabled = true;
      parsed.admin.trigger = ADMIN_TRIGGER_FIXED;

      await env.LAYOUT_KV.put("site_config", JSON.stringify(parsed));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Chat login (claims a name on first use) ----------
    // The one place a name+PIN pair is ever checked. A successful login
    // mints a session token good for a week, which is what every other
    // chat/DM route below expects in the X-Chat-Session header — so a
    // login persisted client-side (e.g. localStorage) is what gives
    // "log back in and see your history" behavior.
    if (url.pathname === "/api/chat/login" && request.method === "POST") {
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const parsed = body.data;

      const rawName = typeof parsed.name === "string" ? parsed.name.trim().slice(0, MAX_NAME_LENGTH) : "";
      const pin = typeof parsed.pin === "string" ? parsed.pin : "";

      if (!rawName) return respond({ error: "name is required" }, 400);
      if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
        return respond({ error: "PIN must be " + MIN_PIN_LENGTH + "-" + MAX_PIN_LENGTH + " characters" }, 400);
      }

      const names = await loadNames(env);
      const result = await claimOrVerifyName(names, rawName, pin);
      if (!result.ok) return respond({ error: result.error }, 401);
      await saveNames(env, names);
      if (result.claimed) await bumpLifetimeStat(env, "totalAccountsCreated");

      const token = crypto.randomUUID();
      await putJSON(env, "chat_session:" + token, { name: result.name }, { expirationTtl: CHAT_SESSION_TTL_SECONDS });

      return respond({ token: token, name: result.name });
    }

    // Lets the site quietly check whether a session token it already
    // has (e.g. saved in localStorage from a previous visit) is still
    // good, without re-prompting for a PIN.
    if (url.pathname === "/api/chat/session" && request.method === "GET") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      return respond({ name: name });
    }

    // ---------- Chat profile: avatar + status line ----------
    // Both are freely visible (like the display name itself) — anyone
    // logged in can look up anyone else's, but only the session owner
    // can change their own.
    if (url.pathname === "/api/chat/profile" && request.method === "GET") {
      const requester = await getSessionName(request, env);
      const guard = requireSession(requester);
      if (guard) return guard;
      const namesParam = url.searchParams.get("names") || "";
      const requested = namesParam.split(",").map(function (n) { return n.trim(); }).filter(Boolean);
      if (!requested.length) return respond({ error: "names is required" }, 400);
      const names = await loadNames(env);
      const result = {};
      requested.forEach(function (n) {
        const rec = names[n.toLowerCase()];
        result[n] = rec ? { name: rec.name, avatar: rec.avatar || "", status: rec.status || "" } : null;
      });
      return respond(result);
    }

    if (url.pathname === "/api/chat/profile" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);

      const avatar = typeof body.data.avatar === "string" ? body.data.avatar.trim().slice(0, MAX_AVATAR_LENGTH) : "";
      const status = typeof body.data.status === "string" ? body.data.status.trim().slice(0, MAX_STATUS_LENGTH) : "";

      const names = await loadNames(env);
      const rec = names[name.toLowerCase()];
      if (!rec) return respond({ error: "Account not found" }, 404);
      rec.avatar = avatar;
      rec.status = status;
      await saveNames(env, names);
      return respond({ ok: true, avatar: avatar, status: status });
    }

    // Self-service PIN change — no need for the old PIN, since holding
    // a valid session already proves you know it.
    if (url.pathname === "/api/chat/change-pin" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const newPin = typeof body.data.newPin === "string" ? body.data.newPin : "";
      if (newPin.length < MIN_PIN_LENGTH || newPin.length > MAX_PIN_LENGTH) {
        return respond({ error: "PIN must be " + MIN_PIN_LENGTH + "-" + MAX_PIN_LENGTH + " characters" }, 400);
      }
      const names = await loadNames(env);
      const rec = names[name.toLowerCase()];
      if (!rec) return respond({ error: "Account not found" }, 404);
      const saltHex = randomHex(16);
      rec.saltHex = saltHex;
      rec.hashHex = await hashPin(newPin, saltHex);
      await saveNames(env, names);
      return respond({ ok: true });
    }

    // Self-service "delete my account" — frees the name (anyone can
    // claim it fresh afterward) and kills the current session. Old
    // messages keep the name as a plain string, same as if an admin
    // had released it.
    if (url.pathname === "/api/chat/release-me" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const names = await loadNames(env);
      delete names[name.toLowerCase()];
      await saveNames(env, names);
      const token = request.headers.get("X-Chat-Session") || "";
      if (token) await env.LAYOUT_KV.delete("chat_session:" + token);
      return respond({ ok: true });
    }

    // ---------- Blocking ----------
    // A block is enforced server-side for 1:1 DMs (see /api/dm/send and
    // /api/dm/start): if the recipient has blocked the sender, the
    // message/conversation is refused outright. Global chat isn't
    // filtered server-side — the chat page hides blocked names' global
    // messages client-side instead, using this same list.
    if (url.pathname === "/api/chat/block" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const target = typeof body.data.name === "string" ? body.data.name.trim() : "";
      if (!target) return respond({ error: "name is required" }, 400);
      const names = await loadNames(env);
      const rec = names[name.toLowerCase()];
      if (!rec) return respond({ error: "Account not found" }, 404);
      if (!rec.blocked) rec.blocked = [];
      const key = target.toLowerCase();
      if (rec.blocked.indexOf(key) === -1) rec.blocked.push(key);
      await saveNames(env, names);
      return respond({ ok: true });
    }

    if (url.pathname === "/api/chat/unblock" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const target = typeof body.data.name === "string" ? body.data.name.trim().toLowerCase() : "";
      const names = await loadNames(env);
      const rec = names[name.toLowerCase()];
      if (rec && rec.blocked) rec.blocked = rec.blocked.filter(function (n) { return n !== target; });
      await saveNames(env, names);
      return respond({ ok: true });
    }

    if (url.pathname === "/api/chat/blocks" && request.method === "GET") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const names = await loadNames(env);
      const rec = names[name.toLowerCase()];
      return respond(rec && rec.blocked ? rec.blocked : []);
    }

    // ---------- Typing indicators ----------
    if (url.pathname === "/api/typing" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const scope = body.data.scope === "dm" ? "dm" : "global";
      const convId = typeof body.data.convId === "string" ? body.data.convId : "";
      if (scope === "dm" && !convId) return respond({ error: "convId is required for dm scope" }, 400);
      const key = scope === "global"
        ? "typing:global:" + name.toLowerCase()
        : "typing:dm:" + convId + ":" + name.toLowerCase();
      await env.LAYOUT_KV.put(key, name, { expirationTtl: TYPING_TTL_SECONDS });
      return respond({ ok: true });
    }

    if (url.pathname === "/api/typing" && request.method === "GET") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const scope = url.searchParams.get("scope") === "dm" ? "dm" : "global";
      const convId = url.searchParams.get("convId") || "";
      if (scope === "dm" && !convId) return respond({ error: "convId is required for dm scope" }, 400);
      const prefix = scope === "global" ? "typing:global:" : "typing:dm:" + convId + ":";
      const listed = await env.LAYOUT_KV.list({ prefix: prefix, limit: 50 });
      const values = await Promise.all(listed.keys.map(function (k) { return env.LAYOUT_KV.get(k.name); }));
      const typers = values.filter(function (v) { return v && v.toLowerCase() !== name.toLowerCase(); });
      return respond(typers);
    }

    // ---------- Chat presence ("online now" badge on a name) ----------
    // Separate from the anonymous /api/presence/* pair below, which
    // counts open tabs, not identities.
    if (url.pathname === "/api/chat/presence" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      await env.LAYOUT_KV.put("chat_presence:" + name.toLowerCase(), "1", { expirationTtl: CHAT_PRESENCE_TTL_SECONDS });
      return respond({ ok: true });
    }

    if (url.pathname === "/api/chat/presence" && request.method === "GET") {
      const requester = await getSessionName(request, env);
      const guard = requireSession(requester);
      if (guard) return guard;
      const namesParam = url.searchParams.get("names") || "";
      const requested = namesParam.split(",").map(function (n) { return n.trim(); }).filter(Boolean);
      const result = {};
      await Promise.all(requested.map(async function (n) {
        const stored = await env.LAYOUT_KV.get("chat_presence:" + n.toLowerCase());
        result[n] = !!stored;
      }));
      return respond(result);
    }

    // ---------- Global chat ----------
    // Reading is public. Posting requires a logged-in session (see
    // /api/chat/login above) — the display name comes from the
    // session, never from the request body, so nobody can post under a
    // name they haven't proven they own.
    if (url.pathname === "/api/chat" && request.method === "GET") {
      const stored = await env.LAYOUT_KV.get("chat_messages");
      return new Response(stored || "[]", {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;

      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);

      const text = typeof body.data.text === "string" ? body.data.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (!text) return respond({ error: "text is required" }, 400);

      const messages = await getJSON(env, "chat_messages", []);
      const message = { id: randomHex(6), name: name, text: text, ts: Date.now(), reactions: {} };
      messages.push(message);
      const trimmed = messages.length > MAX_CHAT_MESSAGES ? messages.slice(messages.length - MAX_CHAT_MESSAGES) : messages;
      await putJSON(env, "chat_messages", trimmed);
      await bumpLifetimeStat(env, "totalGlobalMessages");
      return respond({ ok: true, name: name, id: message.id });
    }

    // Edit/delete your own global chat message. Deletion is a soft
    // tombstone (text cleared, deleted:true kept) rather than removing
    // the entry, so the conversation doesn't visibly jump around.
    if (url.pathname === "/api/chat/edit" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      const text = typeof body.data.text === "string" ? body.data.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (!messageId || !text) return respond({ error: "messageId and text are required" }, 400);

      const messages = await getJSON(env, "chat_messages", []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg) return respond({ error: "Message not found" }, 404);
      if (msg.name !== name) return respond({ error: "Not your message" }, 403);
      if (msg.deleted) return respond({ error: "Message was deleted" }, 400);
      msg.text = text;
      msg.edited = true;
      await putJSON(env, "chat_messages", messages);
      return respond({ ok: true });
    }

    if (url.pathname === "/api/chat/delete" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      if (!messageId) return respond({ error: "messageId is required" }, 400);

      const messages = await getJSON(env, "chat_messages", []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg) return respond({ error: "Message not found" }, 404);
      if (msg.name !== name) return respond({ error: "Not your message" }, 403);
      msg.text = null;
      msg.deleted = true;
      msg.reactions = {};
      await putJSON(env, "chat_messages", messages);
      return respond({ ok: true });
    }

    // Toggle your own reaction on a global chat message.
    if (url.pathname === "/api/chat/react" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      const emoji = typeof body.data.emoji === "string" ? body.data.emoji.trim().slice(0, MAX_EMOJI_LENGTH) : "";
      if (!messageId || !emoji) return respond({ error: "messageId and emoji are required" }, 400);

      const messages = await getJSON(env, "chat_messages", []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg || msg.deleted) return respond({ error: "Message not found" }, 404);
      if (!msg.reactions) msg.reactions = {};
      const list = msg.reactions[emoji] || [];
      const idx = list.indexOf(name);
      if (idx === -1) list.push(name); else list.splice(idx, 1);
      if (list.length) msg.reactions[emoji] = list; else delete msg.reactions[emoji];
      await putJSON(env, "chat_messages", messages);
      return respond({ ok: true, reactions: msg.reactions });
    }

    // ---------- Pinned global chat messages (admin-only to set) ----------
    if (url.pathname === "/api/chat/pinned" && request.method === "GET") {
      const pinned = await getJSON(env, "chat_pinned", []);
      return respond(pinned);
    }

    if (url.pathname === "/api/chat/pin" && request.method === "POST") {
      const guard = requireEditKey(request);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      const messages = await getJSON(env, "chat_messages", []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg || msg.deleted) return respond({ error: "Message not found" }, 404);
      const pinned = await getJSON(env, "chat_pinned", []);
      if (!pinned.find(function (p) { return p.id === msg.id; })) {
        pinned.push({ id: msg.id, name: msg.name, text: msg.text, ts: msg.ts, pinnedAt: Date.now() });
        await putJSON(env, "chat_pinned", pinned);
      }
      return respond({ ok: true });
    }

    if (url.pathname === "/api/chat/unpin" && request.method === "POST") {
      const guard = requireEditKey(request);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      const pinned = await getJSON(env, "chat_pinned", []);
      await putJSON(env, "chat_pinned", pinned.filter(function (p) { return p.id !== messageId; }));
      return respond({ ok: true });
    }

    // ---------- Direct messages ----------
    // Session-authenticated. Unlike global chat, reading is gated too —
    // only a conversation's participants can see it. Conversations
    // support 2+ participants (group DMs); 1:1 conversations are found
    // and reused rather than duplicated, by comparing participant sets.
    if (url.pathname === "/api/dm/start" && request.method === "POST") {
      const fromName = await getSessionName(request, env);
      const guard = requireSession(fromName);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const requested = Array.isArray(body.data.participants) ? body.data.participants : [];
      const others = requested
        .map(function (n) { return typeof n === "string" ? n.trim().slice(0, MAX_NAME_LENGTH) : ""; })
        .filter(function (n) { return n && n.toLowerCase() !== fromName.toLowerCase(); });
      const uniqueOthers = [];
      const seen = {};
      others.forEach(function (n) {
        const key = n.toLowerCase();
        if (!seen[key]) { seen[key] = true; uniqueOthers.push(n); }
      });
      if (!uniqueOthers.length) return respond({ error: "Need at least one other person" }, 400);
      if (uniqueOthers.length + 1 > MAX_GROUP_PARTICIPANTS) {
        return respond({ error: "Groups are capped at " + MAX_GROUP_PARTICIPANTS + " people" }, 400);
      }

      // Canonicalize casing for anyone who's already claimed their name.
      const names = await loadNames(env);
      const canonical = function (n) {
        const rec = names[n.toLowerCase()];
        return rec ? rec.name : n;
      };
      const participants = [fromName].concat(uniqueOthers).map(canonical);
      const setKey = participantSetKey(participants);

      // 1:1 block check: if the sole other participant has blocked us,
      // refuse to even start the conversation.
      if (participants.length === 2) {
        const otherRec = names[uniqueOthers[0].toLowerCase()];
        if (otherRec && otherRec.blocked && otherRec.blocked.indexOf(fromName.toLowerCase()) !== -1) {
          return respond({ error: "This person isn't accepting messages from you" }, 403);
        }
      }

      const myThreads = await getJSON(env, "dm_threads:" + fromName.toLowerCase(), []);
      const existing = myThreads.find(function (t) { return participantSetKey(t.participants) === setKey; });
      if (existing) return respond({ convId: existing.convId, participants: existing.participants });

      const convId = randomHex(8);
      await putJSON(env, "dm_conversations:" + convId, { id: convId, participants: participants, createdAt: Date.now() });
      return respond({ convId: convId, participants: participants });
    }

    if (url.pathname === "/api/dm/send" && request.method === "POST") {
      const fromName = await getSessionName(request, env);
      const guard = requireSession(fromName);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const convId = typeof body.data.convId === "string" ? body.data.convId : "";
      const text = typeof body.data.text === "string" ? body.data.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (!convId || !text) return respond({ error: "convId and text are required" }, 400);

      const conversation = await getJSON(env, "dm_conversations:" + convId, null);
      if (!conversation) return respond({ error: "Conversation not found" }, 404);
      if (conversation.participants.map(function (p) { return p.toLowerCase(); }).indexOf(fromName.toLowerCase()) === -1) {
        return respond({ error: "Not a participant in this conversation" }, 403);
      }

      // 1:1 block check at send time too, in case blocking happened
      // after the conversation already existed.
      if (conversation.participants.length === 2) {
        const otherName = conversation.participants.find(function (p) { return p.toLowerCase() !== fromName.toLowerCase(); });
        const names = await loadNames(env);
        const otherRec = names[(otherName || "").toLowerCase()];
        if (otherRec && otherRec.blocked && otherRec.blocked.indexOf(fromName.toLowerCase()) !== -1) {
          return respond({ error: "This person isn't accepting messages from you" }, 403);
        }
      }

      const messages = await getJSON(env, "dm_messages:" + convId, []);
      const message = { id: randomHex(6), from: fromName, text: text, ts: Date.now(), reactions: {} };
      messages.push(message);
      const trimmed = messages.length > MAX_DM_MESSAGES ? messages.slice(messages.length - MAX_DM_MESSAGES) : messages;
      await putJSON(env, "dm_messages:" + convId, trimmed);
      await bumpLifetimeStat(env, "totalDmMessages");

      await Promise.all(conversation.participants.map(function (p) { return upsertThread(env, p, conversation, message); }));

      return respond({ ok: true, id: message.id });
    }

    // Lists the logged-in user's DM conversations, most recent first —
    // each with the participant list and a preview of the last message,
    // so the inbox can render without fetching every thread.
    if (url.pathname === "/api/dm/threads" && request.method === "GET") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const threads = await getJSON(env, "dm_threads:" + name.toLowerCase(), []);
      threads.sort(function (a, b) { return b.lastTs - a.lastTs; });
      return respond(threads);
    }

    // Full message history for one conversation — this is the "log in
    // and see your history, like iMessage" part. Also returns each
    // participant's last-read timestamp, for read receipts.
    if (url.pathname === "/api/dm/messages" && request.method === "GET") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const convId = url.searchParams.get("convId") || "";
      if (!convId) return respond({ error: "convId is required" }, 400);

      const conversation = await getJSON(env, "dm_conversations:" + convId, null);
      if (!conversation || conversation.participants.map(function (p) { return p.toLowerCase(); }).indexOf(name.toLowerCase()) === -1) {
        return respond({ error: "Conversation not found" }, 404);
      }

      const messages = await getJSON(env, "dm_messages:" + convId, []);
      const reads = {};
      await Promise.all(conversation.participants.map(async function (p) {
        const ts = await env.LAYOUT_KV.get("dm_read:" + convId + ":" + p.toLowerCase());
        reads[p] = ts ? Number(ts) : 0;
      }));
      return respond({ messages: messages, participants: conversation.participants, reads: reads });
    }

    if (url.pathname === "/api/dm/edit" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const convId = typeof body.data.convId === "string" ? body.data.convId : "";
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      const text = typeof body.data.text === "string" ? body.data.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
      if (!convId || !messageId || !text) return respond({ error: "convId, messageId and text are required" }, 400);

      const messages = await getJSON(env, "dm_messages:" + convId, []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg) return respond({ error: "Message not found" }, 404);
      if (msg.from !== name) return respond({ error: "Not your message" }, 403);
      if (msg.deleted) return respond({ error: "Message was deleted" }, 400);
      msg.text = text;
      msg.edited = true;
      await putJSON(env, "dm_messages:" + convId, messages);
      return respond({ ok: true });
    }

    if (url.pathname === "/api/dm/delete" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const convId = typeof body.data.convId === "string" ? body.data.convId : "";
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      if (!convId || !messageId) return respond({ error: "convId and messageId are required" }, 400);

      const messages = await getJSON(env, "dm_messages:" + convId, []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg) return respond({ error: "Message not found" }, 404);
      if (msg.from !== name) return respond({ error: "Not your message" }, 403);
      msg.text = null;
      msg.deleted = true;
      msg.reactions = {};
      await putJSON(env, "dm_messages:" + convId, messages);
      return respond({ ok: true });
    }

    if (url.pathname === "/api/dm/react" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const convId = typeof body.data.convId === "string" ? body.data.convId : "";
      const messageId = typeof body.data.messageId === "string" ? body.data.messageId : "";
      const emoji = typeof body.data.emoji === "string" ? body.data.emoji.trim().slice(0, MAX_EMOJI_LENGTH) : "";
      if (!convId || !messageId || !emoji) return respond({ error: "convId, messageId and emoji are required" }, 400);

      const conversation = await getJSON(env, "dm_conversations:" + convId, null);
      if (!conversation || conversation.participants.map(function (p) { return p.toLowerCase(); }).indexOf(name.toLowerCase()) === -1) {
        return respond({ error: "Conversation not found" }, 404);
      }
      const messages = await getJSON(env, "dm_messages:" + convId, []);
      const msg = messages.find(function (m) { return m.id === messageId; });
      if (!msg || msg.deleted) return respond({ error: "Message not found" }, 404);
      if (!msg.reactions) msg.reactions = {};
      const list = msg.reactions[emoji] || [];
      const idx = list.indexOf(name);
      if (idx === -1) list.push(name); else list.splice(idx, 1);
      if (list.length) msg.reactions[emoji] = list; else delete msg.reactions[emoji];
      await putJSON(env, "dm_messages:" + convId, messages);
      return respond({ ok: true, reactions: msg.reactions });
    }

    // Marks a conversation as read up to now, for the sender's own read
    // receipt. Other participants see this via the `reads` field
    // returned from GET /api/dm/messages.
    if (url.pathname === "/api/dm/read" && request.method === "POST") {
      const name = await getSessionName(request, env);
      const guard = requireSession(name);
      if (guard) return guard;
      const body = await readBody(request);
      if (!body.ok) return respond({ error: "Invalid JSON" }, 400);
      const convId = typeof body.data.convId === "string" ? body.data.convId : "";
      if (!convId) return respond({ error: "convId is required" }, 400);
      await env.LAYOUT_KV.put("dm_read:" + convId + ":" + name.toLowerCase(), String(Date.now()));
      return respond({ ok: true });
    }

    // ---------- Chat accounts (claimed names) — admin-only view ----------
    if (url.pathname === "/api/chat/names" && request.method === "GET") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const namesStored = await env.LAYOUT_KV.get("chat_names");
      let names = {};
      try { names = namesStored ? JSON.parse(namesStored) : {}; } catch (e) { names = {}; }

      const list = Object.keys(names).map(function (key) {
        return { name: names[key].name, createdAt: names[key].createdAt, avatar: names[key].avatar || "", status: names[key].status || "" };
      }).sort(function (a, b) { return a.createdAt - b.createdAt; });

      return new Response(JSON.stringify(list), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Frees up a claimed name (e.g. someone claimed it maliciously, or
    // the real owner lost their PIN). Next login under that name
    // claims it fresh with a new PIN.
    if (url.pathname === "/api/chat/names/release" && request.method === "POST") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      let body, parsed;
      try {
        body = await request.text();
        parsed = JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const name = typeof parsed.name === "string" ? parsed.name : "";
      if (!name) {
        return new Response(JSON.stringify({ error: "name is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const namesStored = await env.LAYOUT_KV.get("chat_names");
      let names = {};
      try { names = namesStored ? JSON.parse(namesStored) : {}; } catch (e) { names = {}; }
      delete names[name.toLowerCase()];
      await env.LAYOUT_KV.put("chat_names", JSON.stringify(names));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Admin dashboard ----------
    if (url.pathname === "/api/admin/dashboard" && request.method === "GET") {
      const guard = requireEditKey(request);
      if (guard) return guard;
      const [lifetime, names, triggerStats, presenceList] = await Promise.all([
        getJSON(env, "lifetime_stats", {}),
        loadNames(env),
        getJSON(env, "trigger_stats", {}),
        env.LAYOUT_KV.list({ prefix: "presence:", limit: 1000 }),
      ]);
      let topTrigger = null;
      Object.keys(triggerStats).forEach(function (slug) {
        if (!topTrigger || triggerStats[slug] > topTrigger.count) topTrigger = { slug: slug, count: triggerStats[slug] };
      });
      return respond({
        totalGlobalMessages: lifetime.totalGlobalMessages || 0,
        totalDmMessages: lifetime.totalDmMessages || 0,
        totalAccounts: Object.keys(names).length,
        topTrigger: topTrigger,
        liveNow: presenceList.keys.length,
      });
    }

    // ---------- Custom pages (self-serve HTML, no Cloudflare Pages deploy needed) ----------
    if (url.pathname === "/api/pages" && request.method === "GET") {
      const stored = await env.LAYOUT_KV.get("custom_pages");
      return new Response(stored || "[]", {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/pages" && request.method === "POST") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body, parsed;
      try {
        body = await request.text();
        parsed = JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!Array.isArray(parsed)) {
        return new Response(JSON.stringify({ error: "Expected an array of pages" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      // Slug now allows nested paths, e.g. "test" or "test/about-us" —
      // one or more lowercase/number/dash segments separated by slashes,
      // no leading/trailing/double slashes.
      const SLUG_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
      const badEntry = parsed.find(function (p) {
        return !(p && typeof p.slug === "string" && SLUG_RE.test(p.slug) && typeof p.html === "string" && p.html.length > 0);
      });
      if (badEntry) {
        return new Response(JSON.stringify({
          error: "Each page needs a lowercase path using letters, numbers, dashes and slashes, plus an html string",
          badSlug: badEntry && typeof badEntry.slug === "string" ? badEntry.slug : "(missing)"
        }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await env.LAYOUT_KV.put("custom_pages", JSON.stringify(parsed));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Mints a short-lived, single-use token needed to view a custom page
    // at /page/<slug>. Without one, that URL just bounces to the home
    // page — see the /page/ route below. This is what makes those pages
    // unreachable by bookmark/reload, the same way the built-in hidden
    // pages already are via sessionStorage (which can't be used here
    // since pages.oliverbar.net is a different origin than oliverbar.net).
    if (url.pathname === "/api/pages/token" && request.method === "POST") {
      let body, parsed;
      try {
        body = await request.text();
        parsed = JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const slug = typeof parsed.slug === "string" ? parsed.slug : "";
      if (!slug) {
        return new Response(JSON.stringify({ error: "slug is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const token = crypto.randomUUID();
      await env.LAYOUT_KV.put("page_token:" + token, JSON.stringify({ slug: slug }), {
        expirationTtl: PAGE_TOKEN_TTL_SECONDS,
      });

      return new Response(JSON.stringify({ token: token }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Clear chat (admin-only) ----------
    if (url.pathname === "/api/chat/clear" && request.method === "POST") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      await env.LAYOUT_KV.put("chat_messages", "[]");
      await env.LAYOUT_KV.put("chat_pinned", "[]");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Experimental: trigger usage stats ----------
    // Fired (fire-and-forget, no auth) by index.html every time a
    // trigger word successfully matches. Purely a curiosity metric for
    // the admin panel's Experimental tab — nothing reads these back
    // except that page.
    if (url.pathname === "/api/stats/trigger" && request.method === "POST") {
      let body, parsed;
      try {
        body = await request.text();
        parsed = JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const slug = typeof parsed.slug === "string" ? parsed.slug.slice(0, 64) : "";
      if (!slug) {
        return new Response(JSON.stringify({ error: "slug is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const statsStored = await env.LAYOUT_KV.get("trigger_stats");
      let stats = {};
      try { stats = statsStored ? JSON.parse(statsStored) : {}; } catch (e) { stats = {}; }
      stats[slug] = (stats[slug] || 0) + 1;
      await env.LAYOUT_KV.put("trigger_stats", JSON.stringify(stats));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/stats/trigger" && request.method === "GET") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const statsStored = await env.LAYOUT_KV.get("trigger_stats");
      return new Response(statsStored || "{}", {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // ---------- Experimental: live presence ----------
    // index.html pings this quietly in the background while the black
    // screen is open. Each ping is a short-lived KV key, so the count
    // below is "how many tabs pinged in the last 30 seconds" — a rough,
    // fun number, not a precise analytics feature.
    if (url.pathname === "/api/presence/ping" && request.method === "POST") {
      let body, parsed;
      try {
        body = await request.text();
        parsed = JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const id = typeof parsed.id === "string" ? parsed.id.slice(0, 64) : "";
      if (!id) {
        return new Response(JSON.stringify({ error: "id is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      await env.LAYOUT_KV.put("presence:" + id, "1", { expirationTtl: PRESENCE_TTL_SECONDS });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (url.pathname === "/api/presence/count" && request.method === "GET") {
      const editKey = request.headers.get("X-Edit-Key") || "";
      if (editKey !== env.EDIT_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      const listed = await env.LAYOUT_KV.list({ prefix: "presence:", limit: 1000 });
      return new Response(JSON.stringify({ count: listed.keys.length }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Serving a stored custom page directly, e.g. GET /page/my-slug —
    // requires a valid, single-use token minted via /api/pages/token
    // (see above). No token, an expired one, or one minted for a
    // different slug all bounce to the home page instead of the page
    // content, and the token is consumed either way so a reload always
    // bounces too.
    if (url.pathname.startsWith("/page/") && request.method === "GET") {
      const slug = url.pathname.slice("/page/".length);
      const token = url.searchParams.get("t") || "";

      if (!token) {
        return Response.redirect(ROOT_SITE, 302);
      }

      const tokenRecord = await env.LAYOUT_KV.get("page_token:" + token);
      // Single-use regardless of outcome — a second request with the
      // same token (e.g. a reload) must never succeed.
      if (tokenRecord) {
        await env.LAYOUT_KV.delete("page_token:" + token);
      }
      if (!tokenRecord) {
        return Response.redirect(ROOT_SITE, 302);
      }

      let tokenData;
      try { tokenData = JSON.parse(tokenRecord); } catch (e) { tokenData = null; }
      if (!tokenData || tokenData.slug !== slug) {
        return Response.redirect(ROOT_SITE, 302);
      }

      const stored = await env.LAYOUT_KV.get("custom_pages");
      let pages = [];
      try { pages = stored ? JSON.parse(stored) : []; } catch (e) { pages = []; }
      const page = pages.find(function (p) { return p.slug === slug; });
      if (!page) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }
      return new Response(page.html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          ...corsHeaders,
        },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
