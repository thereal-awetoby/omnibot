// Verifies the `initData` string a Telegram Mini App sends with every request, so the dashboard API knows
// who is calling without a login step. Pure crypto, no network: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
import crypto from 'node:crypto';

const MAX_AGE_MS = 24 * 3_600_000; // Telegram's own guidance: reject stale initData (replay protection)

// botToken -> the HMAC key Telegram uses to sign initData (cached per token; there is only ever one in a process).
const secretCache = new Map();
function secretKeyFor(botToken) {
  let k = secretCache.get(botToken);
  if (!k) { k = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest(); secretCache.set(botToken, k); }
  return k;
}

// initData: the raw query string from Telegram.WebApp.initData. botToken: this bot's token.
// Returns { ok: true, user } or { ok: false, reason }. user = { id, username, firstName } (Telegram's own `user` field).
export function verifyInitData(initData, botToken, now = Date.now()) {
  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'missing initData' };
  if (!botToken) return { ok: false, reason: 'bot token not configured' };
  let params;
  try { params = new URLSearchParams(initData); } catch { return { ok: false, reason: 'unparseable initData' }; }
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };
  params.delete('hash');
  const pairs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const checkString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const computed = crypto.createHmac('sha256', secretKeyFor(botToken)).update(checkString).digest('hex');
  // timing-safe compare (both are hex strings of the same length)
  const same = computed.length === hash.length && crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  if (!same) return { ok: false, reason: 'bad signature' };
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!authDate || now - authDate > MAX_AGE_MS || authDate > now + 60_000) return { ok: false, reason: 'expired' };
  let user = null;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      const u = JSON.parse(rawUser);
      if (u && typeof u.id !== 'undefined') user = { id: String(u.id), username: u.username ?? null, firstName: u.first_name ?? null };
    } catch { /* leave user null */ }
  }
  if (!user) return { ok: false, reason: 'no user in initData' };
  return { ok: true, user };
}
