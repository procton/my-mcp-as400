import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AS400_HOST ??= 'test';
process.env.AS400_USER ??= 'test';
process.env.AS400_PASSWORD ??= 'test';

const { parseJdbcExtra, objName, ifsPath } = await import('../src/config.js');
const { likeRegex, numberLines, capText } = await import('../src/tools/common.js');
const { jsonify, likeP } = await import('../src/pool.js');

test('parseJdbcExtra', () => {
  assert.deepEqual(parseJdbcExtra('a=1&b=x=y& c = 2'), { a: '1', b: 'x=y', c: '2' });
  assert.deepEqual(parseJdbcExtra(undefined), {});
  assert.deepEqual(parseJdbcExtra('senzauguale'), {});
});

test('objName', () => {
  assert.equal(objName(' qrpgsrc '), 'QRPGSRC');
  assert.throws(() => objName('TROPPOLUNGO1'));
  assert.throws(() => objName('A.B'));
  assert.throws(() => objName('A B'));
  assert.equal(objName('MY$LIB#@'), 'MY$LIB#@');
});

test('ifsPath normalizza', () => {
  assert.equal(ifsPath('/home//x/./y/'), '/home/x/y');
  assert.throws(() => ifsPath('/home/x\0y'));
});

test('ifsPath', () => {
  assert.equal(ifsPath('/home/x'), '/home/x');
  assert.throws(() => ifsPath('home/x'));
  assert.throws(() => ifsPath('/home/../etc'));
});

test('likeRegex', () => {
  assert.ok(likeRegex('AB%').test('ABCD'));
  assert.ok(likeRegex('A_C').test('ABC'));
  assert.ok(!likeRegex('A_C').test('ABBC'));
  assert.ok(likeRegex('A.B').test('A.B'));
  assert.ok(!likeRegex('A.B').test('AXB'));
  assert.ok(likeRegex('').test('QUALSIASI'));
});

test('numberLines / capText', () => {
  assert.equal(numberLines(['a', 'b'], 9), ' 9| a\n10| b');
  assert.equal(capText('abc', 5), 'abc');
  assert.match(capText('abcdef', 3, 'x'), /^abc\n\.\.\.\[x troncato: 3/);
});

test('jsonify', () => {
  assert.equal(jsonify(undefined), null);
  assert.equal(jsonify(10n), '10');
  assert.equal(jsonify({ type: 'CLOB', value: 'txt' }), 'txt');
  assert.deepEqual(jsonify({ a: [1, undefined] }), { a: [1, null] });
  assert.equal(likeP(' ab '), 'AB');
});
