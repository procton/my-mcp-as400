import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variabile ambiente mancante: ${name} (vedi .env.example)`);
  return v;
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} non è un intero positivo: ${v}`);
  return n;
}

export interface Config {
  host: string;
  user: string;
  password: string;
  /** JDBC extraproperties eventuali (formato chiave=valore&chiave=valore) */
  jdbcExtra?: string;
  sqlMaxRows: number;
  sourceMaxLines: number;
  /** numero massimo di membri elencati */
  sourceMaxMembers: number;
  ifsMaxLines: number;
  ifsMaxChars: number;
  spoolMaxFiles: number;
  spoolMaxChars: number;
  /** limite di caratteri del testo di un membro sorgente */
  sourceMaxChars: number;
  /** CCSID/charset Java per decodificare gli spool (es. IBM-273, IBM-280, IBM-037) */
  spoolCharset: string;
  /** crea alias temporanei in QTEMP per leggere membri di file sorgente */
  allowQtempAlias: boolean;
  /** elenco (opzionale) di librerie consentite; vuoto = tutte */
  allowedLibs: string[] | null;
  /** elenco (opzionale) di prefissi IFS consentiti (es. /home,/prj); vuoto = tutti */
  ifsAllowedPrefixes: string[] | null;
}

/** Analizza `chiave=valore&chiave=valore` in un oggetto di proprietà JDBC. */
export function parseJdbcExtra(extra: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!extra) return out;
  for (const pair of extra.split('&')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  cached = {
    host: required('AS400_HOST'),
    user: required('AS400_USER'),
    password: required('AS400_PASSWORD'),
    jdbcExtra: process.env.AS400_JDBC_EXTRA?.trim() || undefined,
    sqlMaxRows: int('SQL_MAX_ROWS', 1000),
    sourceMaxLines: int('SOURCE_MAX_LINES', 3000),
    sourceMaxMembers: int('SOURCE_MAX_MEMBERS', 2000),
    ifsMaxLines: int('IFS_MAX_LINES', 5000),
    ifsMaxChars: int('IFS_MAX_CHARS', 400000),
    spoolMaxFiles: int('SPOOL_MAX_FILES', 500),
    spoolMaxChars: int('SPOOL_MAX_CHARS', 200000),
    sourceMaxChars: int('SOURCE_MAX_CHARS', 400000),
    spoolCharset: process.env.SPOOL_CHARSET?.trim() || 'IBM-273',
    allowQtempAlias: (process.env.ALLOW_QTEMP_ALIAS ?? 'true').toLowerCase() !== 'false',
    allowedLibs: process.env.ALLOWED_LIBS
      ? process.env.ALLOWED_LIBS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : null,
    ifsAllowedPrefixes: process.env.IFS_ALLOWED_PREFIXES
      ? process.env.IFS_ALLOWED_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean)
      : null,
  };
  return cached;
}

/** Normalizza e valida un percorso IFS assoluto (read-only, niente attraversamento). */
export function ifsPath(value: string): string {
  const p = value.trim();
  if (!p.startsWith('/')) throw new Error(`Percorso IFS non valido (deve essere assoluto): ${value}`);
  if (p.split('/').some((seg) => seg === '..')) throw new Error(`Percorso IFS non valido (componente '..' vietata): ${value}`);
  if (p.length > 32709) throw new Error(`Percorso IFS troppo lungo: ${value}`);
  const cfg = cached?.ifsAllowedPrefixes;
  if (cfg && cfg.length && !cfg.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) {
    throw new Error(`Percorso IFS non consentito (IFS_ALLOWED_PREFIXES=${cfg.join(',')}): ${p}`);
  }
  return p;
}

/** Normalizza e valida un nome oggetto IBM i (libreria/file/membro). */
export function objName(value: string, what = 'nome'): string {
  const n = value.trim().toUpperCase();
  if (!/^[A-Z0-9_$#@]{1,10}$/.test(n)) {
    throw new Error(`${what} non valido: '${value}' (max 10 caratteri [A-Z0-9_$#@])`);
  }
  if (cached?.allowedLibs && what.startsWith('libreria')) {
    if (!cached.allowedLibs.includes(n)) {
      throw new Error(`Libreria non consentita (ALLOWED_LIBS): ${n}`);
    }
  }
  return n;
}
