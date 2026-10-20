import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'backgrounds');
const MAX_BYTES = 4_000_000;
// Crypto-flavoured meme communities first, general memes as backup.
const SUBS = ['CryptoCurrencyMemes', 'cryptomemes', 'SolanaMemes', 'memes', 'dankmemes'];

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
const MIN_WIDTH = 600; // smaller memes are skipped (the card shows the picture sharp, so it must not be tiny)
const CACHE_MAX = 80;

// A random image from the backgrounds folder (your own images) or its cache folder (memes saved earlier), or null.
export async function pickLocalImage(dir = DIR) {
  let files = [];
  for (const d of [dir, join(dir, 'cache')]) {
    try { files.push(...(await readdir(d)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => join(d, f))); } catch { /* folder missing */ }
  }
  while (files.length) {
    const i = Math.floor(Math.random() * files.length);
    try {
      const buf = await readFile(files[i]);
      const mime = sniffMime(buf);
      if (mime && buf.length <= 12_000_000) return { buf, mime, title: null, source: 'local' };
    } catch { /* try another */ }
    files.splice(i, 1);
  }
  return null;
}

// Keeps a good online meme on disk, so there is variety even when the internet is slow (the folder is capped).
async function saveToCache(art, dir = DIR) {
  try {
    const cdir = join(dir, 'cache');
    await mkdir(cdir, { recursive: true });
    if ((await readdir(cdir)).length >= CACHE_MAX) return;
    const ext = art.mime === 'image/png' ? 'png' : art.mime === 'image/webp' ? 'webp' : 'jpg';
    await writeFile(join(cdir, `${createHash('sha1').update(art.buf).digest('hex').slice(0, 16)}.${ext}`), art.buf);
  } catch { /* the cache is only a bonus */ }
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

// One fresh random meme from the internet (null if every try failed).
export async function fetchOnlineMeme({ fetchFn = fetch, subs = SUBS, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    const sub = subs[Math.floor(Math.random() * subs.length)];
    try {
      const res = await fetchFn(`https://meme-api.com/gimme/${sub}/5`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const posts = parseMemePosts(await res.json());
      for (const p of posts.sort(() => Math.random() - 0.5)) {
        try {
          const buf = await getBuffer(p.url, fetchFn);
          const mime = sniffMime(buf);
          const size = imageSize(buf);
          if (mime && !(size && size.w < MIN_WIDTH)) return { buf, mime, title: p.title, source: 'online', postLink: p.postLink };
        } catch { /* next post */ }
      }
    } catch (e) { console.error('meme fetch error:', e.message); }
  }
  return null;
}

// A small ready-made pool, filled in the background. Nothing on the reply path ever waits for the internet.
const pool = [];
let filling = false;
export function refillArt({ fetchFn = fetch, dir = DIR } = {}) {
  if (filling || pool.length >= 5) return;
  filling = true;
  (async () => {
    try {
      for (let i = 0; i < 8 && pool.length < 6; i++) {
        const mm = await fetchOnlineMeme({ fetchFn, tries: 1 });
        if (mm) { pool.push(mm); saveToCache(mm, dir); }
      }
    } finally { filling = false; }
  })();
}

// Instant: one of your own / saved images or a ready online meme, picked at random. Null means "plain card".
export async function getArt({ fetchFn = fetch, dir = DIR } = {}) {
  refillArt({ fetchFn, dir });
  const useOnline = pool.length > 0 && Math.random() < 0.5;
  if (useOnline) return pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  const local = await pickLocalImage(dir);
  if (local) return local;
  return pool.length ? pool.splice(Math.floor(Math.random() * pool.length), 1)[0] : null;
}
