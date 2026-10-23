// Pure helpers for the /create wizard: validation and cost maths. No Telegram, no network.
export const LAMPORTS_PER_SOL = 1_000_000_000;
// Rough network cost of creating a pump.fun token (account rent + fees + priority fee), with a safety margin.
export const CREATE_COST_SOL = 0.03;
export const MAX_DEV_BUY_SOL = 85; // a pump.fun curve graduates at about 85 SOL
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const ok = (value) => ({ ok: true, value });
const bad = (error) => ({ ok: false, error });

export function parseName(text) {
  const v = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (v.length < 1) return bad('Send a name for your token.');
  if (v.length > 32) return bad('That name is too long (32 characters max).');
  return ok(v);
}

export function parseSymbol(text) {
  const v = String(text ?? '').trim().replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(v)) return bad('The ticker must be 1 to 10 letters or numbers, no spaces (example: OMNI).');
  return ok(v);
}

export function parseDescription(text) {
  const v = String(text ?? '').trim();
  if (v.length < 1) return bad('Send a short description.');
  if (v.length > 500) return bad('That is too long (500 characters max).');
  return ok(v);
}

const isSkip = (t) => /^(skip|none|no|-)$/i.test(String(t ?? '').trim());

// kind: 'twitter' | 'telegram' | 'website'. Accepts @name, name or a full link. Returns ok(null) for skip.
export function parseSocial(kind, text) {
  const raw = String(text ?? '').trim();
  if (isSkip(raw) || raw === '') return ok(null);
  if (kind === 'website') {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(url);
      if (!u.hostname.includes('.') || url.length > 200) throw new Error('x');
      return ok(u.toString());
    } catch { return bad('That does not look like a website link. Send it like https://example.com, or tap Skip.'); }
  }
  const host = kind === 'twitter' ? '(?:x|twitter)\\.com' : '(?:t|telegram)\\.me';
  const m = raw.match(new RegExp(`^(?:https?://)?(?:www\\.)?${host}/@?([A-Za-z0-9_]{1,32}(?:/[A-Za-z0-9_]+)*)/?$`, 'i'));
  const handle = m ? m[1] : raw.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,32}(?:\/[A-Za-z0-9_]+)*$/.test(handle)) {
    return bad(`That does not look like a ${kind === 'twitter' ? 'X' : 'Telegram'} link or name. Send it again, or tap Skip.`);
  }
  return ok(kind === 'twitter' ? `https://x.com/${handle}` : `https://t.me/${handle}`);
}

// "0.5", "0,5", "0.5 sol", "0" or "skip" -> lamports (BigInt as number-safe integer).
export function parseDevBuy(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/sol$/, '').trim().replace(',', '.');
  if (isSkip(raw) || raw === '0') return ok(0);
  if (!/^\d+(\.\d{1,9})?$/.test(raw)) return bad('Send an amount in SOL like 0.5, or 0 for no first buy.');
  const sol = Number(raw);
  if (sol > MAX_DEV_BUY_SOL) return bad(`That is more than the maximum (${MAX_DEV_BUY_SOL} SOL).`);
  return ok(Math.round(sol * LAMPORTS_PER_SOL));
}

export const lamportsToSol = (l) => Number(l) / LAMPORTS_PER_SOL;
export const neededLamports = (devBuyLamports) => Math.round(CREATE_COST_SOL * LAMPORTS_PER_SOL) + Number(devBuyLamports);

export function checkImage({ mime, size }) {
  if (!IMAGE_TYPES.includes(mime)) return bad('Send the logo as a picture (JPG, PNG, GIF or WEBP).');
  if (size && size > MAX_IMAGE_BYTES) return bad('That image is too big (5 MB max).');
  return ok(true);
}

export const fmtSol = (sol) => {
  const s = Number(sol);
  return s >= 1 ? s.toFixed(3).replace(/\.?0+$/, '') : s.toFixed(5).replace(/\.?0+$/, '') || '0';
};
