import { createHash } from 'node:crypto';
// Smaller, faster pictures. Uses the "sharp" library when it is installed (npm install), otherwise leaves pictures as they are.
let sharpP = null;
async function sharp() {
  if (!sharpP) sharpP = import('sharp').then((m) => m.default ?? m).catch(() => null);
  return sharpP;
}

// A photo shrunk to a 16:9 card background (JPEG), or the same picture when sharp is missing.
const shrunk = new Map(); // picture fingerprint -> shrunk picture, so a picture seen before is instant
// Only HUGE pictures are made smaller (wider than 2200 px or over 3 MB), to 2000 px wide at very high quality, same crop.
// Normal pictures are used exactly as they are, so nothing is lost.
export async function shrinkArt(art) {
  const s = await sharp();
  if (!s || !art) return art;
  try {
    const key = createHash('sha1').update(art.buf).digest('hex');
    if (shrunk.has(key)) return { ...art, ...shrunk.get(key) };
    const meta = await s(art.buf, { failOn: 'none' }).metadata();
    if (!((meta.width ?? 0) > 2200 || art.buf.length > 3_000_000)) return art;
    const buf = await s(art.buf, { failOn: 'none' }).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
    if (shrunk.size >= 40) shrunk.delete(shrunk.keys().next().value);
    shrunk.set(key, { buf, mime: 'image/jpeg' });
    return { ...art, buf, mime: 'image/jpeg' };
  } catch { return art; }
}

// The finished card as JPEG: about 5 times smaller than PNG, so it uploads in a fraction of the time.
export async function cardToJpeg(png, quality = 95) {
  const s = await sharp();
  if (!s) return { buf: png, name: 'pnl.png' };
  try { return { buf: await s(png).jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), name: 'pnl.jpg' }; }
  catch { return { buf: png, name: 'pnl.png' }; }
}
export const hasSharp = async () => Boolean(await sharp());

// Raw pixels straight to JPEG (skips making and reading a PNG). null when sharp is missing.
export async function rawToJpeg({ pixels, width, height }, quality = Number(process.env.CARD_QUALITY) || 95) {
  const s = await sharp();
  if (!s) return null;
  try { return await s(pixels, { raw: { width, height, channels: 4 } }).jpeg({ quality, mozjpeg: false, chromaSubsampling: '4:4:4' }).toBuffer(); }
  catch { return null; }
}
