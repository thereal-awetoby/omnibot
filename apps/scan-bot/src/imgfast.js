import { createHash } from 'node:crypto';
// Smaller, faster pictures. Uses the "sharp" library when it is installed (npm install), otherwise leaves pictures as they are.
let sharpP = null;
async function sharp() {
  if (!sharpP) sharpP = import('sharp').then((m) => m.default ?? m).catch(() => null);
  return sharpP;
}

// A photo shrunk to a 16:9 card background (JPEG), or the same picture when sharp is missing.
const shrunk = new Map(); // picture fingerprint -> shrunk picture, so a picture seen before is instant
export async function shrinkArt(art, width = 1280, height = 720) {
  const s = await sharp();
  if (!s || !art) return art;
  const key = createHash('sha1').update(art.buf).digest('hex');
  if (shrunk.has(key)) return { ...art, ...shrunk.get(key) };
  try {
    const buf = await s(art.buf, { failOn: 'none' }).rotate().resize(width, height, { fit: 'cover', position: 'attention' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    if (shrunk.size >= 40) shrunk.delete(shrunk.keys().next().value);
    shrunk.set(key, { buf, mime: 'image/jpeg' });
    return { ...art, buf, mime: 'image/jpeg' };
  } catch { return art; }
}

// The finished card as JPEG: about 5 times smaller than PNG, so it uploads in a fraction of the time.
export async function cardToJpeg(png, quality = 90) {
  const s = await sharp();
  if (!s) return { buf: png, name: 'pnl.png' };
  try { return { buf: await s(png).jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer(), name: 'pnl.jpg' }; }
  catch { return { buf: png, name: 'pnl.png' }; }
}
export const hasSharp = async () => Boolean(await sharp());

// Raw pixels straight to JPEG (skips making and reading a PNG). null when sharp is missing.
export async function rawToJpeg({ pixels, width, height }, quality = 90) {
  const s = await sharp();
  if (!s) return null;
  try { return await s(pixels, { raw: { width, height, channels: 4 } }).jpeg({ quality, mozjpeg: false, chromaSubsampling: '4:4:4' }).toBuffer(); }
  catch { return null; }
}
