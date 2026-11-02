// Jacob's Ladder push worker — runs free on Cloudflare Workers
// Cron every 5 min: sees races starting within ~10 min, wakes every
// subscribed phone with a payload-less push. The phone's service worker
// then fetches the day's selections and shows the notification with the
// owner's own stake (stored on-device in IndexedDB).

const APP_URL = "https://jobsaboba.github.io/jacobs-ladder"; // Pages site URL
const WINDOW_MIN = 11;   // announce races starting within the next N minutes
const TTL = 3600;        // push TTL seconds

// ---------- VAPID (ES256 via WebCrypto) ----------
function b64uToBuf(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = new TextEncoder();

async function vapidAuthHeader(origin, jwk, subject) {
  const header = { typ: "JWT", alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
  const payload = { aud: origin, sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 };
  const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = b64u(header) + "." + b64u(payload);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  const sigB64u = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // k = uncompressed public point
  const x = b64uToBuf(jwk.x), y = b64uToBuf(jwk.y);
  const pub = new Uint8Array(65); pub[0] = 4; pub.set(new Uint8Array(x), 1); pub.set(new Uint8Array(y), 33);
  const pubB64u = btoa(String.fromCharCode(...pub)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `vapid t=${unsigned}.${sigB64u}, k=${pubB64u}`;
}

async function pushWake(sub, jwk, subject) {
  const origin = new URL(sub.endpoint).origin;
  const headers = {
    TTL: String(TTL),
    Urgency: "high",
    Authorization: await vapidAuthHeader(origin, jwk, subject),
  };
  const res = await fetch(sub.endpoint, { method: "POST", headers, body: new Uint8Array(0) });
  if (res.status === 404 || res.status === 410) throw new Error("gone");
  return res.status;
}

// ---------- UK time offset (BST/GMT) ----------
function ukOffsetMinutes(isoDateOnly) {
  const [y, m, d] = isoDateOnly.split("-").map(Number);
  const day = (yy, mm, dd) => Date.UTC(yy, mm, dd);
  const lastSunday = (monthIndex) => { // 01:00 UTC last Sunday of month
    const last = new Date(day(y, monthIndex + 1, 0));
    const dow = last.getUTCDay();
    return new Date(day(y, monthIndex + 1, last.getUTCDate() - dow));
  };
  const startBST = lastSunday(2).getTime() + 1 * 3600 * 1000; // last Sun March 01:00 UTC
  const endBST = lastSunday(9).getTime() + 1 * 3600 * 1000;   // last Sun Oct 01:00 UTC
  const t = day(y, m - 1, d);
  return t >= startBST && t < endBST ? 60 : 0;
}
function raceDayStartUK(dateStr) { // epoch of UK-midnight for that date
  const off = ukOffsetMinutes(dateStr);
  return Date.parse(dateStr + "T00:00:00Z") - off * 60000;
}
function ukMinutesToday(dateStr, hhmm) { // minutes since UK-midnight
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// ---------- KV helpers ----------
async function getSubs(env) {
  const v = await env.DB.get("subs");
  return v ? JSON.parse(v) : [];
}
async function putSubs(env, subs) { await env.DB.put("subs", JSON.stringify(subs)); }

// ---------- handlers ----------
async function handleSubscribe(request, env) {
  const { sub } = await request.json();
  if (!sub || !sub.endpoint || !sub.keys) return new Response("bad sub", { status: 400 });
  const subs = await getSubs(env);
  const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (i >= 0) subs[i] = { ...subs[i], keys: sub.keys };
  else subs.push({ endpoint: sub.endpoint, keys: sub.keys, added: Date.now() });
  await putSubs(env, subs);
  return new Response("ok");
}
async function handleUnsubscribe(request, env) {
  const { endpoint } = await request.json();
  const subs = await getSubs(env);
  await putSubs(env, subs.filter((s) => s.endpoint !== endpoint));
  return new Response("ok");
}

async function cron(env) {
  const res = await fetch(`${APP_URL}/data/latest.json?ts=${Date.now()}`);
  if (!res.ok) return console.log("no day data yet");
  const day = await res.json();
  const dayStart = raceDayStartUK(day.date);
  const now = Date.now();
  const due = (day.finals || []).filter((f) => {
    const at = dayStart + ukMinutesToday(day.date, f.time) * 60000;
    return at - now >= 0 && at - now <= WINDOW_MIN * 60000;
  });
  if (!due.length) return console.log("nothing due");

  const notifiedKey = "notified:" + day.date;
  const notified = new Set(JSON.parse((await env.DB.get(notifiedKey)) || "[]"));
  const races = due.filter((f) => !notified.has(`${f.course}|${f.time}`));
  if (!races.length) return console.log("already notified");

  let jwk;
  try { jwk = JSON.parse(env.PUSH_PRIVATE_JWK); }
  catch { return console.log("PUSH_PRIVATE_JWK secret missing"); }

  const subs = await getSubs(env);
  const keep = [];
  for (const sub of subs) {
    try { await pushWake(sub, jwk, env.VAPID_SUBJECT || "mailto:dave@example.com"); keep.push(sub); }
    catch (e) { if (String(e.message) !== "gone") keep.push(sub); }
  }
  if (keep.length !== subs.length) await putSubs(env, keep);

  for (const f of races) notified.add(`${f.course}|${f.time}`);
  await env.DB.put(notifiedKey, JSON.stringify([...notified]), { expirationTtl: 60 * 60 * 48 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/subscribe") return handleSubscribe(request, env);
    if (request.method === "POST" && url.pathname === "/unsubscribe") return handleUnsubscribe(request, env);
    if (request.method === "GET" && url.pathname === "/health") return new Response("push worker ok");
    return new Response("Jacob's Ladder push worker", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    await ctx.waitUntil(cron(env).catch((e) => console.log("cron error", e)));
  },
};
