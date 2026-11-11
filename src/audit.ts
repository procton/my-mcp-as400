import { appendFileSync } from 'node:fs';
import { getConfig } from './config.js';

const MAX_FIELD = 500;

/** Riduce gli argomenti a una forma loggabile: stringhe troncate, parametri SQL omessi. */
function sanitize(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k === 'parametri') out[k] = Array.isArray(v) ? `[${v.length} parametri omessi]` : '[omessi]';
    else if (typeof v === 'string') out[k] = v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + '…' : v;
    else out[k] = v;
  }
  return out;
}

export interface AuditEntry {
  tool: string;
  args: unknown;
  ms: number;
  ok: boolean;
  error?: string;
}

/** Scrive una riga JSON di audit su stderr e, se configurato, su AUDIT_LOG. Non lancia mai. */
export function audit(e: AuditEntry): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e, args: sanitize(e.args) });
    console.error(`my-mcp-as400 audit ${line}`);
    const file = getConfig().auditLog;
    if (file) appendFileSync(file, line + '\n', { mode: 0o600 });
  } catch { /* l'audit non deve mai rompere un tool */ }
}
