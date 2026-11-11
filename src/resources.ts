import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { normalizedQuery } from './pool.js';
import { getConfig, objName } from './config.js';
import { audit } from './audit.js';
import { t as tr, paramName } from './i18n.js';
import { capText } from './tools/common.js';
import { readMemberLines } from './tools/source.js';
import { ifsRead } from './tools/ifs.js';
import { fileDesc } from './tools/sql.js';
import { spoolRead } from './tools/spool.js';
import { systemInfo } from './tools/system.js';
import type { ToolResult } from './tools/common.js';
import { nameCond } from './tools/catalog.js';

/** Testo di un risultato tool; se è un errore lo rilancia (le risorse segnalano gli errori come eccezioni). */
export function textOf(r: ToolResult): string {
  const t = r.content.map((c) => c.text).join('\n');
  if (r.isError) throw new Error(t);
  return t;
}

/** Valore singolo di una variabile di template (può essere un array) con decodifica percent-encoding. */
function v(vars: Record<string, string | string[]>, name: string): string {
  const raw = vars[name];
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) throw new Error(tr({ it: "Variabile mancante nell'URI: {name}", en: 'Missing variable in the URI: {name}' }, { name }));
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const text = (uri: URL, body: string, mimeType: string): ReadResourceResult => ({
  contents: [{ uri: uri.href, mimeType, text: body }],
});

/** Esegue una lettura di risorsa con audit coerente con i tool. */
async function audited<T>(name: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    audit({ tool: name, args, ms: Date.now() - t0, ok: true });
    return out;
  } catch (err) {
    audit({ tool: name, args, ms: Date.now() - t0, ok: false, error: String((err as Error).message).split('\n')[0].slice(0, 300) });
    throw err;
  }
}

/* ---------------- completamenti (best effort: mai un errore al client) ---------------- */

async function safeComplete(f: () => Promise<string[]>): Promise<string[]> {
  try {
    return await f();
  } catch {
    return [];
  }
}

export function completeLibrary(prefix: string): Promise<string[]> {
  return safeComplete(async () => {
    const cfg = getConfig();
    const p = prefix.trim().toUpperCase();
    if (cfg.allowedLibs) return cfg.allowedLibs.filter((l) => l.startsWith(p)).slice(0, 50);
    if (!/^[A-Z0-9_$#@]*$/.test(p)) return [];
    const rows = await normalizedQuery(
      `SELECT SYSTEM_SCHEMA_NAME AS N FROM QSYS2.SYSSCHEMAS WHERE SYSTEM_SCHEMA_NAME LIKE ? ORDER BY 1 FETCH FIRST 50 ROWS ONLY`,
      [`${p}%`],
    );
    return rows.map((r) => String((r as { N?: unknown }).N ?? '')).filter(Boolean);
  });
}

export function completeSourceFile(lib: string | undefined, prefix: string): Promise<string[]> {
  return safeComplete(async () => {
    if (!lib) return [];
    const l = objName(lib, 'libreria');
    const c = nameCond('SYSTEM_TABLE_NAME', `${prefix.trim()}%`);
    const rows = await normalizedQuery(
      `SELECT RTRIM(SYSTEM_TABLE_NAME) AS N FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ? AND FILE_TYPE = 'S' AND ${c.sql} ORDER BY 1 FETCH FIRST 50 ROWS ONLY`,
      [l, c.param],
    );
    return rows.map((r) => String((r as { N?: unknown }).N ?? ''));
  });
}

export function completeMember(lib: string | undefined, file: string | undefined, prefix: string): Promise<string[]> {
  return safeComplete(async () => {
    if (!lib || !file) return [];
    const c = nameCond('RTRIM(SYSTEM_TABLE_MEMBER)', `${prefix.trim()}%`);
    const rows = await normalizedQuery(
      `SELECT RTRIM(SYSTEM_TABLE_MEMBER) AS N FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? AND ${c.sql} ORDER BY 1 FETCH FIRST 50 ROWS ONLY`,
      [objName(lib, 'libreria'), objName(file, 'file'), c.param],
    );
    return rows.map((r) => String((r as { N?: unknown }).N ?? ''));
  });
}

export function completeFile(lib: string | undefined, prefix: string): Promise<string[]> {
  return safeComplete(async () => {
    if (!lib) return [];
    const c = nameCond('SYSTEM_TABLE_NAME', `${prefix.trim()}%`);
    const rows = await normalizedQuery(
      `SELECT RTRIM(SYSTEM_TABLE_NAME) AS N FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ? AND ${c.sql} ORDER BY 1 FETCH FIRST 50 ROWS ONLY`,
      [objName(lib, 'libreria'), c.param],
    );
    return rows.map((r) => String((r as { N?: unknown }).N ?? ''));
  });
}

/* ---------------- registrazione ---------------- */

export function registerResources(server: McpServer): void {
  const cfg = getConfig;

  server.registerResource(
    tr({ it: 'sistema', en: 'system' }),
    tr({ it: 'as400://sistema', en: 'as400://system' }),
    {
      title: tr({ it: 'Informazioni di sistema', en: 'System information' }),
      description: tr({
        it: 'Utente connesso, versione IBM i e limiti attivi del server.',
        en: "Connected user, IBM i version and the server's active limits.",
      }),
      mimeType: 'application/json',
    },
    async (uri) => text(uri, await audited('resource:sistema', {}, async () => textOf(await systemInfo({}))), 'application/json'),
  );

  server.registerResource(
    tr({ it: 'sorgente', en: 'source' }),
    new ResourceTemplate('as400://source/{lib}/{file}/{member}', {
      list: undefined,
      complete: {
        lib: (value) => completeLibrary(value),
        file: (value, ctx) => completeSourceFile(ctx?.arguments?.lib, value),
        member: (value, ctx) => completeMember(ctx?.arguments?.lib, ctx?.arguments?.file, value),
      },
    }),
    {
      title: tr({ it: 'Membro sorgente', en: 'Source member' }),
      description: tr({
        it: 'Testo di un membro di un file sorgente (RPG, CL, DDS, ...) con le colonne originali. Es. as400://source/MYLIB/QRPGLESRC/PGM001',
        en: 'Text of a member of a source file (RPG, CL, DDS, ...) with the original columns. E.g. as400://source/MYLIB/QRPGLESRC/PGM001',
      }),
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const lib = objName(v(vars, 'lib'), 'libreria');
      const file = objName(v(vars, 'file'), 'file');
      const member = objName(v(vars, 'member'), 'membro');
      const body = await audited('resource:source', { lib, file, member }, async () => {
        const lines = await readMemberLines(lib, file, member);
        const shown = lines.slice(0, cfg().sourceMaxLines);
        let out = shown.join('\n');
        if (lines.length > shown.length) {
          out += '\n' + tr({
            it: '... [troncato: {n} righe omesse; usa as400_source_read con {da}/{a}]',
            en: '... [truncated: {n} lines omitted; use as400_source_read with {da}/{a}]',
          }, { n: lines.length - shown.length, da: paramName('daRiga'), a: paramName('aRiga') });
        }
        return capText(out, cfg().sourceMaxChars, { it: 'sorgente', en: 'source' });
      });
      return text(uri, body, 'text/plain');
    },
  );

  server.registerResource(
    tr({ it: 'file', en: 'file' }),
    new ResourceTemplate('as400://file/{lib}/{name}', {
      list: undefined,
      complete: {
        lib: (value) => completeLibrary(value),
        name: (value, ctx) => completeFile(ctx?.arguments?.lib, value),
      },
    }),
    {
      title: tr({ it: 'Descrizione di un file', en: 'File description' }),
      description: tr({
        it: 'Descrizione JSON di un file fisico/logico: campi, tipi, chiave DDS. Es. as400://file/MYLIB/CLIENTI',
        en: 'JSON description of a physical/logical file: fields, types, DDS key. E.g. as400://file/MYLIB/CUSTOMERS',
      }),
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const lib = v(vars, 'lib');
      const name = v(vars, 'name');
      const body = await audited('resource:file', { lib, name }, async () => textOf(await fileDesc({ libreria: lib, file: name })));
      return text(uri, body, 'application/json');
    },
  );

  server.registerResource(
    tr({ it: 'ifs', en: 'ifs' }),
    new ResourceTemplate('as400://ifs{+path}', { list: undefined }),
    {
      title: tr({ it: 'File IFS', en: 'IFS file' }),
      description: tr({
        it: 'Contenuto testuale di un file IFS. Es. as400://ifs/home/profilo/script.sh',
        en: 'Text content of an IFS file. E.g. as400://ifs/home/profile/script.sh',
      }),
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const path = v(vars, 'path');
      const body = await audited('resource:ifs', { path }, async () => {
        const out = textOf(await ifsRead({ percorso: path.startsWith('/') ? path : `/${path}`, numeriRiga: false }));
        // la prima riga è il JSON dei metadati
        return out.startsWith('{') ? out.slice(out.indexOf('\n') + 1) : out;
      });
      return text(uri, body, 'text/plain');
    },
  );

  server.registerResource(
    tr({ it: 'spool', en: 'spool' }),
    new ResourceTemplate('as400://spool/{lib}/{outq}/{file}/{number}', {
      list: undefined,
      complete: { lib: (value) => completeLibrary(value) },
    }),
    {
      title: tr({ it: 'File di spool', en: 'Spooled file' }),
      description: tr({
        it: 'Contenuto testuale di un file di spool. Es. as400://spool/QGPL/QPRINT/ES52/6',
        en: 'Text content of a spooled file. E.g. as400://spool/QGPL/QPRINT/ES52/6',
      }),
      mimeType: 'text/plain',
    },
    async (uri, vars) => {
      const lib = v(vars, 'lib');
      const outq = v(vars, 'outq');
      const file = v(vars, 'file');
      const numero = Number.parseInt(v(vars, 'number'), 10);
      if (!Number.isInteger(numero) || numero < 1) throw new Error(tr({ it: 'Numero del file di spool non valido', en: 'Invalid spooled file number' }));
      const body = await audited('resource:spool', { lib, outq, file, numero }, async () => {
        const out = textOf(await spoolRead({ libreria: lib, outq, file, numero }));
        try {
          // la chiave del contenuto dipende dalla lingua (contenuto / content)
          const j = JSON.parse(out) as { contenuto?: string; content?: string };
          return j.contenuto ?? j.content ?? out;
        } catch {
          return out;
        }
      });
      return text(uri, body, 'text/plain');
    },
  );
}
