import { getConfig, ifsPath } from './config.js';
import { normalizedQuery } from './pool.js';

/** File system speciali: niente ricorsione/ricerca (usare i tool dedicati per sorgenti e oggetti). */
const SPECIAL_FS = /^\/(QSYS\.LIB|QDLS|QNTC|QFILESVR\.400|QOPT|QLANSRV|QSR|QOPENSYS\/QSYS\.LIB)(\/|$)/i;

export function isSpecialFs(p: string): boolean {
  return SPECIAL_FS.test(p);
}

/** Cache (60 s) dei link simbolici presenti in una directory. */
const symCache = new Map<string, { at: number; links: Set<string> }>();
const CACHE_MS = 60_000;

/** Elenco dei percorsi *SYMLNK figli diretti di `dir` (filtro lato server: economico anche su directory grandi). */
export async function symlinksIn(dir: string): Promise<Set<string>> {
  const hit = symCache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.links;
  const rows = await normalizedQuery(
    `SELECT PATH_NAME FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(CAST(? AS VARCHAR(32709)), 'NO', '*SYMLNK'))`,
    [dir],
  );
  const links = new Set(rows.map((r) => String((r as { PATH_NAME?: unknown }).PATH_NAME ?? '')));
  symCache.set(dir, { at: Date.now(), links });
  return links;
}

/** Prefisso consentito più lungo che contiene `p` (o null se non ci sono restrizioni). */
function matchingPrefix(p: string): string | null {
  const prefixes = getConfig().ifsAllowedPrefixes;
  if (!prefixes || prefixes.length === 0) return null;
  const norm = prefixes
    .map((raw) => '/' + raw.split('/').filter((x) => x !== '' && x !== '.').join('/'))
    .filter((x) => p === x || p.startsWith(x === '/' ? '/' : x + '/'))
    .sort((a, b) => b.length - a.length);
  return norm[0] ?? null;
}

/**
 * Valida un percorso IFS: sintassi + IFS_ALLOWED_PREFIXES + (se i prefissi sono attivi) nessun link simbolico
 * tra il prefisso e la destinazione, perché un link potrebbe puntare fuori dall'area consentita.
 */
export async function safeIfsPath(value: string): Promise<string> {
  const p = ifsPath(value);
  const prefix = matchingPrefix(p);
  if (prefix === null || prefix === '/') return p;
  if (isSpecialFs(p)) return p;
  const rest = p.slice(prefix.length).split('/').filter(Boolean);
  let dir = prefix;
  for (const seg of rest) {
    const child = dir === '/' ? `/${seg}` : `${dir}/${seg}`;
    const links = await symlinksIn(dir);
    if (links.has(child)) {
      throw new Error(`Percorso non consentito: '${child}' è un collegamento simbolico (non seguito con IFS_ALLOWED_PREFIXES attivo)`);
    }
    dir = child;
  }
  return p;
}

/** True se i collegamenti simbolici vanno esclusi dai risultati (restrizioni attive). */
export function hideSymlinks(): boolean {
  const prefixes = getConfig().ifsAllowedPrefixes;
  return !!prefixes && prefixes.length > 0 && !prefixes.includes('/');
}
