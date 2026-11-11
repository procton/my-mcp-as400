import * as jt400ns from 'node-jt400';
import { getConfig, parseJdbcExtra, type Config } from './config.js';

/* node-jt400 è un pacchetto dual-mode: gestisce sia l'esport di default di CommonJS
 * che l'esport nominale `pool` dell'edizione ESM. */
const ns = jt400ns as unknown as Record<string, unknown>;
const createPool: (cfg: Record<string, unknown>) => any =
  ((ns as { pool?: unknown }).pool as any) ?? (ns as { default?: { pool?: unknown } }).default?.pool;

let poolInstance: any = null;
let aliasPoolInstance: any = null;

function baseProps(cfg: Config): Record<string, unknown> {
  return {
    host: cfg.host,
    user: cfg.user,
    password: cfg.password,
    // leggibilità dei tipi binari e conversione EBCDIC corretta via JDBC
    'translate binary': 'true',
    // backstop di rete oltre al timeout applicativo
    'socket timeout': String(cfg.sqlTimeoutMs + 15000),
    ...parseJdbcExtra(cfg.jdbcExtra),
  };
}

/** Pool principale: connessione JDBC `access=read only` (il server rifiuta ogni scrittura). */
export function getPool(): any {
  if (poolInstance) return poolInstance;
  poolInstance = createPool({ ...baseProps(getConfig()), access: 'read only' });
  return poolInstance;
}

/** Pool dedicato SOLO a source_read: serve CREATE ALIAS in QTEMP (non permesso in read-only).
 * Esegue esclusivamente istruzioni fisse costruite dal codice con nomi validati. */
export function getAliasPool(): any {
  if (aliasPoolInstance) return aliasPoolInstance;
  aliasPoolInstance = createPool(baseProps(getConfig()));
  return aliasPoolInstance;
}

/** Rifiuta se la promessa non termina entro il timeout configurato. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`Timeout (${ms} ms) su ${what}: operazione abbandonata`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export function sqlText(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const ms = getConfig().sqlTimeoutMs;
  return withTimeout(getPool().query(sql, params ?? []), ms, 'query SQL');
}

/** Esegue una query e converte i valori "java" in tipi JSON-safe. */
export async function normalizedQuery(
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const rows = await sqlText(sql, params);
  return rows.map((r) => jsonifyRow(r));
}

export function jsonifyRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = jsonify(v);
  return out;
}

export function jsonify(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return v;
  if (t === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(jsonify);
  // wrapper CLOB/BLOB di node-jt400: {'type':'CLOB','value':'...'} → il valore puro
  if (isClobLike(v)) return (v as { value: unknown }).value;
  // Oggetti provenienti da node-java (java.sql.Timestamp, BigDecimal, ...):
  // non sono oggetti JS "normali": li rappresentiamo con il loro toString().
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = jsonify(x);
    return out;
  }
  try {
    return String(v);
  } catch {
    return JSON.stringify(v);
  }
}

function isPlainObject(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Riconosce il wrapper CLOB/BLOB usato da node-jt400 per gli oggetti grandi. */
function isClobLike(v: unknown): v is { type: string; value: unknown } {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'CLOB' || t === 'BLOB';
}

/** Estrae un messaggio leggibile da errori node-jt400 (oops-error) /SQLException. */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  let depth = 0;
  while (e && depth < 5) {
    const anyE = e as { message?: string; cause?: unknown; category?: string; msg?: string };
    const m = anyE.message ?? anyE.msg;
    if (m && !parts.includes(String(m))) parts.push(String(m));
    e = anyE.cause;
    depth++;
  }
  return parts.join(' <- ') || String(err);
}

/** Parametri per clausole LIKE. */
export function likeP(value: string | undefined | null, defaultValue = '%'): string {
  if (!value) return defaultValue;
  return value.trim().toUpperCase();
}

/** Nome del sistema IBM i connesso (CURRENT_SERVER), memoizzato. */
/** Chiude il pool JDBC (shutdown pulito). */
export async function closePool(): Promise<void> {
  for (const p of [poolInstance, aliasPoolInstance]) {
    if (!p) continue;
    try {
      await p.close();
    } catch { /* ignora */ }
  }
  poolInstance = null;
  aliasPoolInstance = null;
}

let sysNameCache: string | null = null;
export async function sysName(): Promise<string> {
  if (sysNameCache) return sysNameCache;
  const rows = await normalizedQuery(`SELECT CURRENT_SERVER AS SYS FROM SYSIBM.SYSDUMMY1`);
  sysNameCache = String((rows[0] as Record<string, unknown>)?.SYS ?? '');
  return sysNameCache;
}
