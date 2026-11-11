import { z } from 'zod';
import { normalizedQuery } from '../pool.js';
import { getConfig, objName } from '../config.js';
import { json, tool, pick } from './common.js';
import type { ToolResult } from './common.js';

const inputQuery = {
  query: z.string().describe('Istruzione SQL di sola lettura (SELECT o WITH); un solo statement, senza punto e virgola'),
  parametri: z.array(z.union([z.string(), z.number(), z.null()])).optional()
    .describe('Parametri per i marker ? (facoltativo)'),
};

/** Valida una query read-only e ne restituisce il testo normalizzato (senza `;` finale). */
export function validateReadOnlySql(query: string): string {
  const q = query.trim().replace(/;+\s*$/, '');
  if (q.includes(';')) throw new Error('Un solo statement SQL, senza punto e virgola');
  if (!/^(SELECT|WITH)\b/i.test(q)) throw new Error('Ammesse solo istruzioni SELECT o WITH (server read-only)');
  if (/\bFOR\s+UPDATE\b/i.test(q)) throw new Error('FOR UPDATE non consentito (server read-only)');
  return q;
}

/** Esegue una SELECT read-only con limite di righe. */
export const sqlQuery = tool<
  z.infer<z.ZodObject<typeof inputQuery>>
>(async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const q = validateReadOnlySql(args.query);
  const final = /\bFETCH\s+FIRST\b/i.test(q) ? q : `${q} FETCH FIRST ${cfg.sqlMaxRows} ROWS ONLY`;
  const rows = await normalizedQuery(final, args.parametri ?? []);
  return json({ righe: rows.length, dati: rows });
});

const inputDesc = {
  libreria: z.string().describe('Libreria del file (max 10 caratteri)'),
  file: z.string().describe('Nome del file fisico o logico (max 10 caratteri)'),
};

/** Descrive un file fisico/logico: oggetto, campi, chiavi, tipo. */
export const fileDesc = tool<
  z.infer<z.ZodObject<typeof inputDesc>>
>(async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');

  const objs = await normalizedQuery(
    `SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*FILE', ?))`,
    [lib, file],
  );
  if (objs.length === 0) throw new Error(`File non trovato: ${lib}/${file}`);
  const obj = objs[0];

  const srcRows = await normalizedQuery(
    `SELECT FILE_TYPE FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?`,
    [lib, file],
  );
  const fileType = String(pick(srcRows[0] ?? {}, 'FILE_TYPE') ?? '');

  const cols = await normalizedQuery(
    `SELECT SYSTEM_COLUMN_NAME AS CAMPO, ORDINAL_POSITION AS POS,
            DATA_TYPE AS TIPO, LENGTH AS LUNGHEZZA, NUMERIC_SCALE AS DECIMALI,
            IS_NULLABLE AS NULL_ABLE, COLUMN_DEFAULT AS DEFAULT_
       FROM QSYS2.SYSCOLUMNS
      WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [lib, file],
  );

  const keys = await normalizedQuery(
    `SELECT CONSTRAINT_NAME AS CHIAVE, COLUMN_NAME AS CAMPO, ORDINAL_POSITION AS POS
       FROM QSYS2.SYSKEYCST
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [lib, file],
  );

  return json({
    libreria: lib,
    file,
    tipo: fileType === 'S' ? 'FILE SORGENTE (usa as400_source_list / as400_source_read)' : fileType,
    descrizione: pick(obj, 'OBJTEXT') ?? null,
    creato: pick(obj, 'OBJCREATED') ?? null,
    ultimo_uso: pick(obj, 'LAST_USED_TIMESTAMP') ?? null,
    campi: cols,
    chiavi: keys,
    esempio: `SELECT * FROM ${lib}.${file} FETCH FIRST 10 ROWS ONLY`,
  });
});
