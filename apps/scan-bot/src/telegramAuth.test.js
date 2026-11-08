import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData } from './telegramAuth.js';

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

// Builds a validly-signed initData string the way Telegram's client does, so tests exercise the real algorithm.
function sign(fields, botToken = BOT_TOKEN) {
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const checkString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('verifyInitData accepts a correctly-signed, fresh initData string', () => {
  const now = 1_800_000_000_000;
  const fields = { auth_date: String(Math.floor(now / 1000) - 10), query_id: 'AAA', user: JSON.stringify({ id: 555, username: 'ann', first_name: 'Ann' }) };
  const r = verifyInitData(sign(fields), BOT_TOKEN, now);
  assert.equal(r.ok, true);
  assert.deepEqual(r.user, { id: '555', username: 'ann', firstName: 'Ann' });
});

test('verifyInitData rejects a tampered signature', () => {
  const now = 1_800_000_000_000;
  const fields = { auth_date: String(Math.floor(now / 1000) - 10), user: JSON.stringify({ id: 1 }) };
  const good = sign(fields);
  const tampered = good.replace(/user=[^&]+/, `user=${encodeURIComponent(JSON.stringify({ id: 999 }))}`);
  const r = verifyInitData(tampered, BOT_TOKEN, now);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad signature');
});

test('verifyInitData rejects stale auth_date (replay protection) and future auth_date', () => {
  const now = 1_800_000_000_000;
  const stale = sign({ auth_date: String(Math.floor(now / 1000) - 25 * 3600), user: JSON.stringify({ id: 1 }) });
  assert.equal(verifyInitData(stale, BOT_TOKEN, now).reason, 'expired');
  const future = sign({ auth_date: String(Math.floor(now / 1000) + 3600), user: JSON.stringify({ id: 1 }) });
  assert.equal(verifyInitData(future, BOT_TOKEN, now).reason, 'expired');
});

test('verifyInitData rejects a signature made with the wrong bot token', () => {
  const now = 1_800_000_000_000;
  const fields = { auth_date: String(Math.floor(now / 1000) - 10), user: JSON.stringify({ id: 1 }) };
  const signedWithOtherBot = sign(fields, 'OTHER:token');
  assert.equal(verifyInitData(signedWithOtherBot, BOT_TOKEN, now).ok, false);
});

test('verifyInitData handles missing pieces cleanly', () => {
  assert.equal(verifyInitData('', BOT_TOKEN).reason, 'missing initData');
  assert.equal(verifyInitData(null, BOT_TOKEN).reason, 'missing initData');
  assert.equal(verifyInitData('a=b', BOT_TOKEN).reason, 'no hash');
  assert.equal(verifyInitData('a=b&hash=zz', '').reason, 'bot token not configured');
  const now = 1_800_000_000_000;
  const noUser = sign({ auth_date: String(Math.floor(now / 1000) - 10) });
  assert.equal(verifyInitData(noUser, BOT_TOKEN, now).reason, 'no user in initData');
});
