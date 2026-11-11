import { z } from 'zod';
import { normalizedQuery, sysName } from '../pool.js';
import { readSpooledFile } from '../spooljava.js';
import { splitPages } from '../charset.js';
import { getConfig, objName } from '../config.js';
import { json, tool, capText, pick } from './common.js';
import { nameCond } from './catalog.js';
import type { ToolResult } from './common.js';

/** Colonne comuni (QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC: tutte le code, filtri spinti nell'SQL). */
const COLS = `OUTPUT_QUEUE_LIBRARY_NAME AS QLIB, OUTPUT_QUEUE_NAME AS QNAME, SPOOLED_FILE_NAME AS F, FILE_NUMBER AS N,
              USER_NAME AS U, USER_DATA AS UD, STATUS AS ST, TOTAL_PAGES AS PG, SIZE AS SZ, FORM_TYPE AS FT, JOB_NAME AS J,
              DEVICE_TYPE AS DT, CREATE_TIMESTAMP AS CT, COPIES AS CP, OUTPUT_PRIORITY AS PR`;

function toItem(r: Record<string, unknown>): Record<string, unknown> {
  return {
    file: pick(r, 'F'),
    numero: pick(r, 'N') ?? null,
    coda: `${pick(r, 'QLIB')}/${pick(r, 'QNAME')}`,
    utente: pick(r, 'U'),
    job: pick(r, 'J') ?? null,
    dati_utente: pick(r, 'UD') ?? null,
    stato: pick(r, 'ST') ?? null,
    pagine: pick(r, 'PG') ?? null,
    dimensione: pick(r, 'SZ') ?? null,
    tipo: pick(r, 'DT') ?? null,
    form_type: pick(r, 'FT') ?? null,
    creato: pick(r, 'CT') ?? null,
    copie: pick(r, 'CP') ?? null,
  };
}

function checkDate(v: string | undefined, what: string): string | undefined {
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new Error(`${what} non valida: '${v}' (formato AAAA-MM-GG)`);
  return v.trim();
}

function cap(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? 100, 1), getConfig().spoolMaxFiles);
}

interface Filters {
  where: string;
  params: unknown[];
}

function buildFilters(a: {
  libreria?: string; outq?: string; utente?: string; file?: string; numero?: number; job?: string;
  datiUtente?: string; stato?: string; tipo?: string; dal?: string; al?: string;
}): Filters {
  const cfg = getConfig();
  const w: string[] = [];
  const p: unknown[] = [];
  if (a.libreria) { w.push('OUTPUT_QUEUE_LIBRARY_NAME = ?'); p.push(objName(a.libreria, 'libreria')); }
  else if (cfg.allowedLibs) {
    w.push(`OUTPUT_QUEUE_LIBRARY_NAME IN (${cfg.allowedLibs.map(() => '?').join(',')})`);
    p.push(...cfg.allowedLibs);
  }
  if (a.outq) { w.push('OUTPUT_QUEUE_NAME = ?'); p.push(objName(a.outq, 'coda di stampa')); }
  const add = (col: string, v: string | undefined): void => {
    if (!v) return;
    const c = nameCond(col, v);
    w.push(c.sql); p.push(c.param);
  };
  add('USER_NAME', a.utente);
  add('SPOOLED_FILE_NAME', a.file);
  add('USER_DATA', a.datiUtente);
  if (a.numero !== undefined) { w.push('FILE_NUMBER = ?'); p.push(a.numero); }
  if (a.job) { w.push('JOB_NAME LIKE ?'); p.push(a.job.trim().toUpperCase()); }
  if (a.stato) { w.push('STATUS = ?'); p.push(a.stato.trim().toUpperCase()); }
  if (a.tipo) { w.push('DEVICE_TYPE = ?'); p.push(a.tipo.trim().toUpperCase().replace(/^(?!\*)/, '*')); }
  const dal = checkDate(a.dal, 'Data iniziale');
  const al = checkDate(a.al, 'Data finale');
  if (dal) { w.push('CREATE_TIMESTAMP >= TIMESTAMP(CAST(? AS VARCHAR(26)))'); p.push(`${dal} 00:00:00`); }
  if (al) { w.push('CREATE_TIMESTAMP < TIMESTAMP(CAST(? AS VARCHAR(26))) + 1 DAY'); p.push(`${al} 00:00:00`); }
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

/* ---------------- elenco code / spool di una coda ---------------- */

const inputList = {
  libreria: z.string().describe('Libreria della coda di stampa (es. QUSRSYS, QGPL)'),
  outq: z.string().optional().describe('Coda di stampa; se omessa elenca le code della libreria con il numero di file'),
  utente: z.string().optional().describe('Filtra per profilo utente (SQL LIKE)'),
  filtro: z.string().optional().describe('Filtro sul nome file di spool (SQL LIKE: % e _)'),
  limite: z.number().int().min(1).optional().describe('Massimo file restituiti (default 100, tetto SPOOL_MAX_FILES)'),
};

/** Elenca le code di stampa di una libreria, oppure i file di spool di una coda (più recenti per primi). */
export const spoolList = tool<
  z.infer<z.ZodObject<typeof inputList>>
>('as400_spool_list', async (args): Promise<ToolResult> => {
  const qlib = objName(args.libreria, 'libreria');

  if (!args.outq) {
    const rows = await normalizedQuery(
      `SELECT * FROM QSYS2.OUTPUT_QUEUE_INFO WHERE OUTPUT_QUEUE_LIBRARY_NAME = ? ORDER BY OUTPUT_QUEUE_NAME`,
      [qlib],
    );
    if (rows.length === 0) return json({ libreria: qlib, code: 0, nota: 'nessuna coda di stampa in questa libreria' });
    const elenco = rows.map((r) => ({
      coda: pick(r, 'OUTPUT_QUEUE_NAME'),
      descrizione: pick(r, 'TEXT_DESCRIPTION', 'OUTPUT_QUEUE_TEXT') ?? null,
      file: pick(r, 'NUMBER_OF_FILES') ?? null,
      stato: pick(r, 'OUTPUT_QUEUE_STATUS') ?? null,
      stampante: pick(r, 'PRINTER_DEVICE_NAME') ?? undefined,
      writer: pick(r, 'WRITER_JOB_STATUS') ?? undefined,
    }));
    return json({ libreria: qlib, code: elenco.length, elenco });
  }

  const lim = cap(args.limite);
  const f = buildFilters({ libreria: qlib, outq: args.outq, utente: args.utente, file: args.filtro });
  const rows = await normalizedQuery(
    `SELECT ${COLS} FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC ${f.where} ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${lim} ROWS ONLY`,
    f.params,
  );
  const out: Record<string, unknown> = {
    coda: `${qlib}/${args.outq.trim().toUpperCase()}`, file_spool: rows.length, elenco: rows.map(toItem),
  };
  if (rows.length >= lim) out.nota = `mostrati i ${lim} più recenti (SPOOL_MAX_FILES / 'limite'): restringi con utente/filtro`;
  return json(out);
});

/* ---------------- ricerca tra tutte le code ---------------- */

const inputSearch = {
  utente: z.string().optional().describe('Profilo utente proprietario dello spool (SQL LIKE)'),
  file: z.string().optional().describe('Nome file di spool (SQL LIKE)'),
  job: z.string().optional().describe("Job 'numero/utente/nome' (SQL LIKE), es. '%/QPGMR/%'"),
  datiUtente: z.string().optional().describe('Campo USRDTA (SQL LIKE)'),
  stato: z.string().optional().describe('Stato: READY, HELD, PRINTING, SAVED, ...'),
  tipo: z.string().optional().describe('Tipo dati: *SCS, *AFPDS, *USERASCII, *LINE, ...'),
  dal: z.string().optional().describe('Creati dal (AAAA-MM-GG)'),
  al: z.string().optional().describe('Creati fino al (AAAA-MM-GG, incluso)'),
  libreria: z.string().optional().describe('Restringe a una libreria di code'),
  outq: z.string().optional().describe('Restringe a una coda (con libreria)'),
  limite: z.number().int().min(1).optional().describe('Massimo file (default 100, tetto SPOOL_MAX_FILES)'),
};

/** Cerca file di spool in tutte le code per utente, nome, job, data, tipo. */
export const spoolSearch = tool<
  z.infer<z.ZodObject<typeof inputSearch>>
>('as400_spool_search', async (args): Promise<ToolResult> => {
  if (!args.utente && !args.file && !args.job && !args.datiUtente && !args.dal && !args.libreria) {
    throw new Error("Indica almeno un filtro tra utente, file, job, datiUtente, dal o libreria (la scansione di tutte le code è lenta)");
  }
  const lim = cap(args.limite);
  const f = buildFilters(args);
  const rows = await normalizedQuery(
    `SELECT ${COLS} FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC ${f.where} ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${lim} ROWS ONLY`,
    f.params,
  );
  const out: Record<string, unknown> = { trovati: rows.length, elenco: rows.map(toItem) };
  if (rows.length >= lim) out.nota = `mostrati i ${lim} più recenti: restringi i filtri o aumenta 'limite'`;
  return json(out);
});

/* ---------------- identificazione di un file di spool ---------------- */

const inputId = {
  libreria: z.string().describe('Libreria della coda di stampa (max 10 caratteri)'),
  outq: z.string().describe('Coda di stampa (max 10 caratteri)'),
  file: z.string().describe('Nome del file di spool (max 10 caratteri)'),
  numero: z.number().int().optional().describe('Numero del file di spool, se il nome è duplicato'),
  utente: z.string().optional().describe('Utente proprietario, per distinguere file con lo stesso nome'),
  job: z.string().optional().describe("Job 'numero/utente/nome', per distinguere file con lo stesso nome"),
};

async function findSpool(a: z.infer<z.ZodObject<typeof inputId>>): Promise<Record<string, unknown>> {
  const qlib = objName(a.libreria, 'libreria');
  const qoutq = objName(a.outq, 'coda di stampa');
  const nome = objName(a.file, 'file di spool');
  const f = buildFilters({ libreria: qlib, outq: qoutq, file: nome, numero: a.numero, utente: a.utente, job: a.job });
  const rows = await normalizedQuery(
    `SELECT ${COLS} FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC ${f.where} ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST 21 ROWS ONLY`,
    f.params,
  );
  if (rows.length === 0) {
    throw new Error(`File di spool non trovato: ${qlib}/${qoutq} ${nome}${a.numero !== undefined ? ` n.${a.numero}` : ''}`);
  }
  if (rows.length > 1 && a.numero === undefined) {
    const opz = rows.slice(0, 10).map((r) => `n.${pick(r, 'N')} ${pick(r, 'U')} ${String(pick(r, 'CT')).slice(0, 16)}`);
    throw new Error(`Più file di spool col nome ${nome}: specifica 'numero' (più recenti: ${opz.join('; ')})`);
  }
  return rows[0];
}

/* ---------------- attributi completi ---------------- */

export const spoolInfo = tool<
  z.infer<z.ZodObject<typeof inputId>>
>('as400_spool_info', async (args): Promise<ToolResult> => {
  const r = await findSpool(args);
  const qlib = String(pick(r, 'QLIB'));
  const qname = String(pick(r, 'QNAME'));
  // attributi di stampa completi (formato, font, overlay, ...): solo i valori presenti
  const full = await normalizedQuery(
    `SELECT * FROM TABLE(QSYS2.OUTPUT_QUEUE_ENTRIES(?, ?, 'FULL', 'NO')) WHERE SPOOLED_FILE_NAME = ? AND FILE_NUMBER = ?`,
    [qlib, qname, String(pick(r, 'F')), Number(pick(r, 'N'))],
  );
  const attributi: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full[0] ?? {})) {
    if (v !== null && v !== '' && !['SPOOLED_FILE_NAME', 'FILE_NUMBER', 'JOB_NAME', 'USER_NAME', 'SYSTEM'].includes(k)) attributi[k.toLowerCase()] = v;
  }
  return json({ ...toItem(r), attributi });
});

/* ---------------- lettura contenuto ---------------- */

const inputRead = {
  ...inputId,
  daPagina: z.number().int().min(1).optional().describe('Prima pagina da restituire (1-based)'),
  aPagina: z.number().int().min(1).optional().describe('Ultima pagina da restituire (inclusa)'),
  pulisci: z.boolean().optional().describe('Rimuove i caratteri di controllo residui (default true)'),
};

/** Legge il contenuto testuale di un file di spool (SCS, AFPDS, LINE, USERASCII) con paginazione. */
export const spoolRead = tool<
  z.infer<z.ZodObject<typeof inputRead>>
>('as400_spool_read', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const r = await findSpool(args);
  const tipo = String(pick(r, 'DT') ?? '');
  const [jobNumber, jobUser, jobName] = String(pick(r, 'J') ?? '').split('/'); // nnnnnn/UTENTE/NOMEJOB
  const createTimestamp = String(pick(r, 'CT') ?? '');

  const { text, truncated } = await readSpooledFile({
    nome: String(pick(r, 'F')),
    numero: Number(pick(r, 'N')),
    jobName, jobUser, jobNumber,
    jobSysName: await sysName(),
    createTimestamp,
    tipo,
  }, cfg.spoolMaxReadBytes);

  let data = text;
  if (args.pulisci !== false) data = data.replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '');
  const pages = splitPages(data);
  const first = args.daPagina ?? 1;
  const last = Math.min(args.aPagina ?? pages.length, pages.length);
  if (first > pages.length) {
    return json({ ...toItem(r), pagine_lette: pages.length, nota: `daPagina ${first} oltre l'ultima pagina letta (${pages.length})` });
  }
  const selected = pages.slice(first - 1, last).join('\n\f\n');
  const out: Record<string, unknown> = {
    ...toItem(r),
    pagine_nel_testo: pages.length,
    pagine_restituite: `${first}-${last}`,
    caratteri: selected.length,
    contenuto: capText(selected, cfg.spoolMaxChars, 'spool'),
  };
  const notes: string[] = [];
  if (truncated) notes.push(`lettura interrotta a ${cfg.spoolMaxReadBytes} byte (SPOOL_MAX_READ_BYTES): le pagine successive non sono incluse`);
  if (/AFPDS/i.test(tipo)) notes.push('AFPDS: è estratto solo il testo, l\'impaginazione (posizioni, overlay, immagini) non è riprodotta');
  if (notes.length) out.nota = notes.join('; ');
  return json(out);
});
