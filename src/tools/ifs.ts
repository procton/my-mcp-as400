import { z } from 'zod';
import { normalizedQuery, withTimeout } from '../pool.js';
import { getConfig } from '../config.js';
import { safeIfsPath, isSpecialFs, hideSymlinks } from '../ifsguard.js';
import { text, json, tool, capText, likeRegex, pick, numberLines } from './common.js';
import type { ToolResult } from './common.js';

const PATH_PARAM = 'CAST(? AS VARCHAR(32709))';

interface Entry {
  percorso: string;
  nome: string;
  tipo: string;
  dimensione: unknown;
  proprietario: unknown;
  ccsid: unknown;
  modificato: unknown;
  livello?: number;
}

function toEntry(r: Record<string, unknown>): Entry {
  const path = String(pick(r, 'PATH_NAME') ?? '');
  return {
    percorso: path,
    nome: path.split('/').pop() || path,
    tipo: String(pick(r, 'OBJECT_TYPE') ?? ''),
    dimensione: pick(r, 'DATA_SIZE') ?? null,
    proprietario: pick(r, 'OBJECT_OWNER') ?? null,
    ccsid: pick(r, 'CCSID') ?? null,
    modificato: pick(r, 'OBJECT_CHANGE_TIMESTAMP', 'CREATE_TIMESTAMP') ?? null,
  };
}

/** Stat di un percorso: la riga del percorso stesso più, se è una directory, i figli diretti. */
async function statRows(p: string): Promise<Entry[]> {
  // forma posizionale (percorso, subtree=NO): valida su questa release
  const rows = await normalizedQuery(
    `SELECT PATH_NAME, OBJECT_TYPE, DATA_SIZE, OBJECT_OWNER, CCSID, CREATE_TIMESTAMP, OBJECT_CHANGE_TIMESTAMP
       FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(${PATH_PARAM}, 'NO'))`,
    [p],
  );
  return rows.map(toEntry);
}

const norm = (x: string): string => x.replace(/\/+$/, '') || '/';

/* ---------------- elenco ---------------- */

const inputList = {
  percorso: z.string().describe('Percorso assoluto di una directory IFS (es. /home)'),
  profondita: z.number().int().min(1).max(6).optional().describe('Livelli da scendere (default 1 = solo contenuto diretto)'),
  filtro: z.string().optional().describe('Filtro sul nome (SQL LIKE: % e _, senza distinzione maiuscole), es. %.sh'),
  tipo: z.enum(['tutti', 'file', 'directory']).optional().describe("Default 'tutti'"),
  maxVoci: z.number().int().min(1).max(2000).optional().describe('Massimo di voci restituite (default 500)'),
};

/** Elenca una directory IFS, anche in profondità (visita per livelli, una chiamata per directory). */
export const ifsList = tool<
  z.infer<z.ZodObject<typeof inputList>>
>('as400_ifs_list', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const p = norm(await safeIfsPath(args.percorso));
  const maxDepth = isSpecialFs(p) ? 1 : (args.profondita ?? 1);
  const maxVoci = args.maxVoci ?? 500;
  const maxDirs = 200;
  const re = args.filtro ? likeRegex(args.filtro) : null;
  const hide = hideSymlinks();
  const deadline = Date.now() + cfg.searchTimeoutMs;

  const out: Entry[] = [];
  const notes: string[] = [];
  let hidden = 0;
  let dirsScanned = 0;
  let queue: string[] = [p];
  let truncated = false;
  let firstDirEmpty = false;

  for (let depth = 1; depth <= maxDepth && queue.length > 0 && !truncated; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (Date.now() > deadline) { notes.push(`tempo massimo (${cfg.searchTimeoutMs} ms) raggiunto`); truncated = true; break; }
      if (dirsScanned >= maxDirs) { notes.push(`limite di ${maxDirs} directory visitate raggiunto`); truncated = true; break; }
      const entries = (await withTimeout(statRows(dir), cfg.sqlTimeoutMs, 'elenco IFS'))
        .filter((e) => norm(e.percorso) !== dir);
      dirsScanned++;
      if (depth === 1 && entries.length === 0) firstDirEmpty = true;
      for (const e of entries) {
        if (e.tipo === '*SYMLNK' && hide) { hidden++; continue; }
        if (e.tipo === '*DIR' && depth < maxDepth) next.push(norm(e.percorso));
        const okType = args.tipo === 'file' ? e.tipo !== '*DIR' : args.tipo === 'directory' ? e.tipo === '*DIR' : true;
        if (okType && (!re || re.test(e.nome))) {
          if (out.length >= maxVoci) { truncated = true; notes.push(`raggiunto il limite di ${maxVoci} voci`); break; }
          out.push({ ...e, livello: depth });
        }
      }
      if (truncated) break;
    }
    queue = next;
  }
  if (depth1Empty(out, firstDirEmpty)) {
    return json({ percorso: p, oggetti: 0, nota: 'directory vuota, inesistente o senza autorità' });
  }
  if (hidden) notes.push(`${hidden} collegamenti simbolici omessi (IFS_ALLOWED_PREFIXES attivo)`);
  out.sort((a, b) => (a.livello ?? 0) - (b.livello ?? 0) || a.percorso.localeCompare(b.percorso));
  const res: Record<string, unknown> = {
    percorso: p, profondita: maxDepth, directory_visitate: dirsScanned, oggetti: out.length,
    elenco: maxDepth === 1 ? out.map(({ livello: _l, ...rest }) => rest) : out,
  };
  if (notes.length) res.nota = notes.join('; ');
  return json(res);
});

function depth1Empty(out: Entry[], firstDirEmpty: boolean): boolean {
  return out.length === 0 && firstDirEmpty;
}

/* ---------------- stat ---------------- */

const inputStat = {
  percorso: z.string().describe('Percorso assoluto di un file o directory IFS'),
};

export const ifsStat = tool<
  z.infer<z.ZodObject<typeof inputStat>>
>('as400_ifs_stat', async (args): Promise<ToolResult> => {
  const p = norm(await safeIfsPath(args.percorso));
  const rows = await statRows(p);
  const self = rows.find((e) => norm(e.percorso) === p);
  if (!self) throw new Error(`Percorso non trovato o senza autorità: ${p}`);
  const res: Record<string, unknown> = {
    percorso: p,
    tipo: self.tipo,
    dimensione: self.dimensione,
    proprietario: self.proprietario,
    ccsid: self.ccsid,
    modificato: self.modificato,
  };
  if (self.tipo === '*DIR') res.voci_dirette = rows.length - 1;
  if (self.tipo === '*SYMLNK') res.nota = 'collegamento simbolico: la dimensione è la lunghezza del percorso di destinazione';
  if (String(self.ccsid) === '65535') res.nota = 'CCSID 65535 (binario): usa as400_ifs_read_binary invece di as400_ifs_read';
  return json(res);
});

/* ---------------- lettura testo ---------------- */

const inputRead = {
  percorso: z.string().describe('Percorso assoluto del file di testo IFS'),
  numeriRiga: z.boolean().optional().describe('Prefissa ogni riga con il numero progressivo (default true)'),
  daRiga: z.number().int().min(1).optional().describe('Riga di partenza (1-based), per leggere in blocchi'),
  aRiga: z.number().int().min(1).optional().describe('Riga di fine inclusa'),
  utf8: z.boolean().optional().describe('Forza la decodifica UTF-8 (per file con CCSID errato nel tag); default usa il CCSID del file'),
};

/** Legge un file di testo IFS: la finestra di righe è selezionata sul server, non si trasferisce l'intero file. */
export const ifsRead = tool<
  z.infer<z.ZodObject<typeof inputRead>>
>('as400_ifs_read', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const p = await safeIfsPath(args.percorso);
  const first = args.daRiga ?? 1;
  const last = Math.min(args.aRiga ?? first + cfg.ifsMaxLines - 1, first + cfg.ifsMaxLines - 1);
  if (last < first) throw new Error('aRiga deve essere >= daRiga');
  const fn = args.utf8 ? 'IFS_READ_UTF8' : 'IFS_READ';
  const rows = await normalizedQuery(
    `SELECT LINE_NUMBER, LINE, TOT FROM (
        SELECT LINE_NUMBER, LINE, MAX(LINE_NUMBER) OVER () AS TOT FROM TABLE(QSYS2.${fn}(${PATH_PARAM}))
      ) X WHERE LINE_NUMBER BETWEEN ? AND ? ORDER BY LINE_NUMBER`,
    [p, first, last],
    { trim: false }, // conserva l'indentazione
  );
  if (rows.length === 0) {
    const probe = await normalizedQuery(`SELECT COUNT(*) AS N FROM TABLE(QSYS2.${fn}(${PATH_PARAM}))`, [p]);
    const n = Number(pick(probe[0] ?? {}, 'N') ?? 0);
    if (n === 0) {
      return json({
        percorso: p, righe: 0,
        nota: 'nessun contenuto: file inesistente, vuoto, binario o autorità insufficiente (per i binari usa as400_ifs_read_binary)',
      });
    }
    return json({ percorso: p, righe_totali: n, nota: `daRiga ${first} oltre la fine del file` });
  }
  const total = Number(pick(rows[0], 'TOT') ?? rows.length);
  const lines = rows.map((r) => String(pick(r, 'LINE') ?? ''));
  const firstNo = Number(pick(rows[0], 'LINE_NUMBER') ?? first);
  const body = args.numeriRiga === false ? lines.join('\n') : numberLines(lines, firstNo);
  const meta: Record<string, unknown> = { percorso: p, righe_totali: total, prima_riga: firstNo, ultima_riga: firstNo + lines.length - 1 };
  if (firstNo + lines.length - 1 < total && args.aRiga === undefined) {
    meta.nota = `troncato a ${cfg.ifsMaxLines} righe (IFS_MAX_LINES); usa daRiga/aRiga per leggere il resto`;
  }
  return text(`${JSON.stringify(meta)}\n${capText(body, cfg.ifsMaxChars, 'file IFS')}`);
});

/* ---------------- lettura binaria (hexdump) ---------------- */

const inputBin = {
  percorso: z.string().describe('Percorso assoluto del file IFS'),
  offset: z.number().int().min(0).optional().describe('Byte di partenza (default 0)'),
  lunghezza: z.number().int().min(1).optional().describe('Byte da leggere (default 256, tetto IFS_BINARY_MAX_BYTES)'),
};

const ROW = 16;

/** Anteprima esadecimale di un file IFS (le righe da 16 byte sono selezionate sul server). */
export const ifsReadBinary = tool<
  z.infer<z.ZodObject<typeof inputBin>>
>('as400_ifs_read_binary', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const p = await safeIfsPath(args.percorso);
  const offset = args.offset ?? 0;
  const len = Math.min(args.lunghezza ?? 256, cfg.ifsBinaryMaxBytes);
  const firstRow = Math.floor(offset / ROW) + 1;
  const lastRow = Math.floor((offset + len - 1) / ROW) + 1;
  const rows = await normalizedQuery(
    `SELECT LINE_NUMBER, HEX(LINE) AS H FROM TABLE(QSYS2.IFS_READ_BINARY(${PATH_PARAM}, ${ROW}, 'NONE'))
      WHERE LINE_NUMBER BETWEEN ? AND ? ORDER BY LINE_NUMBER`,
    [p, firstRow, lastRow],
  );
  if (rows.length === 0) {
    return json({ percorso: p, nota: 'nessun dato: offset oltre la fine, file vuoto o inesistente, oppure autorità insufficiente' });
  }
  const dump: string[] = [];
  for (const r of rows) {
    const rowOff = (Number(pick(r, 'LINE_NUMBER')) - 1) * ROW;
    const hex = String(pick(r, 'H') ?? '');
    const bytes = hex.match(/../g) ?? [];
    const cells = bytes.map((b) => b.toUpperCase());
    const ascii = bytes.map((b) => {
      const n = Number.parseInt(b, 16);
      return n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : '.';
    }).join('');
    dump.push(`${rowOff.toString(16).padStart(8, '0')}  ${cells.join(' ').padEnd(ROW * 3 - 1)}  |${ascii}|`);
  }
  const meta = { percorso: p, offset: (firstRow - 1) * ROW, nota: 'righe allineate a 16 byte', byte_mostrati: rows.reduce((n, r) => n + String(pick(r, 'H') ?? '').length / 2, 0) };
  return text(`${JSON.stringify(meta)}\n${dump.join('\n')}`);
});

/* ---------------- ricerca testuale ---------------- */

const inputSearch = {
  percorso: z.string().describe('Directory IFS da cui partire'),
  testo: z.string().min(2).describe('Testo da cercare (sottostringa, non regex)'),
  profondita: z.number().int().min(1).max(6).optional().describe('Livelli da scendere (default 3)'),
  filtro: z.string().optional().describe('Filtro nome file (SQL LIKE), es. %.sh o %.js'),
  maiuscole: z.boolean().optional().describe('Distingue maiuscole/minuscole (default false)'),
  limite: z.number().int().min(1).max(1000).optional().describe('Massimo righe trovate (default 100)'),
  maxFile: z.number().int().min(1).optional().describe('Massimo file scansionati (default IFS_SEARCH_MAX_FILES)'),
  maxByteFile: z.number().int().min(1).optional().describe('Salta i file più grandi di questi byte (default 1000000)'),
};

/** Cerca un testo nei file di testo sotto una directory IFS. */
export const ifsSearch = tool<
  z.infer<z.ZodObject<typeof inputSearch>>
>('as400_ifs_search', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const root = norm(await safeIfsPath(args.percorso));
  if (isSpecialFs(root)) {
    throw new Error('La ricerca non è disponibile nei file system speciali (QSYS.LIB, QDLS, ...): per i sorgenti usa as400_source_search');
  }
  const needle = args.testo.trim();
  if (needle.length < 2) throw new Error('Il testo da cercare deve avere almeno 2 caratteri');
  const maxDepth = args.profondita ?? 3;
  const maxFile = args.maxFile ?? cfg.ifsSearchMaxFiles;
  const maxBytes = args.maxByteFile ?? 1_000_000;
  const limite = args.limite ?? 100;
  const re = args.filtro ? likeRegex(args.filtro) : null;
  const hide = hideSymlinks();
  const deadline = Date.now() + cfg.searchTimeoutMs;
  const notes: string[] = [];

  // 1) individua i file candidati (visita per livelli)
  const files: Entry[] = [];
  let queue: string[] = [root];
  let skippedBig = 0;
  let skippedBinary = 0;
  let dirs = 0;
  let stop = false;
  for (let depth = 1; depth <= maxDepth && queue.length > 0 && !stop; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (Date.now() > deadline || dirs >= 300) { notes.push('visita delle directory interrotta (tempo o numero di directory)'); stop = true; break; }
      const entries = (await withTimeout(statRows(dir), cfg.sqlTimeoutMs, 'elenco IFS')).filter((e) => norm(e.percorso) !== dir);
      dirs++;
      for (const e of entries) {
        if (e.tipo === '*SYMLNK' && hide) continue;
        if (e.tipo === '*DIR') { if (depth < maxDepth) next.push(norm(e.percorso)); continue; }
        if (e.tipo !== '*STMF') continue;
        if (re && !re.test(e.nome)) continue;
        if (String(e.ccsid) === '65535') { skippedBinary++; continue; }
        if (Number(e.dimensione) > maxBytes) { skippedBig++; continue; }
        files.push(e);
        if (files.length > maxFile) { stop = true; break; }
      }
      if (stop) break;
    }
    queue = next;
  }
  const truncFiles = files.length > maxFile;
  const todo = files.slice(0, maxFile);

  // 2) scansione lato server a lotti
  const pattern = '%' + (args.maiuscole ? needle : needle.toUpperCase()).replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
  const col = args.maiuscole ? 'LINE' : 'UPPER(LINE)';
  const found: Array<{ file: string; riga: number; testo: string }> = [];
  const BATCH = 10;
  let scanned = 0;
  let timedOut = false;
  for (let i = 0; i < todo.length && found.length < limite; i += BATCH) {
    const left = deadline - Date.now();
    if (left <= 0) { timedOut = true; break; }
    const batch = todo.slice(i, i + BATCH);
    const params: unknown[] = [];
    const parts = batch.map((f) => {
      params.push(f.percorso, pattern);
      // IGNORE_ERRORS: un file illeggibile non fa fallire l'intero lotto
      return `SELECT '${f.percorso.replace(/'/g, "''")}' AS P, LINE_NUMBER AS N, LINE
                FROM TABLE(QSYS2.IFS_READ(PATH_NAME => ${PATH_PARAM}, IGNORE_ERRORS => 'YES')) X
               WHERE ${col} LIKE ? ESCAPE '\\'`;
    });
    const rows = await withTimeout(
      normalizedQuery(`${parts.join(' UNION ALL ')} FETCH FIRST ${limite - found.length} ROWS ONLY`, params, { trim: false }),
      left, 'ricerca IFS',
    );
    scanned += batch.length;
    for (const r of rows) {
      found.push({ file: String(pick(r, 'P')), riga: Number(pick(r, 'N')), testo: String(pick(r, 'LINE') ?? '').replace(/\s+$/, '').slice(0, 220) });
    }
  }
  if (found.length >= limite) notes.push(`raggiunto il limite di ${limite} righe (altri file possono non essere stati scansionati)`);
  if (truncFiles) notes.push(`elenco file troncato a ${maxFile}: restringi con 'filtro'/'percorso' o aumenta 'maxFile'`);
  if (timedOut) notes.push(`tempo massimo di ricerca (${cfg.searchTimeoutMs} ms) raggiunto`);
  if (skippedBig) notes.push(`${skippedBig} file oltre ${maxBytes} byte saltati`);
  if (skippedBinary) notes.push(`${skippedBinary} file binari (CCSID 65535) saltati`);
  const res: Record<string, unknown> = {
    percorso: root, cercato: needle, file_scansionati: scanned, trovate: found.length, risultati: found,
  };
  if (notes.length) res.nota = notes.join('; ');
  return json(res);
});
