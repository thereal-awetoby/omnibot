import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffMime, parseMemePosts, pickLocalImage, fetchOnlineMeme } from './memeart.js';

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]);

test('sniffMime knows jpeg, png, webp and refuses the rest', () => {
  assert.equal(sniffMime(JPG), 'image/jpeg');
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(Buffer.from('<html>not an image at all</html>')), null);
  assert.equal(sniffMime(null), null);
});

test('parseMemePosts keeps only safe direct images', () => {
  const posts = parseMemePosts({ memes: [
    { url: 'https://i.redd.it/a.jpg', title: 'ok', nsfw: false, spoiler: false, postLink: 'https://redd.it/1' },
    { url: 'https://i.redd.it/b.png', nsfw: true },
    { url: 'https://i.redd.it/c.gif' },
    { url: 'https://evil.example/d.jpg' },
    { url: 'https://i.redd.it/e.jpg', spoiler: true },
  ] });
  assert.deepEqual(posts.map((p) => p.url), ['https://i.redd.it/a.jpg']);
  assert.deepEqual(parseMemePosts(null), []);
});

test('pickLocalImage reads a random image from a folder, null when empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-'));
  assert.equal(await pickLocalImage(dir), null);
  await writeFile(join(dir, 'notes.txt'), 'hello');
  await writeFile(join(dir, 'fake.jpg'), 'this is not an image');
  assert.equal(await pickLocalImage(dir), null);
  await writeFile(join(dir, 'one.png'), PNG);
  const got = await pickLocalImage(dir);
  assert.equal(got.mime, 'image/png');
  assert.equal(got.source, 'local');
  assert.equal(await pickLocalImage(join(dir, 'missing')), null);
});

test('fetchOnlineMeme downloads one safe meme', async () => {
  const fetchFn = async (url) => {
    if (url.startsWith('https://meme-api.com/')) return { ok: true, json: async () => ({ memes: [{ url: 'https://i.redd.it/a.jpg', title: 'gm' }] }) };
    return { ok: true, arrayBuffer: async () => JPG.buffer.slice(JPG.byteOffset, JPG.byteOffset + JPG.length) };
  };
  const m = await fetchOnlineMeme({ fetchFn, tries: 1 });
  assert.equal(m.mime, 'image/jpeg');
  assert.equal(m.title, 'gm');
  assert.equal(await fetchOnlineMeme({ fetchFn: async () => ({ ok: false }), tries: 2 }), null);
});
