import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytes, decodeCp850, normalizeSpoolText, splitPages } from '../src/charset.js';
import { parseTimestamp } from '../src/spooljava.js';
import { setLocale } from '../src/i18n.js';

setLocale('EN'); // deterministico: non dipende dal LOCALE del .env

test('CP850: accenti italiani e simboli', () => {
  // 0x8A è, 0xD4 È, 0x97 ù, 0x85 à, 0x95 ò, 0x8D ì, 0x80 Ç, 0x9C £
  assert.equal(decodeCp850(Uint8Array.from([0x8a, 0xd4, 0x97, 0x85, 0x95, 0x8d, 0x80, 0x9c])), 'èÈùàòìÇ£');
  assert.equal(decodeCp850(Uint8Array.from([0x41, 0x42, 0x20, 0x31])), 'AB 1');
});

test('decodeBytes: charset configurabili e rifiuto dei sconosciuti', () => {
  assert.equal(decodeBytes(Uint8Array.from([0x8a]), 'cp850'), 'è');
  assert.equal(decodeBytes(Uint8Array.from([0xe8]), 'latin1'), 'è');
  assert.equal(decodeBytes(Buffer.from('è', 'utf8'), 'utf-8'), 'è');
  assert.throws(() => decodeBytes(Uint8Array.from([1]), 'charset-che-non-esiste'));
});

test('normalizeSpoolText: NUL, CRLF, CR doppi e CR isolati', () => {
  assert.equal(normalizeSpoolText('\u0000riga1\r\nriga2\r\r\nriga3\rXYZ\r\r\f'), 'riga1\nriga2\nriga3XYZ\f');
});

test('splitPages: separa su form feed e scarta la pagina vuota finale', () => {
  assert.deepEqual(splitPages('p1\fp2\fp3\f'), ['p1', 'p2', 'p3']);
  assert.deepEqual(splitPages('unica'), ['unica']);
  assert.deepEqual(splitPages('a\f\nb'), ['a', '\nb']);
});

test('parseTimestamp: CYYMMDD / HHMMSS per la chiave spool', () => {
  assert.deepEqual(parseTimestamp('2026-08-03 15:54:04.419766'), { data: '1260803', ora: '155404' });
  assert.deepEqual(parseTimestamp('1999-12-31 23:59:59'), { data: '0991231', ora: '235959' });
});
