import { describeError } from '../pool.js';
import { audit } from '../audit.js';

/** Risultato di un tool MCP (solo testo). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** richiesto dalla firma del SDK (CallToolResult ha index signature) */
  [x: string]: unknown;
}

export function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

/** Serializza un valore come JSON leggibile. */
export function json(value: unknown): ToolResult {
  return text(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export function error(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

/** Avvolge un handler tool con gestione errori uniforme e audit. */
export function tool<A>(name: string, fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    const t0 = Date.now();
    try {
      const res = await fn(args);
      audit({ tool: name, args, ms: Date.now() - t0, ok: !res.isError });
      return res;
    } catch (err) {
      const res = error(err);
      audit({ tool: name, args, ms: Date.now() - t0, ok: false, error: res.content[0].text.split('\n')[0].slice(0, 300) });
      return res;
    }
  };
}

/** Tronca un testo oltre maxChars aggiungendo una nota. */
export function capText(s: string, maxChars: number, what = 'testo'): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n...[${what} troncato: ${s.length - maxChars} caratteri omessi; aumenta il limite o riduci l'intervallo]`;
}

/** Converte un pattern LIKE SQL in RegExp JS. */
export function likeRegex(pattern: string, defaultValue = '%'): RegExp {
  const p = (pattern || defaultValue).trim().toUpperCase();
  let re = '';
  for (const ch of p) {
    if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 's');
}

/** Cerca una chiave in una riga ignorando maiuscole/minuscole (risultati JDBC cambiano casing). */
export function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  const upper: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) upper[k.toUpperCase()] = v;
  for (const k of keys) if (upper[k] !== undefined) return upper[k];
  return undefined;
}

/** Formatta righe con numeri progressivi (utile per citare righe in chat). */
export function numberLines(lines: string[], first = 1): string {
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(width, ' ')}| ${l}`).join('\n');
}
