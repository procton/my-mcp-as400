import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { extractRefs, familyOf, type RefKind } from '../srcanalysis.js';
import { nameCond } from './catalog.js';
import { normalizedQuery, getAliasPool, withTimeout, likeP } from '../pool.js';
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
>('as400_source_list', async (args): Promise<ToolResult> => {
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

/** Lettura di un membro (righe con le colonne originali) tramite alias QTEMP sul pool dedicato. */
export async function readMemberLines(lib: string, file: string, membro: string): Promise<string[]> {
  const cfg = getConfig();
  if (!cfg.allowQtempAlias) {
    throw new Error('La lettura dei membri richiede alias temporanei: imposta ALLOW_QTEMP_ALIAS=true');
  }
  const alias = 'MCPA' + randomBytes(4).toString('hex').toUpperCase();
  // CREATE ALIAS + SELECT devono girare sulla STESSA connessione (stesso job):
  // QTEMP è per-job, quindi si usa un contesto di transazione dedicato del pool.
  const rows = (await withTimeout(getAliasPool().transaction(
    async (tx: AliasTx) => {
      // DDL: update() e non query() (altrimenti "Cursor state not valid"); membro tra doppi apici
      await tx.update(`CREATE OR REPLACE ALIAS QTEMP.${alias} FOR ${lib}.${file} ("${membro}")`);
      try {
        // trim:false: le colonne iniziali (RPG fixed-format, col. 6 = tipo di specifica) devono restare
        return await tx.query(`SELECT SRCSEQ, SRCDTA FROM QTEMP.${alias} ORDER BY SRCSEQ`, [], { trim: false });
      } finally {
        try {
          await tx.update(`DROP ALIAS QTEMP.${alias}`);
        } catch { /* ignora */ }
      }
    },
  ), cfg.sqlTimeoutMs, 'lettura membro')) as Record<string, unknown>[];
  return rows.map((r) => String(pick(r, 'SRCDTA') ?? '').replace(/\s+$/, ''));
}

interface AliasTx {
  query: (sql: string, params?: unknown[], opts?: { trim: boolean }) => Promise<Record<string, unknown>[]>;
  update: (sql: string, params?: unknown[]) => Promise<number>;
}

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
>('as400_source_read', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const membro = objName(args.membro, 'membro');
  const lines = await readMemberLines(lib, file, membro);
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

/* ---------------- ricerca testuale nei membri ---------------- */

const SAFE_NAME = /^[A-Z0-9_$#@]{1,10}$/;

const inputSearch = {
  libreria: z.string().describe('Libreria dei file sorgente (max 10 caratteri)'),
  testo: z.string().min(2).describe('Testo da cercare (sottostringa, non regex)'),
  file: z.string().optional().describe('File sorgente (SQL LIKE, es. QRPGLESRC o Q%SRC); default tutti i file sorgente della libreria'),
  membro: z.string().optional().describe('Filtro nome membro (SQL LIKE)'),
  maiuscole: z.boolean().optional().describe('Distingue maiuscole/minuscole (default false)'),
  limite: z.number().int().min(1).max(1000).optional().describe('Massimo di righe trovate (default 100)'),
  maxMembri: z.number().int().min(1).optional().describe('Massimo di membri da scansionare (default SEARCH_MAX_MEMBERS=150)'),
};

/** Cerca un testo in tutti i membri sorgente di una libreria (alias in batch + UNION ALL lato server). */
export const sourceSearch = tool<
  z.infer<z.ZodObject<typeof inputSearch>>
>('as400_source_search', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  if (!cfg.allowQtempAlias) throw new Error('La ricerca nei membri richiede alias temporanei: imposta ALLOW_QTEMP_ALIAS=true');
  const lib = objName(args.libreria, 'libreria');
  const needle = args.testo.trim();
  if (needle.length < 2) throw new Error('Il testo da cercare deve avere almeno 2 caratteri');
  const limite = args.limite ?? 100;
  const maxMembri = Math.min(args.maxMembri ?? cfg.searchMaxMembers, 400);
  const caseSens = args.maiuscole === true;

  const fcond = nameCond('t.SYSTEM_TABLE_NAME', args.file);
  const mcond = nameCond('RTRIM(p.SYSTEM_TABLE_MEMBER)', args.membro);
  const members = await normalizedQuery(
    `SELECT RTRIM(t.SYSTEM_TABLE_NAME) AS F, RTRIM(p.SYSTEM_TABLE_MEMBER) AS M
       FROM QSYS2.SYSTABLES t
       JOIN QSYS2.SYSPARTITIONSTAT p ON p.SYSTEM_TABLE_SCHEMA = t.SYSTEM_TABLE_SCHEMA AND p.SYSTEM_TABLE_NAME = t.SYSTEM_TABLE_NAME
      WHERE t.SYSTEM_TABLE_SCHEMA = ? AND t.FILE_TYPE = 'S' AND ${fcond.sql} AND ${mcond.sql}
      ORDER BY 1, 2
      FETCH FIRST ${maxMembri + 1} ROWS ONLY`,
    [lib, fcond.param, mcond.param],
  );
  const truncMembers = members.length > maxMembri;
  const todo = members.slice(0, maxMembri)
    .map((r) => ({ f: String(pick(r, 'F')), m: String(pick(r, 'M')) }))
    .filter((x) => SAFE_NAME.test(x.f) && SAFE_NAME.test(x.m));

  // escape di % _ \ per la LIKE
  const pattern = '%' + (caseSens ? needle : needle.toUpperCase()).replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
  const col = caseSens ? 'SRCDTA' : 'UPPER(SRCDTA)';
  const found: Array<{ file: string; membro: string; riga: number; testo: string }> = [];
  const BATCH = 40;
  const deadline = Date.now() + cfg.searchTimeoutMs;
  let scanned = 0;
  let timedOut = false;
  for (let i = 0; i < todo.length && found.length < limite; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const left = deadline - Date.now();
    if (left <= 0) { timedOut = true; break; }
    const rows = (await withTimeout(getAliasPool().transaction(async (tx: AliasTx) => {
      const names: string[] = [];
      try {
        for (let k = 0; k < batch.length; k++) {
          const a = `MCPS${k}`;
          await tx.update(`CREATE OR REPLACE ALIAS QTEMP.${a} FOR ${lib}.${batch[k].f} ("${batch[k].m}")`);
          names.push(a);
        }
        const sql = names.map((a, k) =>
          `SELECT * FROM (SELECT '${batch[k].f}' AS F, '${batch[k].m}' AS M, ROW_NUMBER() OVER (ORDER BY SRCSEQ) AS N, SRCDTA FROM QTEMP.${a}) X${k} WHERE ${col} LIKE ? ESCAPE '\\'`,
        ).join(' UNION ALL ');
        return await tx.query(`${sql} FETCH FIRST ${limite - found.length} ROWS ONLY`, names.map(() => pattern), { trim: false });
      } finally {
        for (const a of names) {
          try { await tx.update(`DROP ALIAS QTEMP.${a}`); } catch { /* ignora */ }
        }
      }
    }), left, 'ricerca nei sorgenti')) as Record<string, unknown>[];
    scanned += batch.length;
    for (const r of rows) {
      found.push({
        file: String(pick(r, 'F')),
        membro: String(pick(r, 'M')),
        riga: Number(pick(r, 'N')),
        testo: String(pick(r, 'SRCDTA') ?? '').replace(/\s+$/, '').slice(0, 220),
      });
    }
  }
  const out: Record<string, unknown> = {
    libreria: lib,
    cercato: needle,
    membri_scansionati: scanned,
    trovate: found.length,
    risultati: found,
  };
  const note: string[] = [];
  if (found.length >= limite) note.push(`raggiunto il limite di ${limite} righe (alcuni membri possono non essere stati scansionati)`);
  if (truncMembers) note.push(`elenco membri troncato a ${maxMembri}: restringi con 'file'/'membro' o aumenta 'maxMembri'`);
  if (timedOut) note.push(`tempo massimo di ricerca (${cfg.searchTimeoutMs} ms) raggiunto`);
  if (members.length !== todo.length + (truncMembers ? 1 : 0)) note.push('alcuni membri con nomi non standard sono stati saltati');
  if (note.length) out.nota = note.join('; ');
  return json(out);
});

/* ---------------- riferimenti di un sorgente ---------------- */

const inputRefs = {
  libreria: z.string().describe('Libreria del file sorgente'),
  file: z.string().describe('File sorgente (es. QRPGLESRC)'),
  membro: z.string().describe('Membro da analizzare'),
  tipo: z.string().optional().describe('Tipo sorgente (RPGLE, CLLE, PF, ...); se omesso è letto dal membro'),
};

/** Estrae file, programmi chiamati, copy, data area, tabelle SQL e comandi usati da un membro sorgente. */
export const sourceRefs = tool<
  z.infer<z.ZodObject<typeof inputRefs>>
>('as400_source_refs', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const membro = objName(args.membro, 'membro');
  let tipo = args.tipo?.trim().toUpperCase();
  if (!tipo) {
    const t = await normalizedQuery(
      `SELECT SOURCE_TYPE FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? AND SYSTEM_TABLE_MEMBER = ?`,
      [lib, file, membro],
    );
    if (t.length === 0) throw new Error(`Membro non trovato: ${lib}/${file}(${membro})`);
    tipo = String(pick(t[0], 'SOURCE_TYPE') ?? '').trim().toUpperCase();
  }
  const lines = await readMemberLines(lib, file, membro);
  const family = familyOf(tipo);
  const refs = extractRefs(family, lines);
  const group = (k: RefKind): unknown[] =>
    refs.filter((r) => r.tipo === k).map((r) => ({ nome: r.nome, dettaglio: r.dettaglio, righe: r.righe }));
  return json({
    libreria: lib, file, membro, tipo_sorgente: tipo || null, famiglia: family, righe: lines.length,
    file_usati: group('file'),
    programmi_chiamati: group('programma'),
    procedure: group('procedura'),
    copy_include: group('copy'),
    data_area: group('dataarea'),
    tabelle_sql: group('tabella_sql'),
    comandi_cl: group('comando'),
    formati_record: group('formato_record'),
    chiavi: group('chiave'),
    nota: 'Analisi statica euristica: chiamate dinamiche (nome in variabile), copy annidati e membri non risolti non sono rilevati.',
  });
});
