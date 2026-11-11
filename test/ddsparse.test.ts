import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDds, parseKeywords } from '../src/ddsparse.js';

/** Costruisce una riga DDS a colonne fisse. */
function dds(o: { cond?: string; form?: string; name?: string; ref?: boolean; len?: string; type?: string; dec?: string; usage?: string; line?: string; pos?: string; kw?: string; comment?: boolean }): string {
  const a = Array(80).fill(' ');
  const put = (col1: number, v: string): void => { for (let i = 0; i < v.length; i++) a[col1 - 1 + i] = v[i]; };
  put(6, 'A');
  if (o.comment) { put(7, '*'); put(8, o.kw ?? ''); return a.join('').trimEnd(); }
  if (o.cond) put(8, o.cond);
  if (o.form) put(17, o.form);
  if (o.name) put(19, o.name);
  if (o.ref) put(29, 'R');
  if (o.len) put(35 - o.len.length, o.len);
  if (o.type) put(35, o.type);
  if (o.dec) put(38 - o.dec.length, o.dec);
  if (o.usage) put(38, o.usage);
  if (o.line) put(42 - o.line.length, o.line);
  if (o.pos) put(45 - o.pos.length, o.pos);
  if (o.kw) put(45, o.kw);
  return a.join('').trimEnd();
}

test('parseKeywords: argomenti annidati, apici, literal', () => {
  const k = parseKeywords("TEXT('Codice (cliente)') COLHDG('Cod' 'Cli') EDTCDE(Z) DSPATR(HI UL) 'costante'");
  assert.deepEqual(k.map((x) => x.nome), ['TEXT', 'COLHDG', 'EDTCDE', 'DSPATR', "'costante'"]);
  assert.equal(k[0].argomenti, "'Codice (cliente)'");
  assert.equal(k[3].argomenti, 'HI UL');
});

test('PF: formato, campi, tipi, decimali, TEXT/COLHDG, chiave', () => {
  const r = parseDds([
    dds({ kw: 'UNIQUE' }),
    dds({ form: 'R', name: 'CLIREC', kw: "TEXT('Anagrafica clienti')" }),
    dds({ name: 'CODCLI', len: '6', type: 'S', dec: '0', kw: "TEXT('Codice cliente')" }),
    dds({ kw: "COLHDG('Cod' 'Cli')" }),
    dds({ name: 'RAGSOC', len: '40', type: 'A', kw: "TEXT('Ragione sociale')" }),
    dds({ name: 'IMPORTO', len: '11', type: 'P', dec: '2' }),
    dds({ comment: true, kw: 'commento' }),
    dds({ form: 'K', name: 'CODCLI' }),
    dds({ form: 'K', name: 'RAGSOC', kw: 'DESCEND' }),
  ]);
  assert.deepEqual(r.parole_chiave_file.map((k) => k.nome), ['UNIQUE']);
  assert.equal(r.formati.length, 1);
  const f = r.formati[0];
  assert.equal(f.nome, 'CLIREC');
  assert.equal(f.campi.length, 3);
  assert.deepEqual([f.campi[0].nome, f.campi[0].lunghezza, f.campi[0].tipo, f.campi[0].decimali], ['CODCLI', 6, 'zoned', 0]);
  assert.equal(f.campi[0].testo, 'Codice cliente');
  assert.equal(f.campi[0].intestazione, 'Cod Cli');
  assert.deepEqual([f.campi[2].tipo, f.campi[2].decimali], ['packed', 2]);
  assert.deepEqual(r.chiavi.map((k) => [k.campo, k.ordine]), [['CODCLI', 'ASC'], ['RAGSOC', 'DESC']]);
});

test('LF: PFILE, select/omit, campo di riferimento', () => {
  const r = parseDds([
    dds({ form: 'R', name: 'CLIREC', kw: 'PFILE(MYLIB/CLIENTI)' }),
    dds({ name: 'CODCLI', ref: true }),
    dds({ form: 'K', name: 'CODCLI' }),
    dds({ form: 'S', name: 'STATO', kw: "COMP(EQ 'A')" }),
    dds({ form: 'O', name: 'TIPO', kw: "COMP(EQ 'X')" }),
  ]);
  assert.equal(r.formati[0].parole_chiave[0].nome, 'PFILE');
  assert.equal(r.formati[0].parole_chiave[0].argomenti, 'MYLIB/CLIENTI');
  assert.equal(r.formati[0].campi[0].da_riferimento, true);
  assert.deepEqual(r.select_omit.map((s) => [s.modo, s.campo]), [['select', 'STATO'], ['omit', 'TIPO']]);
});

test('DSPF: DSPSIZ a livello file, posizioni, uso, costanti, indicatori', () => {
  const r = parseDds([
    dds({ kw: 'DSPSIZ(24 80 *DS3)' }),
    dds({ kw: 'PRINT' }),
    dds({ form: 'R', name: 'FMT1', kw: 'CA03(03)' }),
    dds({ line: '1', pos: '2', kw: "'Gestione clienti'" }),
    dds({ line: '1', pos: '60', kw: "'Pagina'" }),
    dds({ name: 'CODCLI', len: '6', type: 'S', dec: '0', usage: 'B', line: '5', pos: '20', kw: 'EDTCDE(Z)' }),
    dds({ cond: ' 40', name: 'MSG', len: '40', type: 'A', usage: 'O', line: '24', pos: '2', kw: 'DSPATR(HI)' }),
  ]);
  assert.deepEqual(r.parole_chiave_file.map((k) => k.nome), ['DSPSIZ', 'PRINT']);
  const f = r.formati[0];
  assert.equal(f.costanti.length, 2);
  assert.deepEqual([f.costanti[0].testo, f.costanti[0].riga, f.costanti[0].posizione], ['Gestione clienti', 1, 2]);
  assert.deepEqual([f.campi[0].uso, f.campi[0].riga, f.campi[0].posizione], ['input/output', 5, 20]);
  assert.deepEqual(f.campi[1].condizioni, ['40']);
  assert.equal(f.campi[1].uso, 'output');
});

test('PRTF: campi con riga/posizione e continuazione di parole chiave', () => {
  const kw1 = "TEXT('Descrizione molto lunga che".padEnd(35, ' ') + '+'; // 36 colonne di funzione, col. 80 = '+'
  const r = parseDds([
    dds({ form: 'R', name: 'DETT', kw: 'SPACEA(1)' }),
    dds({ name: 'DESCR', len: '30', type: 'A', line: '1', pos: '10', kw: kw1 }),
    dds({ kw: "prosegue')" }),
    dds({ name: 'QTA', len: '7', type: 'S', dec: '0', line: '1', pos: '45', kw: 'EDTCDE(J)' }),
  ]);
  const f = r.formati[0];
  assert.equal(f.campi.length, 2);
  assert.match(f.campi[0].testo ?? '', /^Descrizione molto lunga che\s+prosegue$/);
  assert.deepEqual([f.campi[1].riga, f.campi[1].posizione], [1, 45]);
});

test('campi senza formato esplicito e righe ignorabili', () => {
  const r = parseDds(['', '      * non DDS', dds({ comment: true, kw: 'x' }), dds({ name: 'A', len: '1', type: 'A' })]);
  assert.equal(r.formati.length, 1);
  assert.equal(r.formati[0].nome, '(implicito)');
});
