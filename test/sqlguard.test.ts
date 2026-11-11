import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReadOnlySql } from '../src/sqlguard.js';

const g = (q: string, allowedLibs: string[] | null = null) => guardReadOnlySql(q, { allowedLibs, maxRows: 100 });

test('SELECT semplice: limite aggiunto, ; finale rimosso', () => {
  assert.equal(g('select * from mylib.t;').sql, 'select * from mylib.t FETCH FIRST 100 ROWS ONLY');
});

test('stringa contenente FETCH FIRST non disattiva il limite', () => {
  const r = g(`SELECT 'FETCH FIRST 1 ROWS ONLY' AS X FROM SYSIBM.SYSDUMMY1`);
  assert.equal(r.explicitLimit, false);
  assert.match(r.sql, /FETCH FIRST 100 ROWS ONLY$/);
});

test('FETCH FIRST in sotto-select non vale per la query esterna', () => {
  const r = g('SELECT * FROM (SELECT * FROM a.t FETCH FIRST 1 ROWS ONLY) x');
  assert.equal(r.explicitLimit, false);
});

test('limite esplicito esterno rispettato', () => {
  const r = g('SELECT * FROM a.t FETCH FIRST 5 ROWS ONLY');
  assert.equal(r.explicitLimit, true);
  assert.equal(r.sql, 'SELECT * FROM a.t FETCH FIRST 5 ROWS ONLY');
});

test('limite inserito prima di FOR READ ONLY / WITH UR', () => {
  assert.equal(g('SELECT * FROM a.t FOR READ ONLY').sql, 'SELECT * FROM a.t FETCH FIRST 100 ROWS ONLY FOR READ ONLY');
  assert.equal(g('SELECT * FROM a.t ORDER BY 1 WITH UR').sql, 'SELECT * FROM a.t ORDER BY 1 FETCH FIRST 100 ROWS ONLY WITH UR');
});

test('statement non ammessi', () => {
  for (const q of [
    'DELETE FROM a.t', 'INSERT INTO a.t VALUES (1)', 'UPDATE a.t SET x=1', 'CALL QSYS2.QCMDEXC(\'X\')',
    'SELECT 1 FROM SYSIBM.SYSDUMMY1; DROP TABLE a.t', 'SELECT * FROM a.t FOR UPDATE',
    'SELECT * FROM FINAL TABLE (INSERT INTO a.t VALUES (1))', 'WITH x AS (SELECT 1 FROM a.t) DELETE FROM a.t',
    'SELECT QSYS2.QCMDEXC(\'DSPLIBL\') FROM SYSIBM.SYSDUMMY1', '', '  ', 'VALUES 1',
  ]) assert.throws(() => g(q), undefined, q);
});

test('commenti e stringhe non ingannano', () => {
  assert.throws(() => g('/* SELECT */ DELETE FROM a.t'));
  assert.throws(() => g("SELECT 1 FROM a.t -- ok\n; DELETE FROM a.t"));
  assert.doesNotThrow(() => g(`SELECT 'DELETE; DROP' AS X, "UPDATE" FROM a.t`));
  assert.throws(() => g("SELECT 'aperta FROM a.t"));
});

test('IFS e spool via SQL bloccati', () => {
  assert.throws(() => g(`SELECT * FROM TABLE(QSYS2.IFS_READ('/etc/passwd'))`));
  assert.throws(() => g(`SELECT * FROM TABLE(QSYS2."IFS_READ"('/x'))`));
  assert.throws(() => g(`SELECT * FROM TABLE(QSYS2.SPOOLED_FILE_DATA('A','1','B','C'))`));
});

test('ALLOWED_LIBS: riferimenti qualificati', () => {
  const al = ['MYLIB'];
  assert.doesNotThrow(() => g('SELECT * FROM mylib.t a JOIN MYLIB.u b ON a.x = b.x', al));
  assert.doesNotThrow(() => g('SELECT * FROM qsys2.systables', al));
  assert.throws(() => g('SELECT * FROM other.t', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM t', al), /qualificata/);
  assert.throws(() => g('SELECT * FROM mylib.t, other.u', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM mylib.t a JOIN other.u b ON 1=1', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM (SELECT * FROM other.t) x', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM mylib.t WHERE x IN (SELECT y FROM other.u)', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM "OTHER"."T"', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM TABLE(other.fn(1)) x', al), /OTHER/);
  assert.throws(() => g('SELECT * FROM other/t', al), /OTHER/);
});

test('ALLOWED_LIBS: CTE ammesse', () => {
  assert.doesNotThrow(() => g('WITH c AS (SELECT * FROM mylib.t) SELECT * FROM c', ['MYLIB']));
  assert.throws(() => g('WITH c AS (SELECT * FROM other.t) SELECT * FROM c', ['MYLIB']), /OTHER/);
  assert.doesNotThrow(() => g('WITH c AS (SELECT 1 AS A FROM mylib.t), d AS (SELECT * FROM c) SELECT * FROM d', ['MYLIB']));
});
