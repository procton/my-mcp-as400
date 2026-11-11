import { z } from 'zod';
import { normalizedQuery, sysName } from '../pool.js';
import { readSpooledFile } from '../spooljava.js';
import { getConfig, objName } from '../config.js';
import { json, tool, capText, likeRegex, pick } from './common.js';
import type { ToolResult } from './common.js';

const inputList = {
  libreria: z.string().describe('Libreria della coda di stampa (es. QUSRSYS, QGPL)'),
  outq: z.string().optional().describe('Coda di stampa; se omessa elenca le code della libreria'),
  utente: z.string().optional().describe('Filtra per profilo utente'),
  filtro: z.string().optional().describe('Filtro sul nome file di spool (SQL LIKE: % e _)'),
};

/** Elenca le code di stampa di una libreria, oppure i file di spool di una coda. */
export const spoolList = tool<
  z.infer<z.ZodObject<typeof inputList>>
>('as400_spool_list', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const qlib = objName(args.libreria, 'libreria');

  // senza outq: elenca le code della libreria
  if (!args.outq) {
    const rows = await normalizedQuery(
      `SELECT OBJNAME AS CODA, OBJTEXT AS DESCRIZIONE
         FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*OUTQ'))
        ORDER BY OBJNAME`,
      [qlib],
    );
    if (rows.length === 0) {
      return json({ libreria: qlib, code: 0, nota: 'nessuna coda di stampa in questa libreria' });
    }
    return json({ libreria: qlib, code: rows.length, elenco: rows });
  }

  const qoutq = objName(args.outq, 'coda di stampa');
  // forma posizionale (OUTQ_LIB, OUTQ_NAME, DETAILED_INFO, IGNORE_ERRORS), valida su questa release
  const rows = await normalizedQuery(
    `SELECT SPOOLED_FILE_NAME, FILE_NUMBER, USER_NAME, USER_DATA, STATUS, TOTAL_PAGES, SIZE, FORM_TYPE, JOB_NAME, DEVICE_TYPE
       FROM TABLE(QSYS2.OUTPUT_QUEUE_ENTRIES(?, ?, 'FULL', 'NO'))`,
    [qlib, qoutq],
  );
  let files = rows.map((r) => ({
    file: String(pick(r, 'SPOOLED_FILE_NAME') ?? ''),
    numero: pick(r, 'FILE_NUMBER') ?? null,
    utente: pick(r, 'USER_NAME') ?? '',
    dati_utente: pick(r, 'USER_DATA') ?? null,
    stato: pick(r, 'STATUS') ?? null,
    pagine: pick(r, 'TOTAL_PAGES') ?? null,
    dimensione: pick(r, 'SIZE') ?? null,
    form_type: pick(r, 'FORM_TYPE') ?? null,
    job: pick(r, 'JOB_NAME') ?? null,
    tipo: pick(r, 'DEVICE_TYPE') ?? null,
  }));
  const filtro = likeRegex(args.filtro ?? '');
  files = files.filter((f) => filtro.test(f.file));
  if (args.utente) {
    const u = args.utente.trim().toUpperCase();
    files = files.filter((f) => String(f.utente).toUpperCase() === u);
  }
  const truncated = files.length > cfg.spoolMaxFiles;
  if (truncated) files = files.slice(0, cfg.spoolMaxFiles);
  const out: Record<string, unknown> = { libreria: qlib, outq: qoutq, file_spool: files.length, elenco: files };
  if (truncated) out.nota = `troncato a ${cfg.spoolMaxFiles} file (SPOOL_MAX_FILES)`;
  return json(out);
});

const inputRead = {
  libreria: z.string().describe('Libreria della coda di stampa (max 10 caratteri)'),
  outq: z.string().describe('Coda di stampa (max 10 caratteri)'),
  file: z.string().describe('Nome del file di spool (max 10 caratteri)'),
  numero: z.number().int().optional().describe('Numero del file di spool, se il nome è duplicato'),
  pulisci: z.boolean().optional().describe('Rimuove i caratteri di controllo SCS (default true)'),
};

/** Legge il contenuto di un file di spool: via SQL elenca e identifica, via Java (Toolbox) legge il testo. */
export const spoolRead = tool<
  z.infer<z.ZodObject<typeof inputRead>>
>('as400_spool_read', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const qlib = objName(args.libreria, 'libreria');
  const qoutq = objName(args.outq, 'coda di stampa');
  const nome = objName(args.file, 'file di spool');

  // 1) identifica il file di spool (chiave completa: job + data/ora creazione)
  const rows = await normalizedQuery(
    `SELECT SPOOLED_FILE_NAME, FILE_NUMBER, JOB_NAME, CREATE_TIMESTAMP, DEVICE_TYPE
       FROM TABLE(QSYS2.OUTPUT_QUEUE_ENTRIES(?, ?, 'FULL', 'NO'))`,
    [qlib, qoutq],
  );
  let cand = rows.filter((r) => String(pick(r, 'SPOOLED_FILE_NAME') ?? '') === nome);
  if (args.numero !== undefined) {
    cand = cand.filter((r) => Number(pick(r, 'FILE_NUMBER')) === args.numero);
  }
  if (cand.length === 0) {
    throw new Error(`File di spool non trovato: ${qlib}/${qoutq} ${nome}${args.numero !== undefined ? ` n.${args.numero}` : ''}`);
  }
  if (cand.length > 1 && args.numero === undefined) {
    const numeri = cand.map((r) => Number(pick(r, 'FILE_NUMBER')));
    throw new Error(`Più file di spool col nome ${nome}: specifica 'numero' (disponibili: ${numeri.join(', ')})`);
  }
  const r = cand[0];
  const [jobNumber, jobUser, jobName] = String(pick(r, 'JOB_NAME') ?? '').split('/'); // nnnnnn/UTENTE/NOMEJOB
  const createTimestamp = String(pick(r, 'CREATE_TIMESTAMP') ?? '');
  const tipo = String(pick(r, 'DEVICE_TYPE') ?? '');
  if (tipo && !/SCS|USERASCII|LINE/i.test(tipo)) {
    throw new Error(`Il file di spool è di tipo ${tipo}: contenuto non convertibile in testo (solo SCS/ASCII); usa spool_list per i metadati`);
  }

  // 2) contenuto via bridge Java (Toolbox), CCSID 273
  const raw = await readSpooledFile({
    nome,
    numero: Number(pick(r, 'FILE_NUMBER')),
    jobName,
    jobUser,
    jobNumber,
    jobSysName: await sysName(),
    createTimestamp,
  }, cfg.spoolMaxChars);

  let data = raw;
  if (args.pulisci !== false) {
    // rimuove CR, NUL e caratteri di controllo SCS, preservando \n e \t
    data = data.replace(/\r/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }
  return json({
    outq: `${qlib}/${qoutq}`,
    file: nome,
    numero: Number(pick(r, 'FILE_NUMBER')),
    job: pick(r, 'JOB_NAME') ?? null,
    tipo,
    creazione: createTimestamp || null,
    caratteri: data.length,
    contenuto: capText(data, cfg.spoolMaxChars, 'spool'),
  });
});
