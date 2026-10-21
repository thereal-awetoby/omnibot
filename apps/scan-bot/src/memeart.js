import { readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'backgrounds');
const MAX_BYTES = 6_000_000;
// The same picture sources as the first card you loved.
const SUBS = ['CryptoCurrencyMemes', 'cryptomemes', 'SolanaMemes', 'memes', 'dankmemes'];
const STOCK = 16;         // fresh memes kept ready on disk
const MIN_WIDTH = 600;    // smaller memes are skipped
const LEDGER_MAX = 8000;

// jpeg / png / webp by the first bytes of the file; anything else (gif, html) is refused.
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Width and height of a png or jpeg from its first bytes, or null (webp and unknown files are accepted unchecked).
export function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unknown */ }
  return null;
}

const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);

// ---- the ledger: every picture ever shown (or downloaded), so none is ever used twice ----
const ledgers = new Map(); // dir -> { keys:Set, loaded:Promise, timer }
function ledgerFor(dir) {
  let l = ledgers.get(dir);
  if (!l) {
    l = { keys: new Set(), timer: null };
    l.loaded = readFile(join(dir, 'used.json'), 'utf8').then((t) => { for (const k of JSON.parse(t)) l.keys.add(k); }).catch(() => {});
    ledgers.set(dir, l);
  }
  return l;
}
async function remember(dir, ...keys) {
  const l = ledgerFor(dir);
  await l.loaded;
  for (const k of keys) if (k) l.keys.add(k);
  if (l.keys.size > LEDGER_MAX) l.keys = new Set([...l.keys].slice(-LEDGER_MAX));
  clearTimeout(l.timer);
  l.timer = setTimeout(() => { mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, 'used.json'), JSON.stringify([...l.keys]))).catch(() => {}); }, 500);
  l.timer.unref?.();
}
const seen = async (dir, key) => { const l = ledgerFor(dir); await l.loaded; return l.keys.has(key); };

// Fresh pictures waiting on disk: your own images in the folder, and memes downloaded earlier in its cache folder.
async function freshFiles(dir) {
  const out = [];
  for (const d of [dir, join(dir, 'cache')]) {
    try { out.push(...(await readdir(d)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => join(d, f))); } catch { /* folder missing */ }
  }
  return out;
}

// Takes one fresh picture at random and retires it (moved to the "used" folder), so it can never be picked again.
// Returns { buf, mime, title, source } or null when nothing fresh is left.
export async function pickLocalImage(dir = DIR) {
  const files = await freshFiles(dir);
  while (files.length) {
    const i = Math.floor(Math.random() * files.length);
    const file = files.splice(i, 1)[0];
    try {
      const buf = await readFile(file);
      const mime = sniffMime(buf);
      const retire = async () => {
        try { await mkdir(join(dir, 'used'), { recursive: true }); await rename(file, join(dir, 'used', `${sha(buf)}-${basename(file)}`)); }
        catch { await unlink(file).catch(() => {}); }
      };
      await retire(); // retire first: even if drawing fails, it is never shown again
      if (!mime || buf.length > 12_000_000) continue;
      if (await seen(dir, sha(buf))) continue; // the same picture under another name
      await remember(dir, sha(buf));
      return { buf, mime, title: null, source: 'local' };
    } catch { /* try another */ }
  }
  return null;
}

// meme-api.com answer -> safe, direct image links only.
export function parseMemePosts(json) {
  const posts = Array.isArray(json?.memes) ? json.memes : json?.url ? [json] : [];
  return posts
    .filter((p) => p && typeof p.url === 'string' && !p.nsfw && !p.spoiler && /^https:\/\/i\.redd\.it\/.+\.(jpe?g|png|webp)$/i.test(p.url))
    .map((p) => ({ url: p.url, title: String(p.title ?? '').slice(0, 120), postLink: p.postLink ?? null }));
}

async function getBuffer(url, fetchFn, ms = 8000) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too big');
  return buf;
}

// Up to `need` NEW memes (never downloaded before) in one go: one list request, then the pictures 4 at a time.
export async function fetchMemeBatch({ fetchFn = fetch, subs = SUBS, need = 8, dir = DIR } = {}) {
  const sub = subs[Math.floor(Math.random() * subs.length)];
  const got = [];
  try {
    const res = await fetchFn(`https://meme-api.com/gimme/${sub}/30`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return got;
    const posts = parseMemePosts(await res.json()).sort(() => Math.random() - 0.5);
    const fresh = [];
    for (const p of posts) if (!(await seen(dir, p.url))) fresh.push(p);
    for (let i = 0; i < fresh.length && got.length < need; i += 4) {
      await Promise.all(fresh.slice(i, i + 4).map(async (p) => {
        try {
          const buf = await getBuffer(p.url, fetchFn);
          const mime = sniffMime(buf);
          const size = imageSize(buf);
          await remember(dir, p.url); // never asked for again, wanted or not
          if (!mime || (size && size.w < MIN_WIDTH)) return;
          if (await seen(dir, sha(buf))) return;
          got.push({ buf, mime, title: p.title, source: 'online', postLink: p.postLink, url: p.url });
        } catch { /* next */ }
      }));
    }
  } catch (e) { console.error('meme fetch error:', e.message); }
  return got.slice(0, need);
}

// One-time cleanup: memes saved by the older version included general jokes, so they are dropped once.
export async function clearOldCache(dir = DIR) {
  const c = join(dir, 'cache');
  try { await readFile(join(c, '.original-sources')); return; } catch { /* not yet */ }
  try {
    await mkdir(c, { recursive: true });
    for (const f of await readdir(c)) await unlink(join(c, f)).catch(() => {});
    await writeFile(join(c, '.original-sources'), '1');
  } catch { /* best effort */ }
}

// Keeps a stock of fresh memes on disk, downloading in the background. Nothing on the reply path waits for it.
let filling = false;
export function refillArt({ fetchFn = fetch, dir = DIR } = {}) {
  if (filling) return null;
  filling = true;
  return (async () => {
    try {
      for (let round = 0; round < 8; round++) {
        const have = (await freshFiles(dir)).length;
        if (have >= STOCK) break;
        const batch = await fetchMemeBatch({ fetchFn, need: STOCK - have, dir });
        if (!batch.length && round >= 5) break;
        await mkdir(join(dir, 'cache'), { recursive: true });
        for (const m of batch) {
          const ext = m.mime === 'image/png' ? 'png' : m.mime === 'image/webp' ? 'webp' : 'jpg';
          await writeFile(join(dir, 'cache', `${sha(m.buf)}.${ext}`), m.buf).catch(() => {});
        }
      }
    } catch (e) { console.error('meme refill error:', e.message); }
    finally { filling = false; }
  })();
}

// Your own picture folder (backgrounds/mine): every picture is shown once per round, in random order, and then the round starts again.
// These are pictures you chose, so they are reused; nothing is moved or deleted.
const rounds = new Map(); // dir -> Set of file names already shown in this round
export async function pickOwnImage(dir = join(DIR, 'mine')) {
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)); } catch { return null; }
  if (!files.length) return null;
  let used = rounds.get(dir) ?? new Set();
  let left = files.filter((f) => !used.has(f));
  if (!left.length) { used = new Set(); left = files; }
  while (left.length) {
    const i = Math.floor(Math.random() * left.length);
    const f = left.splice(i, 1)[0];
    used.add(f);
    try {
      const buf = await readFile(join(dir, f));
      const mime = sniffMime(buf);
      if (mime && buf.length <= 15_000_000) { rounds.set(dir, used); return { buf, mime, title: null, source: 'mine' }; }
    } catch { /* try another */ }
  }
  rounds.set(dir, used);
  return null;
}
export const OWN_DIR = join(DIR, 'mine');

// Instant. A picture that was never used before, or null (the card is then plain: a picture is never reused).
export async function getArt({ fetchFn = fetch, dir = DIR } = {}) {
  const mine = await pickOwnImage(join(dir, 'mine'));
  if (mine) return mine; // your own folder wins; nothing is downloaded
  const art = await pickLocalImage(dir);
  refillArt({ fetchFn, dir });
  return art;
}

// For /meme: only real memes (the downloaded stock), never the pictures in backgrounds/mine, which are card backgrounds.
// If the stock is empty it waits a few seconds for the download to bring some.
export async function getMeme({ fetchFn = fetch, dir = DIR, waitMs = 9_000 } = {}) {
  let art = await pickLocalImage(dir);
  const started = refillArt({ fetchFn, dir });
  if (art) return art;
  const stop = Date.now() + waitMs;
  if (started) await Promise.race([started, new Promise((r) => setTimeout(r, waitMs))]);
  while (!art && Date.now() < stop) {
    art = await pickLocalImage(dir);
    if (!art) await new Promise((r) => setTimeout(r, 600));
  }
  return art;
}
