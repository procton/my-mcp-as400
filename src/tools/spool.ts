import { z } from 'zod';
import { normalizedQuery, sysName } from '../pool.js';
import { readSpooledFile } from '../spooljava.js';
import { splitPages } from '../charset.js';
import { getConfig, objName } from '../config.js';
import { json, tool, capText, pick } from './common.js';
import { nameCond } from './catalog.js';
import type { ToolResult } from './common.js';
import { t, paramName, type Msg } from '../i18n.js';

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

function checkDate(v: string | undefined, what: Msg): string | undefined {
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new Error(t({
      it: "{what} non valida: '{v}' (formato AAAA-MM-GG)",
      en: "Invalid {what}: '{v}' (format YYYY-MM-DD)",
    }, { what: t(what), v }));
  return v.trim();
}

/** «a, b, c o d» / «a, b, c or d». */
function orList(items: string[]): string {
  if (items.length < 2) return items.join('');
  return items.slice(0, -1).join(', ') + t({ it: ' o ', en: ' or ' }) + items[items.length - 1];
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
  const dal = checkDate(a.dal, { it: 'Data iniziale', en: 'start date' });
  const al = checkDate(a.al, { it: 'Data finale', en: 'end date' });
  if (dal) { w.push('CREATE_TIMESTAMP >= TIMESTAMP(CAST(? AS VARCHAR(26)))'); p.push(`${dal} 00:00:00`); }
  if (al) { w.push('CREATE_TIMESTAMP < TIMESTAMP(CAST(? AS VARCHAR(26))) + 1 DAY'); p.push(`${al} 00:00:00`); }
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

/* ---------------- elenco code / spool di una coda ---------------- */

const inputList = {
  libreria: z.string(),
  outq: z.string().optional(),
  utente: z.string().optional(),
  filtro: z.string().optional(),
  limite: z.number().int().min(1).optional(),
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
    if (rows.length === 0) return json({ libreria: qlib, code: 0, nota: t({ it: 'nessuna coda di stampa in questa libreria', en: 'no output queues in this library' }) });
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
  if (rows.length >= lim) out.nota = t({
    it: "mostrati i {n} più recenti (SPOOL_MAX_FILES / '{limite}'): restringi con {utente}/{filtro}",
    en: "showing the {n} most recent (SPOOL_MAX_FILES / '{limite}'): narrow with {utente}/{filtro}",
  }, { n: lim, limite: paramName('limite'), utente: paramName('utente'), filtro: paramName('filtro') });
  return json(out);
});

/* ---------------- ricerca tra tutte le code ---------------- */

const inputSearch = {
  utente: z.string().optional(),
  file: z.string().optional(),
  job: z.string().optional(),
  datiUtente: z.string().optional(),
  stato: z.string().optional(),
  tipo: z.string().optional(),
  dal: z.string().optional(),
  al: z.string().optional(),
  libreria: z.string().optional(),
  outq: z.string().optional(),
  limite: z.number().int().min(1).optional(),
};

/** Cerca file di spool in tutte le code per utente, nome, job, data, tipo. */
export const spoolSearch = tool<
  z.infer<z.ZodObject<typeof inputSearch>>
>('as400_spool_search', async (args): Promise<ToolResult> => {
  if (!args.utente && !args.file && !args.job && !args.datiUtente && !args.dal && !args.libreria) {
    throw new Error(t({
      it: 'Indica almeno un filtro tra {list} (la scansione di tutte le code è lenta)',
      en: 'Provide at least one filter among {list} (scanning all queues is slow)',
    }, { list: orList(['utente', 'file', 'job', 'datiUtente', 'dal', 'libreria'].map((k) => paramName(k))) }));
  }
  const lim = cap(args.limite);
  const f = buildFilters(args);
  const rows = await normalizedQuery(
    `SELECT ${COLS} FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC ${f.where} ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${lim} ROWS ONLY`,
    f.params,
  );
  const out: Record<string, unknown> = { trovati: rows.length, elenco: rows.map(toItem) };
  if (rows.length >= lim) out.nota = t({
    it: "mostrati i {n} più recenti: restringi i filtri o aumenta '{limite}'",
    en: "showing the {n} most recent: narrow the filters or raise '{limite}'",
  }, { n: lim, limite: paramName('limite') });
  return json(out);
});

/* ---------------- identificazione di un file di spool ---------------- */

const inputId = {
  libreria: z.string(),
  outq: z.string(),
  file: z.string(),
  numero: z.number().int().optional(),
  utente: z.string().optional(),
  job: z.string().optional(),
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
    throw new Error(t({
      it: 'File di spool non trovato: {q} {nome}{num}',
      en: 'Spooled file not found: {q} {nome}{num}',
    }, { q: `${qlib}/${qoutq}`, nome, num: a.numero !== undefined ? ` n.${a.numero}` : '' }));
  }
  if (rows.length > 1 && a.numero === undefined) {
    const opz = rows.slice(0, 10).map((r) => `n.${pick(r, 'N')} ${pick(r, 'U')} ${String(pick(r, 'CT')).slice(0, 16)}`);
    throw new Error(t({
      it: "Più file di spool col nome {nome}: specifica '{numero}' (più recenti: {list})",
      en: "Several spooled files named {nome}: specify '{numero}' (most recent: {list})",
    }, { nome, numero: paramName('numero'), list: opz.join('; ') }));
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
  daPagina: z.number().int().min(1).optional(),
  aPagina: z.number().int().min(1).optional(),
  pulisci: z.boolean().optional(),
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
    return json({ ...toItem(r), pagine_lette: pages.length, nota: t({
        it: "{da} {first} oltre l'ultima pagina letta ({n})",
        en: '{da} {first} is past the last page read ({n})',
      }, { da: paramName('daPagina'), first, n: pages.length }) });
  }
  const selected = pages.slice(first - 1, last).join('\n\f\n');
  const out: Record<string, unknown> = {
    ...toItem(r),
    pagine_nel_testo: pages.length,
    pagine_restituite: `${first}-${last}`,
    caratteri: selected.length,
    contenuto: capText(selected, cfg.spoolMaxChars, { it: 'spool', en: 'spool' }),
  };
  const notes: string[] = [];
  if (truncated) {
    notes.push(t({
      it: 'lettura interrotta a {n} byte (SPOOL_MAX_READ_BYTES): le pagine successive non sono incluse',
      en: 'reading stopped at {n} bytes (SPOOL_MAX_READ_BYTES): later pages are not included',
    }, { n: cfg.spoolMaxReadBytes }));
  }
  if (/AFPDS/i.test(tipo)) {
    notes.push(t({
      it: "AFPDS: è estratto solo il testo, l'impaginazione (posizioni, overlay, immagini) non è riprodotta",
      en: 'AFPDS: only the text is extracted; the page layout (positions, overlays, images) is not reproduced',
    }));
  }
  if (notes.length) out.nota = notes.join('; ');
  return json(out);
});
