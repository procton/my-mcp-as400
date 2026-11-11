import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AS400_HOST ??= 'test';
process.env.AS400_USER ??= 'test';
process.env.AS400_PASSWORD ??= 'test';
const p = await import('../src/prompts.js');
const { textOf } = await import('../src/resources.js');

/** Tutti i tool citati nei prompt devono esistere davvero: evita prompt che puntano a tool rinominati. */
const KNOWN_TOOLS = new Set([
  'as400_system_info', 'as400_schema_list', 'as400_table_list', 'as400_column_search', 'as400_index_list', 'as400_where_used',
  'as400_view_def', 'as400_constraints', 'as400_routine_list', 'as400_file_desc', 'as400_sql_query', 'as400_source_list',
  'as400_source_read', 'as400_source_search', 'as400_source_refs', 'as400_object_list', 'as400_object_describe',
  'as400_ifs_list', 'as400_ifs_stat', 'as400_ifs_read', 'as400_ifs_read_binary', 'as400_ifs_search',
  'as400_spool_list', 'as400_spool_search', 'as400_spool_info', 'as400_spool_read', 'as400_dds_describe',
]);

const samples = [
  p.promptSpiegaProgramma('LIB', 'QRPGLESRC', 'PGM1'),
  p.promptDocumentaLibreria('LIB', 'AB'),
  p.promptDocumentaLibreria('LIB'),
  p.promptAnalizzaFile('LIB', 'FILE1'),
  p.promptDoveEUsato('LIB', 'CODCLI'),
  p.promptAnalizzaSpool('UTENTE', 'QPJOBLOG', '2026-08-03'),
  p.promptAnalizzaSpool(),
  p.promptSpiegaStampa('LIB', 'DSP1'),
  p.promptInterrogaDati('LIB', 'Quanti clienti hanno più di 3 ordini aperti?'),
  p.promptInterrogaDati('LIB', 'Totale fatturato 2025', 'FATTURE'),
];

test('i prompt citano solo tool esistenti', () => {
  for (const s of samples) {
    for (const m of s.matchAll(/\bas400_[a-z_]+\b/g)) assert.ok(KNOWN_TOOLS.has(m[0]), `tool inesistente nel prompt: ${m[0]}`);
  }
});

test('i prompt includono gli argomenti', () => {
  assert.match(p.promptSpiegaProgramma('MYLIB', 'QCLSRC', 'XYZ'), /MYLIB\/QCLSRC\(XYZ\)/);
  assert.match(p.promptDocumentaLibreria('MYLIB', 'AB'), /"AB%"/);
  assert.match(p.promptDoveEUsato('MYLIB', 'CODCLI'), /"CODCLI"/);
  assert.match(p.promptAnalizzaSpool('PIPPO', undefined, undefined), /utente "PIPPO"/);
  assert.doesNotMatch(p.promptDocumentaLibreria('MYLIB'), /limitandoti/);
});

test('interroga_dati: domanda, libreria e file di partenza; solo lettura', () => {
  const t = p.promptInterrogaDati('MYLIB', 'Quanti ordini ci sono?', 'ORDINI');
  assert.match(t, /Quanti ordini ci sono\?/);
  assert.match(t, /MYLIB\.FILE/);
  assert.match(t, /MYLIB\/ORDINI/);
  assert.match(t, /sola lettura/);
  assert.match(t, /as400_file_desc/);
  assert.doesNotMatch(p.promptInterrogaDati('MYLIB', 'x'), /File da cui partire/);
});

test('textOf: unisce il testo e rilancia gli errori', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.throws(() => textOf({ content: [{ type: 'text', text: 'boom' }], isError: true }), /boom/);
});
