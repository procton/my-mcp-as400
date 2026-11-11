import { z } from 'zod';
import { normalizedQuery } from '../pool.js';
import { getConfig, objName } from '../config.js';
import { t, paramName } from '../i18n.js';
import { json, tool, pick, tableTypeLabel } from './common.js';
import type { ToolResult } from './common.js';
import { likeP } from '../pool.js';

/** Condizione di confronto nome: `=` se il pattern non ha jolly (le colonne CHAR sono con spazi di riempimento
 * e `LIKE 'ABC'` non le trova), altrimenti `LIKE`. */
export function nameCond(col: string, pattern: string | undefined): { sql: string; param: string } {
  const p = likeP(pattern);
  return /[%_]/.test(p) ? { sql: `${col} LIKE ?`, param: p } : { sql: `${col} = ?`, param: p };
}

function cap(requested: number | undefined): number {
  const max = getConfig().sqlMaxRows;
  return Math.min(Math.max(requested ?? 200, 1), max);
}

function limited<T>(rows: T[], limite: number): { righe: T[]; nota?: string } {
  return rows.length >= limite
    ? {
        righe: rows,
        nota: t({
          it: "raggiunto il limite di {n} risultati: restringi il filtro o aumenta '{limite}'",
          en: "reached the limit of {n} results: narrow the filter or raise '{limite}'",
        }, { n: limite, limite: paramName('limite') }),
      }
    : { righe: rows };
}

const limiteSchema = z.number().int().min(1).optional();

/* ---------- schemi / librerie ---------- */

const inputSchemas = {
  filtro: z.string().optional(),
  limite: limiteSchema,
};

export const schemaList = tool<z.infer<z.ZodObject<typeof inputSchemas>>>('as400_schema_list', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const lim = cap(args.limite);
  const fc = nameCond('SYSTEM_SCHEMA_NAME', args.filtro);
  const params: unknown[] = [fc.param];
  let allow = '';
  if (cfg.allowedLibs) {
    allow = ` AND SYSTEM_SCHEMA_NAME IN (${cfg.allowedLibs.map(() => '?').join(',')})`;
    params.push(...cfg.allowedLibs);
  }
  const rows = await normalizedQuery(
    `SELECT SYSTEM_SCHEMA_NAME AS LIBRERIA, SCHEMA_NAME AS NOME_SQL, SCHEMA_TEXT AS DESCRIZIONE,
            SCHEMA_OWNER AS PROPRIETARIO, CREATION_TIMESTAMP AS CREATA
       FROM QSYS2.SYSSCHEMAS
      WHERE ${fc.sql}${allow}
      ORDER BY SYSTEM_SCHEMA_NAME
      FETCH FIRST ${lim} ROWS ONLY`,
    params,
  );
  const l = limited(rows, lim);
  return json({ librerie: l.righe.length, nota: l.nota, elenco: l.righe });
});

/* ---------- tabelle / viste / file ---------- */

const inputTables = {
  libreria: z.string(),
  tipo: z.enum(['tutti', 'fisici', 'logici', 'viste', 'sorgenti']).optional(),
  filtro: z.string().optional(),
  testo: z.string().optional(),
  limite: limiteSchema,
};

export const tableList = tool<z.infer<z.ZodObject<typeof inputTables>>>('as400_table_list', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const lim = cap(args.limite);
  const fa = nameCond('SYSTEM_TABLE_NAME', args.filtro);
  const fb = nameCond('UPPER(TABLE_NAME)', args.filtro);
  const params: unknown[] = [lib, fa.param, fb.param];
  let tipo = '';
  switch (args.tipo) {
    case 'fisici': tipo = " AND FILE_TYPE = 'D' AND TABLE_TYPE IN ('T','P')"; break;
    case 'logici': tipo = " AND TABLE_TYPE = 'L'"; break;
    case 'viste': tipo = " AND TABLE_TYPE = 'V'"; break;
    case 'sorgenti': tipo = " AND FILE_TYPE = 'S'"; break;
  }
  let testo = '';
  if (args.testo) {
    testo = ' AND UPPER(TABLE_TEXT) LIKE ?';
    params.push(`%${args.testo.trim().toUpperCase()}%`);
  }
  const rows = await normalizedQuery(
    `SELECT SYSTEM_TABLE_NAME, TABLE_NAME, TABLE_TYPE, FILE_TYPE, TABLE_TEXT, COLUMN_COUNT, ROW_LENGTH,
            SELECT_OMIT
       FROM QSYS2.SYSTABLES
      WHERE SYSTEM_TABLE_SCHEMA = ? AND (${fa.sql} OR ${fb.sql})${tipo}${testo}
      ORDER BY SYSTEM_TABLE_NAME
      FETCH FIRST ${lim} ROWS ONLY`,
    params,
  );
  const mapped = rows.map((r) => {
    const tt = String(pick(r, 'TABLE_TYPE') ?? '');
    const sysName = String(pick(r, 'SYSTEM_TABLE_NAME') ?? '');
    const sqlName = String(pick(r, 'TABLE_NAME') ?? '');
    return {
      file: sysName,
      nome_sql: sqlName !== sysName ? sqlName : undefined,
      tipo: pick(r, 'FILE_TYPE') === 'S' ? t({ it: 'file sorgente', en: 'source file' }) : (tableTypeLabel(tt) ?? tt),
      descrizione: pick(r, 'TABLE_TEXT') ?? null,
      campi: pick(r, 'COLUMN_COUNT') ?? null,
      lunghezza_record: pick(r, 'ROW_LENGTH') ?? null,
      select_omit: pick(r, 'SELECT_OMIT') === 'Y' || pick(r, 'SELECT_OMIT') === 'S' ? true : undefined,
    };
  });
  const l = limited(mapped, lim);
  return json({ libreria: lib, oggetti: l.righe.length, nota: l.nota, elenco: l.righe });
});

/* ---------- ricerca campi ---------- */

const inputColumns = {
  libreria: z.string(),
  campo: z.string().optional(),
  testo: z.string().optional(),
  file: z.string().optional(),
  limite: limiteSchema,
};

export const columnSearch = tool<z.infer<z.ZodObject<typeof inputColumns>>>('as400_column_search', async (args): Promise<ToolResult> => {
  if (!args.campo && !args.testo) {
    throw new Error(t({
      it: "Indica almeno '{campo}' o '{testo}' (le scansioni senza filtro sono molto lente)",
      en: "Provide at least '{campo}' or '{testo}' (unfiltered scans are very slow)",
    }, { campo: paramName('campo'), testo: paramName('testo') }));
  }
  const lib = objName(args.libreria, 'libreria');
  const lim = cap(args.limite);
  const ff = nameCond('SYSTEM_TABLE_NAME', args.file);
  const params: unknown[] = [lib, ff.param];
  let where = '';
  if (args.campo) {
    const ca = nameCond('SYSTEM_COLUMN_NAME', args.campo);
    const cb = nameCond('UPPER(COLUMN_NAME)', args.campo);
    where += ` AND (${ca.sql} OR ${cb.sql})`;
    params.push(ca.param, cb.param);
  }
  if (args.testo) {
    where += ' AND (UPPER(COLUMN_TEXT) LIKE ? OR UPPER(COLUMN_HEADING) LIKE ?)';
    const like = `%${args.testo.trim().toUpperCase()}%`;
    params.push(like, like);
  }
  const rows = await normalizedQuery(
    `SELECT SYSTEM_TABLE_NAME, SYSTEM_COLUMN_NAME, COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, COLUMN_TEXT, COLUMN_HEADING
       FROM QSYS2.SYSCOLUMNS
      WHERE SYSTEM_TABLE_SCHEMA = ? AND ${ff.sql}${where}
      ORDER BY SYSTEM_TABLE_NAME, ORDINAL_POSITION
      FETCH FIRST ${lim} ROWS ONLY`,
    params,
  );
  const mapped = rows.map((r) => ({
    file: pick(r, 'SYSTEM_TABLE_NAME'),
    campo: pick(r, 'SYSTEM_COLUMN_NAME'),
    nome_sql: pick(r, 'COLUMN_NAME') !== pick(r, 'SYSTEM_COLUMN_NAME') ? pick(r, 'COLUMN_NAME') : undefined,
    tipo: pick(r, 'DATA_TYPE'),
    lunghezza: pick(r, 'LENGTH'),
    decimali: pick(r, 'NUMERIC_SCALE') ?? undefined,
    descrizione: pick(r, 'COLUMN_TEXT') ?? pick(r, 'COLUMN_HEADING') ?? null,
  }));
  const l = limited(mapped, lim);
  return json({ libreria: lib, trovati: l.righe.length, nota: l.nota, elenco: l.righe });
});

/* QSYS.QADBFDEP (dipendenze tra file, la stessa fonte di DSPDBR), QSYS.QADBKFLD (campi chiave) e
 * QSYS.QADBXREF (attributi) coprono PF/LF DDS, indici e viste SQL: il catalogo QSYS2 non riporta il
 * legame PF -> LF dei file DDS né le loro chiavi. */

interface KeyField { campo: string; ordine: 'ASC' | 'DESC' }

/** Campi chiave (ordinati) di uno o più file; mappa `LIB/FILE` -> chiavi. */
async function keysFor(sql: string, params: unknown[]): Promise<Map<string, KeyField[]>> {
  const rows = await normalizedQuery(sql, params);
  const out = new Map<string, KeyField[]>();
  for (const r of rows) {
    const k = `${pick(r, 'LIB')}/${pick(r, 'FILE')}`;
    const list = out.get(k) ?? [];
    list.push({ campo: String(pick(r, 'CAMPO') ?? ''), ordine: pick(r, 'ORD') === 'D' ? 'DESC' : 'ASC' });
    out.set(k, list);
  }
  return out;
}

export interface Dependent {
  oggetto: string;
  tipo: string | null;
  descrizione: string | null;
  formato: unknown;
  univoco?: boolean;
  select_omit?: boolean;
  chiavi?: KeyField[];
}

/** Logici, indici e viste che dipendono da un file, con le loro chiavi. */
async function dependents(lib: string, file: string, max: number, withKeys: boolean): Promise<Dependent[]> {
  const rows = await normalizedQuery(
    `SELECT d.DBFLDP AS LIB, d.DBFFDP AS FILE, d.DBFRDP AS FORMATO,
            t.TABLE_TYPE AS TIPO, t.TABLE_TEXT AS TESTO, x.DBXUNQ AS UNQ, x.DBXSO AS SO, x.DBXTXT AS XTESTO,
            (SELECT COUNT(*) FROM QSYS2.SYSINDEXES i WHERE i.SYSTEM_INDEX_SCHEMA = d.DBFLDP AND i.SYSTEM_INDEX_NAME = d.DBFFDP) AS SQL_IDX
       FROM QSYS.QADBFDEP d
       LEFT JOIN QSYS2.SYSTABLES t ON t.SYSTEM_TABLE_SCHEMA = d.DBFLDP AND t.SYSTEM_TABLE_NAME = d.DBFFDP
       LEFT JOIN QSYS.QADBXREF x ON x.DBXLIB = d.DBFLDP AND x.DBXFIL = d.DBFFDP
      WHERE d.DBFLIB = ? AND d.DBFFIL = ?
      ORDER BY d.DBFLDP, d.DBFFDP
      FETCH FIRST ${max} ROWS ONLY`,
    [lib, file],
  );
  const keys = withKeys
    ? await keysFor(
        `SELECT k.DBKLIB AS LIB, k.DBKFIL AS FILE, k.DBKFLD AS CAMPO, k.DBKORD AS ORD
           FROM QSYS.QADBKFLD k
          WHERE EXISTS (SELECT 1 FROM QSYS.QADBFDEP d WHERE d.DBFLIB = ? AND d.DBFFIL = ? AND d.DBFLDP = k.DBKLIB AND d.DBFFDP = k.DBKFIL)
          ORDER BY k.DBKLIB, k.DBKFIL, k.DBKPOS`,
        [lib, file],
      )
    : new Map<string, KeyField[]>();
  return rows.map((r) => {
    const name = `${pick(r, 'LIB')}/${pick(r, 'FILE')}`;
    const tt = String(pick(r, 'TIPO') ?? '');
    const isSqlIdx = Number(pick(r, 'SQL_IDX') ?? 0) > 0;
    const so = pick(r, 'SO');
    const d: Dependent = {
      oggetto: name,
      tipo: isSqlIdx ? t({ it: 'indice SQL', en: 'SQL index' }) : (tableTypeLabel(tt) ?? (tt || null)),
      descrizione: String(pick(r, 'TESTO') ?? pick(r, 'XTESTO') ?? '') || null,
      formato: pick(r, 'FORMATO') ?? null,
    };
    if (pick(r, 'UNQ') === 'U') d.univoco = true;
    if (so === 'Y' || so === 'S') d.select_omit = true;
    const k = keys.get(name);
    if (withKeys && k?.length) d.chiavi = k;
    return d;
  });
}

/* ---------- indici e logici con chiavi ---------- */

const inputFile = {
  libreria: z.string(),
  file: z.string(),
};

export const indexList = tool<z.infer<z.ZodObject<typeof inputFile>>>('as400_index_list', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const max = getConfig().sqlMaxRows;
  const own = await keysFor(
    `SELECT DBKLIB AS LIB, DBKFIL AS FILE, DBKFLD AS CAMPO, DBKORD AS ORD
       FROM QSYS.QADBKFLD WHERE DBKLIB = ? AND DBKFIL = ? ORDER BY DBKPOS`,
    [lib, file],
  );
  const deps = await dependents(lib, file, max, true);
  return json({
    libreria: lib,
    file,
    chiave_del_file: own.get(`${lib}/${file}`) ?? [],
    logici_indici_e_viste: deps,
  });
});

/* ---------- dipendenze (where used) ---------- */

export const whereUsed = tool<z.infer<z.ZodObject<typeof inputFile>>>('as400_where_used', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const cfgMax = getConfig().sqlMaxRows;
  const safe = async (sql: string): Promise<Record<string, unknown>[]> => {
    try {
      return await normalizedQuery(sql, [lib, file]);
    } catch (e) {
      return [{ errore: String((e as Error).message).split('\n')[0].slice(0, 160) }];
    }
  };
  let dip: unknown;
  try {
    dip = await dependents(lib, file, cfgMax, false);
  } catch (e) {
    dip = [{ errore: String((e as Error).message).split('\n')[0].slice(0, 160) }];
  }
  const figli = await safe(
    `SELECT c.SYSTEM_TABLE_SCHEMA AS LIB, c.SYSTEM_TABLE_NAME AS FIGLIO, c.CONSTRAINT_NAME AS VINCOLO
       FROM QSYS2.SYSCST p
       JOIN QSYS2.SYSREFCST r ON r.UNIQUE_CONSTRAINT_SCHEMA = p.CONSTRAINT_SCHEMA AND r.UNIQUE_CONSTRAINT_NAME = p.CONSTRAINT_NAME
       JOIN QSYS2.SYSCST c ON c.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = r.CONSTRAINT_NAME
      WHERE p.SYSTEM_TABLE_SCHEMA = ? AND p.SYSTEM_TABLE_NAME = ?
      ORDER BY 1, 2 FETCH FIRST ${cfgMax} ROWS ONLY`,
  );
  const trigger = await safe(
    `SELECT SYSTEM_TRIGGER_SCHEMA AS LIB, TRIGGER_NAME, EVENT_MANIPULATION AS EVENTO, ACTION_TIMING AS QUANDO,
            TRIGGER_PROGRAM_LIBRARY AS PGM_LIB, TRIGGER_PROGRAM_NAME AS PGM
       FROM QSYS2.SYSTRIGGERS WHERE SYSTEM_EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
      ORDER BY 1, 2 FETCH FIRST ${cfgMax} ROWS ONLY`,
  );
  return json({
    libreria: lib, file,
    logici_indici_e_viste_che_lo_usano: dip,
    tabelle_figlie_foreign_key: figli,
    trigger,
    nota: t({
      it: 'I programmi (RPG/CL) che usano il file non sono rilevabili dal catalogo SQL.',
      en: 'Programs (RPG/CL) that use the file cannot be detected from the SQL catalog.',
    }),
  });
});

/* ---------- definizione vista ---------- */

export const viewDef = tool<z.infer<z.ZodObject<typeof inputFile>>>('as400_view_def', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const rows = await normalizedQuery(
    `SELECT VIEW_DEFINITION, IS_UPDATABLE, CHECK_OPTION, VIEW_OWNER, SYSTEM_VIEW_NAME, TABLE_NAME
       FROM QSYS2.SYSVIEWS WHERE SYSTEM_VIEW_SCHEMA = ? AND SYSTEM_VIEW_NAME = ?`,
    [lib, file],
  );
  if (rows.length === 0) throw new Error(t({ it: 'Vista non trovata: {lib}/{file}', en: 'View not found: {lib}/{file}' }, { lib, file }));
  const r = rows[0];
  return json({
    libreria: lib, vista: file, nome_sql: pick(r, 'TABLE_NAME'),
    proprietario: pick(r, 'VIEW_OWNER'),
    aggiornabile: pick(r, 'IS_UPDATABLE'), check_option: pick(r, 'CHECK_OPTION'),
    definizione: pick(r, 'VIEW_DEFINITION'),
  });
});

/* ---------- vincoli ---------- */

export const constraints = tool<z.infer<z.ZodObject<typeof inputFile>>>('as400_constraints', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const file = objName(args.file, 'file');
  const cst = await normalizedQuery(
    `SELECT CONSTRAINT_SCHEMA, CONSTRAINT_NAME, CONSTRAINT_TYPE, CONSTRAINT_STATE, ENABLED, CHECK_PENDING
       FROM QSYS2.SYSCST WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?
      ORDER BY CONSTRAINT_TYPE, CONSTRAINT_NAME`,
    [lib, file],
  );
  const keys = await normalizedQuery(
    `SELECT CONSTRAINT_NAME, ORDINAL_POSITION, SYSTEM_COLUMN_NAME
       FROM QSYS2.SYSKEYCST WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ?
      ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [lib, file],
  );
  const refs = await normalizedQuery(
    `SELECT c.CONSTRAINT_NAME, r.UPDATE_RULE, r.DELETE_RULE, p.SYSTEM_TABLE_SCHEMA AS PARENT_LIB, p.SYSTEM_TABLE_NAME AS PARENT
       FROM QSYS2.SYSCST c
       JOIN QSYS2.SYSREFCST r ON r.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = c.CONSTRAINT_NAME
       JOIN QSYS2.SYSCST p ON p.CONSTRAINT_SCHEMA = r.UNIQUE_CONSTRAINT_SCHEMA AND p.CONSTRAINT_NAME = r.UNIQUE_CONSTRAINT_NAME
      WHERE c.SYSTEM_TABLE_SCHEMA = ? AND c.SYSTEM_TABLE_NAME = ?`,
    [lib, file],
  );
  const elenco = cst.map((c) => {
    const name = pick(c, 'CONSTRAINT_NAME');
    const ref = refs.find((r) => pick(r, 'CONSTRAINT_NAME') === name);
    return {
      nome: name,
      tipo: pick(c, 'CONSTRAINT_TYPE'),
      stato: pick(c, 'CONSTRAINT_STATE'),
      abilitato: pick(c, 'ENABLED'),
      campi: keys.filter((k) => pick(k, 'CONSTRAINT_NAME') === name).map((k) => pick(k, 'SYSTEM_COLUMN_NAME')),
      riferisce: ref ? `${pick(ref, 'PARENT_LIB')}/${pick(ref, 'PARENT')}` : undefined,
      on_delete: ref ? pick(ref, 'DELETE_RULE') : undefined,
      on_update: ref ? pick(ref, 'UPDATE_RULE') : undefined,
    };
  });
  return json({ libreria: lib, file, vincoli: elenco });
});

/* ---------- procedure e funzioni ---------- */

const inputRoutines = {
  libreria: z.string(),
  tipo: z.enum(['procedure', 'funzioni', 'tutte']).optional(),
  filtro: z.string().optional(),
  limite: limiteSchema,
};

export const routineList = tool<z.infer<z.ZodObject<typeof inputRoutines>>>('as400_routine_list', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const lim = cap(args.limite);
  const fr = nameCond('ROUTINE_NAME', args.filtro);
  const tipo = args.tipo === 'procedure' ? " AND ROUTINE_TYPE = 'PROCEDURE'" : args.tipo === 'funzioni' ? " AND ROUTINE_TYPE = 'FUNCTION'" : '';
  const rows = await normalizedQuery(
    `SELECT * FROM QSYS2.SYSROUTINES
      WHERE SPECIFIC_SCHEMA = ? AND ${fr.sql}${tipo}
      ORDER BY ROUTINE_NAME
      FETCH FIRST ${lim} ROWS ONLY`,
    [lib, fr.param],
  );
  const mapped = rows.map((r) => ({
    nome: pick(r, 'ROUTINE_NAME'),
    nome_sistema: pick(r, 'SPECIFIC_NAME'),
    tipo: pick(r, 'ROUTINE_TYPE'),
    linguaggio: pick(r, 'EXTERNAL_LANGUAGE') ?? pick(r, 'ROUTINE_BODY'),
    programma: pick(r, 'EXTERNAL_NAME') ?? undefined,
    parametri_in: pick(r, 'IN_PARMS'),
    parametri_out: pick(r, 'OUT_PARMS'),
    descrizione: pick(r, 'ROUTINE_TEXT') ?? null,
    creata: pick(r, 'ROUTINE_CREATED'),
  }));
  const l = limited(mapped, lim);
  return json({ libreria: lib, routine: l.righe.length, nota: l.nota, elenco: l.righe });
});
