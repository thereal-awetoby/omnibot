import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, isValidName, nextWalletLabel, esc } from './labels.js';

test('valid and invalid names', () => {
  for (const ok of ['Main', 'Sniper 2', 'my-wallet_1.x', 'Ñandú', 'A'.repeat(20)]) {
    assert.ok(isValidName(normalizeName(ok)), ok);
  }
  for (const bad of ['', '   ', 'A'.repeat(21), '<b>hi</b>', 'a&b', 'quote"s', 'a/b']) {
    assert.ok(!isValidName(normalizeName(bad)), JSON.stringify(bad));
  }
});

test('normalizeName trims and collapses spaces', () => {
  assert.equal(normalizeName('  My   wallet  '), 'My wallet');
  assert.equal(normalizeName('x\ny'), 'x y'); // newlines become plain spaces
});

test('nextWalletLabel picks the next free number', () => {
  assert.equal(nextWalletLabel([]), 'Wallet 1');
  assert.equal(nextWalletLabel(['Wallet 1', 'Wallet 2']), 'Wallet 3');
  // user renamed Wallet 2 to "Wallet 3": the next default must not collide
  assert.equal(nextWalletLabel(['Wallet 1', 'Wallet 3']), 'Wallet 4');
  assert.equal(nextWalletLabel(['Main', 'wallet 2']), 'Wallet 3');
});

test('esc escapes HTML special characters', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});
