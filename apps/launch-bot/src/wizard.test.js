import test from 'node:test';
import assert from 'node:assert/strict';
import { parseName, parseSymbol, parseDescription, parseSocial, parseDevBuy, checkImage, neededLamports, lamportsToSol, fmtSol } from './wizard.js';

test('name', () => {
  assert.equal(parseName('  My   Coin ').value, 'My Coin');
  assert.equal(parseName('').ok, false);
  assert.equal(parseName('x'.repeat(33)).ok, false);
});
test('symbol', () => {
  assert.equal(parseSymbol('$omni').value, 'OMNI');
  assert.equal(parseSymbol('two words').ok, false);
  assert.equal(parseSymbol('ABCDEFGHIJK').ok, false);
  assert.equal(parseSymbol('').ok, false);
});
test('description', () => {
  assert.equal(parseDescription('hi').ok, true);
  assert.equal(parseDescription('x'.repeat(501)).ok, false);
});
test('socials', () => {
  assert.equal(parseSocial('twitter', '@omni').value, 'https://x.com/omni');
  assert.equal(parseSocial('twitter', 'https://twitter.com/omni/').value, 'https://x.com/omni');
  assert.equal(parseSocial('twitter', 'skip').value, null);
  assert.equal(parseSocial('twitter', 'not a handle!').ok, false);
  assert.equal(parseSocial('telegram', 't.me/omnigroup').value, 'https://t.me/omnigroup');
  assert.equal(parseSocial('telegram', '+AbCd').ok, false);
  assert.equal(parseSocial('website', 'example.com').value, 'https://example.com/');
  assert.equal(parseSocial('website', 'nodots').ok, false);
});
test('dev buy', () => {
  assert.equal(parseDevBuy('0.5').value, 500_000_000);
  assert.equal(parseDevBuy('0,25 SOL').value, 250_000_000);
  assert.equal(parseDevBuy('0').value, 0);
  assert.equal(parseDevBuy('skip').value, 0);
  assert.equal(parseDevBuy('abc').ok, false);
  assert.equal(parseDevBuy('-1').ok, false);
  assert.equal(parseDevBuy('86').ok, false);
});
test('image + costs', () => {
  assert.equal(checkImage({ mime: 'image/png', size: 100 }).ok, true);
  assert.equal(checkImage({ mime: 'application/pdf', size: 100 }).ok, false);
  assert.equal(checkImage({ mime: 'image/png', size: 6 * 1024 * 1024 }).ok, false);
  assert.equal(neededLamports(500_000_000), 530_000_000);
  assert.equal(lamportsToSol(500_000_000), 0.5);
  assert.equal(fmtSol(0.53), '0.53');
  assert.equal(fmtSol(2), '2');
});
