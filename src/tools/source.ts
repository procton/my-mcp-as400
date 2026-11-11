import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { normalizedQuery, getPool, likeP } from '../pool.js';
import { getConfig, objName } from '../config.js';
import { text, json, tool, capText, pick, numberLines } from './common.js';
import type { ToolResult } from './common.js';

const inputList = {
  libreria: z.string().describe('Libreria contenente il file sorgente (max 10 caratteri)'),
  file: z.string().optional().describe('Nome del file sorgente (es. QRPGSRC, QCLSRC). Se omesso elenca i file sorgente della libreria'),
  filtro: z.string().optional().describe('Filtro nome (SQL LIKE: % e _)'),
};

/** Elenca file sorgente di una libreria, oppure i membri di un file sorgente. */
export const sourceList = tool<
  z.infer<z.ZodObject<typeof inputList>>
>(async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const lib = objName(args.libreria, 'libreria');

  if (!args.file) {
    const rows = await normalizedQuery(
      `SELECT SYSTEM_TABLE_SCHEMA AS LIBRERIA, SYSTEM_TABLE_NAME AS FILE, TABLE_TEXT AS DESCRIZIONE
         FROM QSYS2.SYSTABLES
        WHERE SYSTEM_TABLE_SCHEMA = ? AND FILE_TYPE = 'S'
        ORDER BY SYSTEM_TABLE_NAME`,
      [lib],
    );
    if (rows.length === 0) {
      return json({ libreria: lib, file_sorgente: [], nota: 'nessun file sorgente (FILE_TYPE=S) in questa libreria' });
    }
    return json({ libreria: lib, file_sorgente: rows });
  }

  const file = objName(args.file, 'file');
  // il filtro è applicato lato SQL (LIKE) sul nome membro
  const rows = await normalizedQuery(
    `SELECT SYSTEM_TABLE_MEMBER AS MEMBRO, PARTITION_TEXT AS DESCRIZIONE, SOURCE_TYPE AS TIPO,
            NUMBER_ROWS AS RIGHE, LAST_SOURCE_UPDATE_TIMESTAMP AS MODIFICATO, LAST_USED_TIMESTAMP AS ULTIMO_USO
       FROM QSYS2.SYSPARTITIONSTAT
      WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? AND SYSTEM_TABLE_MEMBER LIKE ?
      ORDER BY SYSTEM_TABLE_MEMBER`,
    [lib, file, likeP(args.filtro)],
  );
  let members = rows.map((r) => ({
    membro: String(pick(r, 'MEMBRO') ?? ''),
    descrizione: pick(r, 'DESCRIZIONE') ?? null,
    tipo: pick(r, 'TIPO') ?? null,
    righe: pick(r, 'RIGHE') ?? null,
    modificato: pick(r, 'MODIFICATO') ?? null,
    ultimo_uso: pick(r, 'ULTIMO_USO') ?? null,
  }));
  const truncated = members.length > cfg.sourceMaxMembers;
  if (truncated) members = members.slice(0, cfg.sourceMaxMembers);
  return json({
    libreria: lib,
    file,
    membri: members.length,
    troncato: truncated || undefined,
    elenco: members,
  });
});

const inputRead = {
  libreria: z.string().describe('Libreria del file sorgente (max 10 caratteri)'),
  file: z.string().describe('Nome del file sorgente (es. QRPGSRC)'),
  membro: z.string().describe('Nome del membro da leggere'),
  numeriRiga: z.boolean().optional().describe('Prefissa ogni riga con il numero progressivo (default true)'),
  daRiga: z.number().int().min(1).optional().describe('Riga di partenza (1-based), per leggere in blocchi'),
  aRiga: z.number().int().min(1).optional().describe('Riga di fine inclusa'),
};

/** Legge il testo di un membro sorgente (RPG, CL, DDS, ...) tramite alias QTEMP. */
export const sourceRead = tool<
  z.infer<z.ZodObject<typeof inputRead>>
>(async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  if (!cfg.allowQtempAlias) {
    throw new Error("La lettura dei membri richiede alias temporanei: imposta ALLOW_QTEMP_ALIAS=true");
  }
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const membro = objName(args.membro, 'membro');
  const alias = 'MCPA' + randomBytes(4).toString('hex').toUpperCase();

  // CREATE ALIAS + SELECT devono girare sulla STESSA connessione (stesso job):
  // QTEMP è per-job, quindi si usa un contesto di transazione dedicato del pool.
  const rows = (await getPool().transaction(
    async (tx: {
      query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
      update: (sql: string, params?: unknown[]) => Promise<number>;
    }) => {
      // DDL: update() e non query() (altrimenti "Cursor state not valid"); membro tra doppi apici
      await tx.update(`CREATE OR REPLACE ALIAS QTEMP.${alias} FOR ${lib}.${file} ("${membro}")`);
      try {
        return await tx.query(`SELECT SRCSEQ, SRCDTA FROM QTEMP.${alias} ORDER BY SRCSEQ`);
      } finally {
        try {
          await tx.update(`DROP ALIAS QTEMP.${alias}`);
        } catch { /* ignora */ }
      }
    },
  )) as Record<string, unknown>[];
  const lines = rows.map((r) => String(pick(r, 'SRCDTA') ?? '').replace(/\s+$/, ''));
  const start = args.daRiga !== undefined ? args.daRiga - 1 : 0;
  const end = args.aRiga !== undefined ? args.aRiga : start + cfg.sourceMaxLines;
  let sliced = lines.slice(start, end);
  const truncated = sliced.length > cfg.sourceMaxLines;
  if (truncated) sliced = sliced.slice(0, cfg.sourceMaxLines);
  const body = args.numeriRiga === false ? sliced.join('\n') : numberLines(sliced, start + 1);
  const meta: Record<string, unknown> = {
    libreria: lib, file, membro, righe_totali: lines.length,
    prima_riga: sliced.length ? start + 1 : 0,
  };
  if (truncated || (args.aRiga === undefined && start + sliced.length < lines.length)) {
    meta.nota = `troncato a ${cfg.sourceMaxLines} righe (SOURCE_MAX_LINES); usa daRiga/aRiga per leggere il resto`;
  }
  return text(`${JSON.stringify(meta)}\n${capText(body, cfg.sourceMaxChars, 'sorgente')}`);
});
