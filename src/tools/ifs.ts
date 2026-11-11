import { z } from 'zod';
import { normalizedQuery, withTimeout } from '../pool.js';
import { getConfig } from '../config.js';
import { safeIfsPath, isSpecialFs, hideSymlinks } from '../ifsguard.js';
import { text, json, tool, capText, likeRegex, pick, numberLines, metaLine } from './common.js';
import type { ToolResult } from './common.js';
import { t, paramName } from '../i18n.js';

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
  percorso: z.string(),
  profondita: z.number().int().min(1).max(6).optional(),
  filtro: z.string().optional(),
  tipo: z.enum(['tutti', 'file', 'directory']).optional(),
  maxVoci: z.number().int().min(1).max(2000).optional(),
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
      if (Date.now() > deadline) { notes.push(t({ it: 'tempo massimo ({ms} ms) raggiunto', en: 'maximum time ({ms} ms) reached' }, { ms: cfg.searchTimeoutMs })); truncated = true; break; }
      if (dirsScanned >= maxDirs) { notes.push(t({ it: 'limite di {n} directory visitate raggiunto', en: 'limit of {n} visited directories reached' }, { n: maxDirs })); truncated = true; break; }
      const entries = (await withTimeout(statRows(dir), cfg.sqlTimeoutMs, { it: 'elenco IFS', en: 'IFS listing' }))
        .filter((e) => norm(e.percorso) !== dir);
      dirsScanned++;
      if (depth === 1 && entries.length === 0) firstDirEmpty = true;
      for (const e of entries) {
        if (e.tipo === '*SYMLNK' && hide) { hidden++; continue; }
        if (e.tipo === '*DIR' && depth < maxDepth) next.push(norm(e.percorso));
        const okType = args.tipo === 'file' ? e.tipo !== '*DIR' : args.tipo === 'directory' ? e.tipo === '*DIR' : true;
        if (okType && (!re || re.test(e.nome))) {
          if (out.length >= maxVoci) { truncated = true; notes.push(t({ it: 'raggiunto il limite di {n} voci', en: 'reached the limit of {n} entries' }, { n: maxVoci })); break; }
          out.push({ ...e, livello: depth });
        }
      }
      if (truncated) break;
    }
    queue = next;
  }
  if (depth1Empty(out, firstDirEmpty)) {
    return json({ percorso: p, oggetti: 0, nota: t({ it: 'directory vuota, inesistente o senza autorità', en: 'directory empty, nonexistent or no authority' }) });
  }
  if (hidden) notes.push(t({ it: '{n} collegamenti simbolici omessi (IFS_ALLOWED_PREFIXES attivo)', en: '{n} symbolic links omitted (IFS_ALLOWED_PREFIXES active)' }, { n: hidden }));
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
  percorso: z.string(),
};

export const ifsStat = tool<
  z.infer<z.ZodObject<typeof inputStat>>
>('as400_ifs_stat', async (args): Promise<ToolResult> => {
  const p = norm(await safeIfsPath(args.percorso));
  const rows = await statRows(p);
  const self = rows.find((e) => norm(e.percorso) === p);
  if (!self) throw new Error(t({ it: 'Percorso non trovato o senza autorità: {p}', en: 'Path not found or no authority: {p}' }, { p }));
  const res: Record<string, unknown> = {
    percorso: p,
    tipo: self.tipo,
    dimensione: self.dimensione,
    proprietario: self.proprietario,
    ccsid: self.ccsid,
    modificato: self.modificato,
  };
  if (self.tipo === '*DIR') res.voci_dirette = rows.length - 1;
  if (self.tipo === '*SYMLNK') res.nota = t({ it: 'collegamento simbolico: la dimensione è la lunghezza del percorso di destinazione', en: 'symbolic link: the size is the length of the target path' });
  if (String(self.ccsid) === '65535') res.nota = t({ it: 'CCSID 65535 (binario): usa as400_ifs_read_binary invece di as400_ifs_read', en: 'CCSID 65535 (binary): use as400_ifs_read_binary instead of as400_ifs_read' });
  return json(res);
});

/* ---------------- lettura testo ---------------- */

const inputRead = {
  percorso: z.string(),
  numeriRiga: z.boolean().optional(),
  daRiga: z.number().int().min(1).optional(),
  aRiga: z.number().int().min(1).optional(),
  utf8: z.boolean().optional(),
};

/** Legge un file di testo IFS: la finestra di righe è selezionata sul server, non si trasferisce l'intero file. */
export const ifsRead = tool<
  z.infer<z.ZodObject<typeof inputRead>>
>('as400_ifs_read', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const p = await safeIfsPath(args.percorso);
  const first = args.daRiga ?? 1;
  const last = Math.min(args.aRiga ?? first + cfg.ifsMaxLines - 1, first + cfg.ifsMaxLines - 1);
  if (last < first) throw new Error(t({ it: '{a} deve essere >= {da}', en: '{a} must be >= {da}' }, { a: paramName('aRiga'), da: paramName('daRiga') }));
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
        nota: t({
          it: 'nessun contenuto: file inesistente, vuoto, binario o autorità insufficiente (per i binari usa as400_ifs_read_binary)',
          en: 'no content: file nonexistent, empty, binary or insufficient authority (for binaries use as400_ifs_read_binary)',
        }),
      });
    }
    return json({ percorso: p, righe_totali: n, nota: t({ it: '{da} {first} oltre la fine del file', en: '{da} {first} is past the end of the file' }, { da: paramName('daRiga'), first }) });
  }
  const total = Number(pick(rows[0], 'TOT') ?? rows.length);
  const lines = rows.map((r) => String(pick(r, 'LINE') ?? ''));
  const firstNo = Number(pick(rows[0], 'LINE_NUMBER') ?? first);
  const body = args.numeriRiga === false ? lines.join('\n') : numberLines(lines, firstNo);
  const meta: Record<string, unknown> = { percorso: p, righe_totali: total, prima_riga: firstNo, ultima_riga: firstNo + lines.length - 1 };
  if (firstNo + lines.length - 1 < total && args.aRiga === undefined) {
    meta.nota = t({
      it: 'troncato a {n} righe (IFS_MAX_LINES); usa {da}/{a} per leggere il resto',
      en: 'truncated to {n} lines (IFS_MAX_LINES); use {da}/{a} to read the rest',
    }, { n: cfg.ifsMaxLines, da: paramName('daRiga'), a: paramName('aRiga') });
  }
  return text(`${metaLine(meta)}\n${capText(body, cfg.ifsMaxChars, { it: 'file IFS', en: 'IFS file' })}`);
});

/* ---------------- lettura binaria (hexdump) ---------------- */

const inputBin = {
  percorso: z.string(),
  offset: z.number().int().min(0).optional(),
  lunghezza: z.number().int().min(1).optional(),
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
    return json({
      percorso: p,
      nota: t({
        it: 'nessun dato: offset oltre la fine, file vuoto o inesistente, oppure autorità insufficiente',
        en: 'no data: offset past the end, file empty or nonexistent, or insufficient authority',
      }),
    });
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
  const meta = { percorso: p, offset: (firstRow - 1) * ROW, nota: t({ it: 'righe allineate a 16 byte', en: 'rows aligned to 16 bytes' }), byte_mostrati: rows.reduce((n, r) => n + String(pick(r, 'H') ?? '').length / 2, 0) };
  return text(`${metaLine(meta)}\n${dump.join('\n')}`);
});

/* ---------------- ricerca testuale ---------------- */

const inputSearch = {
  percorso: z.string(),
  testo: z.string().min(2),
  profondita: z.number().int().min(1).max(6).optional(),
  filtro: z.string().optional(),
  maiuscole: z.boolean().optional(),
  limite: z.number().int().min(1).max(1000).optional(),
  maxFile: z.number().int().min(1).optional(),
  maxByteFile: z.number().int().min(1).optional(),
};

/** Cerca un testo nei file di testo sotto una directory IFS. */
export const ifsSearch = tool<
  z.infer<z.ZodObject<typeof inputSearch>>
>('as400_ifs_search', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const root = norm(await safeIfsPath(args.percorso));
  if (isSpecialFs(root)) {
    throw new Error(t({
      it: 'La ricerca non è disponibile nei file system speciali (QSYS.LIB, QDLS, ...): per i sorgenti usa as400_source_search',
      en: 'Search is not available in the special file systems (QSYS.LIB, QDLS, ...): for sources use as400_source_search',
    }));
  }
  const needle = args.testo.trim();
  if (needle.length < 2) throw new Error(t({ it: 'Il testo da cercare deve avere almeno 2 caratteri', en: 'The text to search for must be at least 2 characters long' }));
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
      if (Date.now() > deadline || dirs >= 300) { notes.push(t({ it: 'visita delle directory interrotta (tempo o numero di directory)', en: 'directory traversal stopped (time or number of directories)' })); stop = true; break; }
      const entries = (await withTimeout(statRows(dir), cfg.sqlTimeoutMs, { it: 'elenco IFS', en: 'IFS listing' })).filter((e) => norm(e.percorso) !== dir);
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
      left, { it: 'ricerca IFS', en: 'IFS search' },
    );
    scanned += batch.length;
    for (const r of rows) {
      found.push({ file: String(pick(r, 'P')), riga: Number(pick(r, 'N')), testo: String(pick(r, 'LINE') ?? '').replace(/\s+$/, '').slice(0, 220) });
    }
  }
  if (found.length >= limite) notes.push(t({ it: 'raggiunto il limite di {n} righe (altri file possono non essere stati scansionati)', en: 'reached the limit of {n} lines (other files may not have been scanned)' }, { n: limite }));
  if (truncFiles) notes.push(t({
    it: "elenco file troncato a {n}: restringi con '{filtro}'/'{percorso}' o aumenta '{maxFile}'",
    en: "file list truncated to {n}: narrow with '{filtro}'/'{percorso}' or raise '{maxFile}'",
  }, { n: maxFile, filtro: paramName('filtro'), percorso: paramName('percorso'), maxFile: paramName('maxFile') }));
  if (timedOut) notes.push(t({ it: 'tempo massimo di ricerca ({ms} ms) raggiunto', en: 'maximum search time ({ms} ms) reached' }, { ms: cfg.searchTimeoutMs }));
  if (skippedBig) notes.push(t({ it: '{n} file oltre {bytes} byte saltati', en: '{n} files over {bytes} bytes skipped' }, { n: skippedBig, bytes: maxBytes }));
  if (skippedBinary) notes.push(t({ it: '{n} file binari (CCSID 65535) saltati', en: '{n} binary files (CCSID 65535) skipped' }, { n: skippedBinary }));
  const res: Record<string, unknown> = {
    percorso: root, cercato: needle, file_scansionati: scanned, trovate: found.length, risultati: found,
  };
  if (notes.length) res.nota = notes.join('; ');
  return json(res);
});
