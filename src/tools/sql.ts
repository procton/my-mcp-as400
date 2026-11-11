import { z } from 'zod';
import { normalizedQuery } from '../pool.js';
import { getConfig, objName } from '../config.js';
import { guardReadOnlySql } from '../sqlguard.js';
import { json, tool, pick } from './common.js';
import type { ToolResult } from './common.js';

const inputQuery = {
  query: z.string().describe('Istruzione SQL di sola lettura (SELECT o WITH); un solo statement, senza punto e virgola'),
  parametri: z.array(z.union([z.string(), z.number(), z.null()])).optional()
    .describe('Parametri per i marker ? (facoltativo)'),
};

/** Valida una query read-only (guardia lessicale + allow-list) e applica il limite di righe. */
export function validateReadOnlySql(query: string, allowedLibs: string[] | null = null, maxRows = 1000): string {
  return guardReadOnlySql(query, { allowedLibs, maxRows }).sql;
}

/** Esegue una SELECT read-only con limite di righe. */
export const sqlQuery = tool<
  z.infer<z.ZodObject<typeof inputQuery>>
>('as400_sql_query', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const g = guardReadOnlySql(args.query, { allowedLibs: cfg.allowedLibs, maxRows: cfg.sqlMaxRows });
  let rows = await normalizedQuery(g.sql, args.parametri ?? []);
  // difesa in profondità: anche con un FETCH FIRST esplicito dell'utente il tetto resta SQL_MAX_ROWS
  const troncato = rows.length > cfg.sqlMaxRows;
  if (troncato) rows = rows.slice(0, cfg.sqlMaxRows);
  return json({ righe: rows.length, troncato: troncato || undefined, dati: rows });
});

const inputDesc = {
  libreria: z.string().describe('Libreria del file (max 10 caratteri)'),
  file: z.string().describe('Nome del file fisico o logico (max 10 caratteri)'),
};

/** Descrive un file fisico/logico: oggetto, campi, chiavi, tipo. */
export const fileDesc = tool<
  z.infer<z.ZodObject<typeof inputDesc>>
>('as400_file_desc', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');

  const objs = await normalizedQuery(
    `SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*FILE', ?))`,
    [lib, file],
  );
  if (objs.length === 0) throw new Error(`File non trovato: ${lib}/${file}`);
  const obj = objs[0];

  const srcRows = await normalizedQuery(
    `SELECT FILE_TYPE, TABLE_TYPE FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?`,
    [lib, file],
  );
  const fileType = String(pick(srcRows[0] ?? {}, 'FILE_TYPE') ?? '');
  const tableType = String(pick(srcRows[0] ?? {}, 'TABLE_TYPE') ?? '');
  const TIPI: Record<string, string> = { T: 'tabella SQL', P: 'file fisico (PF)', L: 'file logico (LF)', V: 'vista', M: 'MQT', A: 'alias' };

  const cols = await normalizedQuery(
    `SELECT SYSTEM_COLUMN_NAME AS CAMPO, ORDINAL_POSITION AS POS,
            DATA_TYPE AS TIPO, LENGTH AS LUNGHEZZA, NUMERIC_SCALE AS DECIMALI,
            IS_NULLABLE AS NULL_ABLE, COLUMN_TEXT AS DESCRIZIONE, COLUMN_HEADING AS INTESTAZIONE, CCSID
       FROM QSYS2.SYSCOLUMNS
      WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [lib, file],
  );

  const keys = await normalizedQuery(
    `SELECT CONSTRAINT_NAME AS CHIAVE, SYSTEM_COLUMN_NAME AS CAMPO, ORDINAL_POSITION AS POS
       FROM QSYS2.SYSKEYCST
      WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [lib, file],
  );

  // chiave DDS del file (PF con chiave): non compare in SYSKEYCST
  let chiaveDds: unknown[] = [];
  try {
    const kr = await normalizedQuery(
      `SELECT DBKFLD, DBKORD FROM QSYS.QADBKFLD WHERE DBKLIB = ? AND DBKFIL = ? ORDER BY DBKPOS`,
      [lib, file],
    );
    chiaveDds = kr.map((r) => ({ campo: pick(r, 'DBKFLD'), ordine: pick(r, 'DBKORD') === 'D' ? 'DESC' : 'ASC' }));
  } catch { /* non fatale */ }

  return json({
    libreria: lib,
    file,
    tipo: fileType === 'S' ? 'FILE SORGENTE (usa as400_source_list / as400_source_read)' : (TIPI[tableType] ?? tableType),
    descrizione: pick(obj, 'OBJTEXT') ?? null,
    creato: pick(obj, 'OBJCREATED') ?? null,
    ultimo_uso: pick(obj, 'LAST_USED_TIMESTAMP') ?? null,
    campi: cols,
    chiave_dds: chiaveDds,
    vincoli_chiave: keys,
    dettagli_oggetti: 'usa as400_index_list, as400_where_used, as400_constraints per logici, dipendenze e vincoli',
    esempio: `SELECT * FROM ${lib}.${file} FETCH FIRST 10 ROWS ONLY`,
  });
});
