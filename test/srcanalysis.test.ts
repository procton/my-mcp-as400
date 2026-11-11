import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRefs, familyOf } from '../src/srcanalysis.js';
import { setLocale } from '../src/i18n.js';

setLocale('EN'); // deterministico: non dipende dal LOCALE del .env

const names = (refs: ReturnType<typeof extractRefs>, tipo: string): string[] => refs.filter((r) => r.tipo === tipo).map((r) => r.nome).sort();

test('familyOf', () => {
  assert.equal(familyOf('SQLRPGLE'), 'rpg');
  assert.equal(familyOf('clle'), 'cl');
  assert.equal(familyOf('LF'), 'dds');
  assert.equal(familyOf('TXT'), 'sconosciuto');
  assert.equal(familyOf(null), 'sconosciuto');
});

test('RPG fixed: F-spec con uso e dispositivo, commenti ignorati', () => {
  const lines = [
    '     H DECEDIT(\'0,\')',
    '     FANAGRAF   IF   E           K DISK',
    '     FORDINI    UF A E           K DISK',
    '     FQPRINT    O    F  132        PRINTER',
    '     F*COMMENTATO IF   E           K DISK',
    "     C                   CALL      'PGMAUX'",
    '     C                   CALLB     \'MYPROC\'',
    '     C*                  CALL      \'COMMENTATO\'',
  ];
  const r = extractRefs('rpg', lines);
  assert.deepEqual(names(r, 'file'), ['ANAGRAF', 'ORDINI', 'QPRINT']);
  assert.equal(r.find((x) => x.nome === 'ANAGRAF')?.dettaglio, 'input disk');
  assert.equal(r.find((x) => x.nome === 'ORDINI')?.dettaglio, 'update disk');
  assert.deepEqual(names(r, 'programma'), ['MYPROC', 'PGMAUX']);
});

test('RPG free: DCL-F, EXTPGM, EXTPROC, DTAARA, /COPY, EXTNAME', () => {
  const lines = [
    '**FREE',
    '  dcl-f CLIENTI usage(*update:*delete) keyed;',
    '  dcl-f STAMPA printer;',
    "  dcl-pr Invia extpgm('SNDPGM'); end-pr;",
    "  dcl-pr Calcola extproc('CALC_TAX'); end-pr;",
    "  dcl-s Lim packed(5) dtaara('MYLIB/LIMITI');",
    '  dcl-ds Rec extname(\'ANAGRAF\') qualified end-ds;',
    '  /copy QCPYSRC,PROTO',
    '  // dcl-f COMMENTATO;',
  ];
  const r = extractRefs('rpg', lines);
  assert.deepEqual(names(r, 'file'), ['ANAGRAF', 'CLIENTI', 'STAMPA']);
  assert.deepEqual(names(r, 'programma'), ['SNDPGM']);
  assert.deepEqual(names(r, 'procedura'), ['CALC_TAX']);
  assert.deepEqual(names(r, 'dataarea'), ['MYLIB/LIMITI']);
  assert.deepEqual(names(r, 'copy'), ['QCPYSRC,PROTO']);
});

test('RPG: SQL incorporato su più righe', () => {
  const lines = [
    '     C/EXEC SQL SELECT NOME INTO :nome',
    '     C+         FROM CLIENTI c',
    '     C+         JOIN MYLIB.ORDINI o ON o.ID = c.ID',
    '     C+         WHERE c.ID = :id',
    '     C/END-EXEC',
    '       exec sql call MYLIB.AGGIORNA(:x);',
    '       exec sql update TABELLA2 set a = 1;',
  ];
  const r = extractRefs('rpg', lines);
  assert.deepEqual(names(r, 'tabella_sql'), ['CLIENTI', 'MYLIB.ORDINI', 'TABELLA2']);
  assert.deepEqual(names(r, 'programma'), ['MYLIB.AGGIORNA']);
});

test('CL: CALL, DCLF, OVRDBF, CPYF, DTAARA, continuazioni, commenti', () => {
  const lines = [
    'PGM',
    '  DCLF FILE(MYLIB/VIDEO1)',
    '  /* CALL PGM(COMMENTATO) */',
    '  CALL PGM(MYLIB/ELABORA) PARM(&A)',
    '  CALL PGMAUX',
    '  CALL PGM(&DINAMICO)',
    '  OVRDBF FILE(INPUT) TOFILE(MYLIB/DATI) +',
    '         SHARE(*YES)',
    '  CPYF FROMFILE(MYLIB/A) TOFILE(MYLIB/B) MBROPT(*REPLACE)',
    '  RTVDTAARA DTAARA(MYLIB/PARAMS) RTNVAR(&P)',
    '  SBMJOB CMD(CALL PGM(BATCH1)) JOB(NOTTE)',
    '  IF COND(&A *EQ 1) THEN(DO)',
    '  ENDDO',
    'ENDPGM',
  ];
  const r = extractRefs('cl', lines);
  assert.deepEqual(names(r, 'programma'), ['BATCH1', 'MYLIB/ELABORA', 'PGMAUX']);
  assert.deepEqual(names(r, 'file'), ['MYLIB/A', 'MYLIB/B', 'MYLIB/DATI', 'MYLIB/VIDEO1']);
  assert.deepEqual(names(r, 'dataarea'), ['MYLIB/PARAMS']);
  const cmds = names(r, 'comando');
  for (const c of ['OVRDBF', 'CPYF', 'RTVDTAARA', 'SBMJOB']) assert.ok(cmds.includes(c), c);
  assert.ok(!cmds.includes('IF') && !cmds.includes('PGM') && !cmds.includes('CALL'));
});

test('DDS: formato, chiavi, PFILE/JFILE/REF', () => {
  const lines = [
    '     A          R CLIREC                    PFILE(MYLIB/CLIENTI)',
    '     A          K CODCLI',
    '     A          K DATA                      DESCEND',
    '     A*         K COMMENTO',
    '     A          S STATO                     COMP(EQ \'A\')',
    '     A                                      REF(MYLIB/RIFERIMENTO)',
    '     A                                      JFILE(MYLIB/UNO MYLIB/DUE)',
  ];
  const r = extractRefs('dds', lines);
  assert.deepEqual(names(r, 'formato_record'), ['CLIREC']);
  assert.deepEqual(names(r, 'chiave'), ['CODCLI', 'DATA']);
  assert.equal(r.find((x) => x.nome === 'DATA')?.dettaglio, 'DESC');
  assert.deepEqual(names(r, 'file'), ['MYLIB/CLIENTI', 'MYLIB/DUE', 'MYLIB/RIFERIMENTO', 'MYLIB/UNO']);
});
