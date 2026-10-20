import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize, sniffMime, parseMemePosts, pickLocalImage, fetchMemeBatch, getArt } from './memeart.js';

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

test('pickLocalImage uses each picture once, then retires it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-'));
  assert.equal(await pickLocalImage(dir), null);
  await writeFile(join(dir, 'notes.txt'), 'hello');
  await writeFile(join(dir, 'fake.jpg'), 'this is not an image');
  assert.equal(await pickLocalImage(dir), null);
  const a = Buffer.concat([PNG, Buffer.from('a')]);
  const b = Buffer.concat([PNG, Buffer.from('b')]);
  await writeFile(join(dir, 'one.png'), a);
  await mkdir(join(dir, 'cache'));
  await writeFile(join(dir, 'cache', 'two.png'), b);
  const first = await pickLocalImage(dir);
  const second = await pickLocalImage(dir);
  assert.equal(first.mime, 'image/png');
  assert.notDeepEqual(first.buf, second.buf);
  assert.equal(await pickLocalImage(dir), null); // nothing fresh left: no reuse
  assert.equal((await readdir(join(dir, 'used'))).length >= 2, true);
  assert.equal(await pickLocalImage(join(dir, 'missing')), null);
});

test('the same picture under another name is not shown twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-'));
  const a = Buffer.concat([PNG, Buffer.from('same')]);
  await writeFile(join(dir, 'x.png'), a);
  assert.ok(await pickLocalImage(dir));
  await writeFile(join(dir, 'copy-of-x.png'), a);
  assert.equal(await pickLocalImage(dir), null);
});

test('fetchMemeBatch downloads only memes it has never downloaded before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-'));
  const bytes = (tag) => Buffer.concat([JPG, Buffer.from(tag)]);
  const fetchFn = async (url) => {
    if (url.startsWith('https://meme-api.com/')) return { ok: true, json: async () => ({ memes: [{ url: 'https://i.redd.it/a.jpg', title: 'a' }, { url: 'https://i.redd.it/b.jpg', title: 'b' }] }) };
    const buf = bytes(url.endsWith('a.jpg') ? 'A' : 'B');
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  };
  const first = await fetchMemeBatch({ fetchFn, need: 5, dir });
  assert.deepEqual(first.map((m) => m.title).sort(), ['a', 'b']);
  assert.deepEqual(await fetchMemeBatch({ fetchFn, need: 5, dir }), []); // both already seen
  assert.equal(await fetchMemeBatch({ fetchFn: async () => ({ ok: false }), need: 5, dir }).then((x) => x.length), 0);
});

test('getArt never waits for the internet, and is null (plain card) rather than reusing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'art-'));
  const never = () => new Promise(() => {}); // a connection that never answers
  const t0 = Date.now();
  assert.equal(await getArt({ fetchFn: never, dir }), null);
  assert.ok(Date.now() - t0 < 500);
  await mkdir(join(dir, 'cache'));
  await writeFile(join(dir, 'cache', 'saved.png'), PNG);
  assert.equal((await getArt({ fetchFn: never, dir })).mime, 'image/png');
  assert.equal(await getArt({ fetchFn: never, dir }), null); // used once, gone
});
