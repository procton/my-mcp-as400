/* Guardia SQL per il tool as400_sql_query.
 * Difesa a strati: (1) questo controllo lessicale, (2) connessione JDBC `access=read only`
 * (il server rifiuta comunque ogni scrittura), (3) allow-list ALLOWED_LIBS sui riferimenti di tabella. */
import { t as tr } from './i18n.js';

interface Tok {
  /** 'w' parola, 'q' identificatore tra doppi apici, 's' stringa, 'p' punteggiatura */
  t: 'w' | 'q' | 's' | 'p';
  v: string;
  start: number;
  end: number;
}

/** Schemi di catalogo/sistema sempre leggibili anche con ALLOWED_LIBS (solo metadati). */
export const SYSTEM_SCHEMAS = ['QSYS2', 'SYSIBM', 'SYSIBMADM', 'SYSTOOLS', 'SYSCAT', 'SYSSTAT'];

const FORBIDDEN_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL', 'DROP', 'CREATE', 'ALTER', 'GRANT', 'REVOKE', 'TRUNCATE',
]);

/** Funzioni/oggetti con effetti o con accesso a risorse che hanno tool dedicati (con controlli propri). */
const FORBIDDEN_OBJECTS = new Set([
  'QCMDEXC', 'QCMDCHK', 'IFS_READ', 'IFS_READ_UTF8', 'IFS_READ_BINARY', 'IFS_WRITE', 'IFS_WRITE_UTF8',
  'IFS_WRITE_BINARY', 'IFS_OBJECT_STATISTICS', 'IFS_OBJECT_PRIVILEGES', 'SPOOLED_FILE_DATA', 'DELETE_OLD_SPOOLED_FILES',
]);

const TRAILING_WITH = new Set(['UR', 'CS', 'NC', 'RS', 'RR', 'NONE']);

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      if (e < 0) throw new Error(tr({ it: 'Commento SQL non terminato', en: 'Unterminated SQL comment' }));
      i = e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      let val = '';
      for (;;) {
        if (i >= n) throw new Error(c === "'" ? tr({ it: 'Stringa SQL non terminata', en: 'Unterminated SQL string' }) : tr({ it: 'Identificatore tra apici non terminato', en: 'Unterminated quoted identifier' }));
        if (sql[i] === c) {
          if (sql[i + 1] === c) { val += c; i += 2; continue; }
          i++;
          break;
        }
        val += sql[i++];
      }
      out.push({ t: c === "'" ? 's' : 'q', v: val, start, end: i });
      continue;
    }
    if (/[A-Za-z0-9_$#@]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$#@]/.test(sql[i])) i++;
      out.push({ t: 'w', v: sql.slice(start, i).toUpperCase(), start, end: i });
      continue;
    }
    out.push({ t: 'p', v: c, start: i, end: i + 1 });
    i++;
  }
  return out;
}

export interface GuardOptions {
  allowedLibs: string[] | null;
  maxRows: number;
}

export interface GuardResult {
  /** SQL pronto per l'esecuzione (con limite di righe applicato) */
  sql: string;
  /** limite esplicito già presente nella query a livello esterno */
  explicitLimit: boolean;
}

const isWord = (t: Tok | undefined, ...vals: string[]): boolean =>
  !!t && t.t === 'w' && (vals.length === 0 || vals.includes(t.v));

export function guardReadOnlySql(query: string, opts: GuardOptions): GuardResult {
  const q = query.trim().replace(/;+\s*$/, '').trim();
  if (!q) throw new Error(tr({ it: 'Query vuota', en: 'Empty query' }));
  const toks = tokenize(q);
  if (toks.some((t) => t.t === 'p' && t.v === ';')) throw new Error(tr({ it: 'Un solo statement SQL, senza punto e virgola', en: 'Only one SQL statement, without a semicolon' }));
  if (!isWord(toks[0], 'SELECT', 'WITH')) throw new Error(tr({ it: 'Ammesse solo istruzioni SELECT o WITH (server read-only)', en: 'Only SELECT or WITH statements are allowed (read-only server)' }));

  // parole vietate / oggetti vietati (ignora le parole in stringhe e identificatori tra apici)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'w') continue;
    if (FORBIDDEN_WORDS.has(t.v)) {
      // CALL/SET ecc. non possono comparire in una SELECT lecita
      throw new Error(tr({ it: 'Parola chiave non consentita (server read-only): {kw}', en: 'Keyword not allowed (read-only server): {kw}' }, { kw: t.v }));
    }
    if (FORBIDDEN_OBJECTS.has(t.v)) {
      throw new Error(tr({
        it: 'Oggetto/funzione non consentita in sql_query: {obj} (per IFS e spool usa i tool dedicati)',
        en: 'Object/function not allowed in sql_query: {obj} (use the dedicated tools for IFS and spool)',
      }, { obj: t.v }));
    }
    if (t.v === 'FINAL' || t.v === 'OLD' || t.v === 'NEW') {
      if (isWord(toks[i + 1], 'TABLE')) throw new Error(tr({ it: 'Riferimenti FINAL/OLD/NEW TABLE non consentiti', en: 'FINAL/OLD/NEW TABLE references are not allowed' }));
    }
    if (t.v === 'FOR' && isWord(toks[i + 1], 'UPDATE')) throw new Error(tr({ it: 'FOR UPDATE non consentito (server read-only)', en: 'FOR UPDATE is not allowed (read-only server)' }));
    if (t.v === 'SKIP' && isWord(toks[i + 1], 'LOCKED')) throw new Error(tr({ it: 'SKIP LOCKED DATA non consentito', en: 'SKIP LOCKED DATA is not allowed' }));
  }
  for (const t of toks) {
    if (t.t === 'q' && FORBIDDEN_OBJECTS.has(t.v.toUpperCase())) {
      throw new Error(tr({ it: 'Oggetto/funzione non consentita in sql_query: {obj}', en: 'Object/function not allowed in sql_query: {obj}' }, { obj: t.v }));
    }
  }

  if (opts.allowedLibs) checkSchemas(toks, opts.allowedLibs);

  // limite di righe: cerca FETCH FIRST/NEXT o LIMIT a profondità 0
  let depth = 0;
  let explicitLimit = false;
  let insertAt = q.length;
  let insertFound = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'p' && t.v === '(') depth++;
    else if (t.t === 'p' && t.v === ')') depth--;
    else if (depth === 0 && t.t === 'w') {
      if ((t.v === 'FETCH' && isWord(toks[i + 1], 'FIRST', 'NEXT')) || t.v === 'LIMIT') explicitLimit = true;
      const trailing =
        (t.v === 'FOR' && isWord(toks[i + 1], 'READ', 'FETCH')) ||
        (t.v === 'OPTIMIZE' && isWord(toks[i + 1], 'FOR')) ||
        (t.v === 'WITH' && i > 0 && toks[i + 1]?.t === 'w' && TRAILING_WITH.has(toks[i + 1].v)) ||
        t.v === 'QUERY' && isWord(toks[i + 1], 'TIMEOUT');
      if (trailing && !insertFound) { insertAt = t.start; insertFound = true; }
    }
  }
  const sql = explicitLimit
    ? q
    : `${q.slice(0, insertAt).trimEnd()} FETCH FIRST ${opts.maxRows} ROWS ONLY ${q.slice(insertAt)}`.trimEnd();
  return { sql, explicitLimit };
}

/** Con ALLOWED_LIBS attivo: ogni riferimento in FROM/JOIN deve avere schema consentito (o di catalogo) o essere una CTE. */
function checkSchemas(toks: Tok[], allowed: string[]): void {
  const ok = new Set([...allowed.map((a) => a.toUpperCase()), ...SYSTEM_SCHEMAS]);
  const name = (t: Tok | undefined): string | null =>
    t && (t.t === 'w' || t.t === 'q') ? (t.t === 'q' ? t.v : t.v).toUpperCase() : null;

  // nomi CTE: WITH x AS (  /  , x AS (  /  x (cols) AS (  a profondità 0 nella testata WITH
  const ctes = new Set<string>();
  if (isWord(toks[0], 'WITH')) {
    let depth = 0;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === 'p' && t.v === '(') depth++;
      else if (t.t === 'p' && t.v === ')') depth--;
      else if (depth === 0 && isWord(t, 'SELECT')) break;
      else if (depth === 0 && (toks[i - 1].v === 'WITH' || toks[i - 1].v === ',') && name(t)) {
        if (isWord(t, 'RECURSIVE')) continue;
        ctes.add(name(t)!);
      }
    }
  }

  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], 'FROM', 'JOIN')) continue;
    // FROM a, b, c: percorre la lista separata da virgole (solo per FROM)
    let j = i + 1;
    for (;;) {
      const first = toks[j];
      if (!first) break;
      if (first.t === 'p' && first.v === '(') break; // sotto-select: i suoi FROM sono controllati a parte
      if (isWord(first, 'TABLE', 'LATERAL', 'UNNEST', 'XMLTABLE', 'JSON_TABLE')) {
        // TABLE(fn(...)) : il nome funzione segue la parentesi
        let k = j + 1;
        if (toks[k]?.v === '(') k++;
        j = checkRef(toks, k, ok, ctes, true);
        break;
      }
      j = checkRef(toks, j, ok, ctes, false);
      // alias opzionale
      if (isWord(toks[j], 'AS')) j += 2;
      else if (toks[j] && (toks[j].t === 'q' || (toks[j].t === 'w' && !CLAUSE_WORDS.has(toks[j].v)))) j++;
      if (isWord(toks[i], 'FROM') && toks[j]?.t === 'p' && toks[j].v === ',') { j++; continue; }
      break;
    }
  }
}

const CLAUSE_WORDS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'FETCH', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'CROSS', 'ON', 'USING', 'FOR', 'WITH', 'OPTIMIZE', 'WINDOW', 'NATURAL', 'OUTER',
]);

/** Verifica un riferimento `[schema.]nome` a partire da toks[k]; ritorna l'indice dopo il riferimento. */
function checkRef(toks: Tok[], k: number, ok: Set<string>, ctes: Set<string>, isFunc: boolean): number {
  const a = toks[k];
  if (!a || (a.t !== 'w' && a.t !== 'q')) return k + 1;
  const sep = toks[k + 1];
  const b = toks[k + 2];
  if (sep && sep.t === 'p' && (sep.v === '.' || sep.v === '/') && b && (b.t === 'w' || b.t === 'q')) {
    const schema = a.v.toUpperCase();
    if (!ok.has(schema)) throw new Error(tr({ it: 'Libreria non consentita (ALLOWED_LIBS): {schema}', en: 'Library not allowed (ALLOWED_LIBS): {schema}' }, { schema }));
    return k + 3;
  }
  const nm = a.v.toUpperCase();
  if (!isFunc && ctes.has(nm)) return k + 1;
  throw new Error(tr({
    it: "Con ALLOWED_LIBS attivo ogni tabella/funzione va qualificata con la libreria (LIB.TABELLA): '{name}'",
    en: "With ALLOWED_LIBS active every table/function must be qualified with its library (LIB.TABLE): '{name}'",
  }, { name: a.v }));
}
