/* Internazionalizzazione del server (IT / EN).
 *
 * LOCALE nel .env: IT oppure EN; se manca o è vuoto vale EN.
 *
 * Tre livelli, tutti decisi una volta sola all'avvio:
 *  1. testi (messaggi, note, descrizioni dei tool, prompt): t({ it, en }, params)
 *  2. nomi dei parametri dei tool e valori enumerati: dichiarati nella lingua scelta e riportati ai nomi
 *     interni (italiani) prima di chiamare la logica del tool (vedi toolspecs.ts)
 *  3. chiavi dei risultati JSON: la logica produce chiavi italiane, tradotte in uscita (localizeKeys)
 *
 * I nomi interni restano italiani per non toccare la logica dei tool; in inglese cambia solo ciò che l'utente vede. */
import './env.js';

export type Locale = 'IT' | 'EN';

/** Testo bilingue; i segnaposto {nome} devono essere gli stessi nelle due lingue (verificato dai test). */
export interface Msg {
  it: string;
  en: string;
}

export function parseLocale(raw: string | undefined): Locale {
  const v = raw?.trim();
  if (!v) return 'EN';
  const u = v.toUpperCase();
  if (u === 'IT' || u === 'EN') return u;
  throw new Error(
    `Invalid LOCALE '${v}': allowed values are IT or EN (default EN) / Valore LOCALE non valido '${v}': ammessi IT o EN (default EN)`,
  );
}

let current: Locale | null = null;

export function getLocale(): Locale {
  if (!current) current = parseLocale(process.env.LOCALE);
  return current;
}

/** Solo per i test: forza la lingua. */
export function setLocale(l: Locale | null): void {
  current = l;
}

export type Params = Record<string, string | number | undefined>;

export function t(m: Msg, params?: Params): string {
  const s = getLocale() === 'IT' ? m.it : m.en;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (all, k: string) => (params[k] === undefined ? all : String(params[k])));
}

/** Segnaposto {nome} di un testo (per i test di coerenza fra le lingue). */
export function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/* ---------------- nomi dei parametri ---------------- */

/** Nome interno (italiano) → nome in inglese. I nomi non elencati sono uguali nelle due lingue. */
export const PARAM_EN: Record<string, string> = {
  libreria: 'library',
  membro: 'member',
  filtro: 'filter',
  percorso: 'path',
  numeriRiga: 'lineNumbers',
  daRiga: 'fromLine',
  aRiga: 'toLine',
  testo: 'text',
  tipo: 'type',
  limite: 'limit',
  maxMembri: 'maxMembers',
  maiuscole: 'caseSensitive',
  parametri: 'parameters',
  campo: 'field',
  utente: 'user',
  numero: 'number',
  daPagina: 'fromPage',
  aPagina: 'toPage',
  pulisci: 'clean',
  stato: 'status',
  datiUtente: 'userData',
  dal: 'from',
  al: 'to',
  oggetto: 'object',
  attributo: 'attribute',
  profondita: 'depth',
  maxVoci: 'maxEntries',
  lunghezza: 'length',
  maxFile: 'maxFiles',
  maxByteFile: 'maxFileBytes',
  domanda: 'question',
  nome: 'name',
  data: 'date',
};

const PARAM_IT_FROM_EN: Record<string, string> = Object.fromEntries(Object.entries(PARAM_EN).map(([it, en]) => [en, it]));

/** Nome di un parametro nella lingua corrente, dato il nome interno. */
export function paramName(internal: string): string {
  return getLocale() === 'EN' ? (PARAM_EN[internal] ?? internal) : internal;
}

/** Nome interno di un parametro, dato il nome nella lingua corrente. */
export function internalParamName(shown: string): string {
  return getLocale() === 'EN' ? (PARAM_IT_FROM_EN[shown] ?? shown) : shown;
}

/* ---------------- chiavi dei risultati ---------------- */

/** Chiave interna (italiana) → chiave in inglese nei risultati JSON. Le chiavi non elencate restano invariate
 * (nomi uguali nelle due lingue: file, job, host, offset, cpu, ccsid, server, trigger, join, ...).
 * Una chiave TUTTA MAIUSCOLA (alias SQL, es. CAMPO) si traduce come la sua versione minuscola, in maiuscolo. */
export const KEYS_EN: Record<string, string> = {
  abilitato: 'enabled',
  aggiornabile: 'updatable',
  argomenti: 'arguments',
  attributi: 'attributes',
  attributo: 'attribute',
  byte_mostrati: 'bytes_shown',
  campi: 'fields',
  campo: 'field',
  caratteri: 'characters',
  cercato: 'searched',
  chiave: 'key',
  chiave_dds: 'dds_key',
  chiave_del_file: 'file_key',
  chiavi: 'keys',
  code: 'queues',
  coda: 'queue',
  comandi_cl: 'cl_commands',
  condizione: 'condition',
  condizioni: 'conditions',
  connessione: 'connection',
  contenuto: 'content',
  copie: 'copies',
  costanti: 'constants',
  creata: 'created',
  creato: 'created',
  creato_su_release: 'created_on_release',
  da_riferimento: 'from_reference',
  dati: 'data',
  dati_utente: 'user_data',
  decimali: 'decimals',
  definizione: 'definition',
  descrizione: 'description',
  dettagli_oggetti: 'object_details',
  dettaglio: 'detail',
  dimensione: 'size',
  directory_visitate: 'directories_visited',
  elenco: 'list',
  errore: 'error',
  esempio: 'example',
  evento: 'event',
  famiglia: 'family',
  figlio: 'child',
  file_scansionati: 'files_scanned',
  file_sorgente: 'source_files',
  file_spool: 'spool_files',
  file_usati: 'files_used',
  formati: 'formats',
  formati_record: 'record_formats',
  formato: 'format',
  giorni_uso: 'days_used',
  ifs_max_righe: 'ifs_max_lines',
  intestazione: 'heading',
  libreria: 'library',
  librerie: 'libraries',
  librerie_consentite: 'allowed_libraries',
  limiti_attivi: 'active_limits',
  linguaggio: 'language',
  livello: 'level',
  logici_indici_e_viste: 'logicals_indexes_and_views',
  logici_indici_e_viste_che_lo_usano: 'logicals_indexes_and_views_using_it',
  lunghezza: 'length',
  lunghezza_record: 'record_length',
  membri: 'members',
  membri_scansionati: 'members_scanned',
  membro: 'member',
  memoria_mb: 'memory_mb',
  modificato: 'modified',
  modo: 'mode',
  modulo: 'module',
  moduli_collegati: 'bound_modules',
  null_able: 'nullable',
  nome: 'name',
  nome_sistema: 'system_name',
  nome_sql: 'sql_name',
  nota: 'note',
  numero: 'number',
  oggetti: 'objects',
  oggetto: 'object',
  oggetto_creato: 'object_created',
  ora: 'time',
  ordine: 'order',
  pagine: 'pages',
  pagine_lette: 'pages_read',
  pagine_nel_testo: 'pages_in_text',
  pagine_restituite: 'pages_returned',
  parametri_in: 'in_parameters',
  parametri_out: 'out_parameters',
  parole_chiave: 'keywords',
  parole_chiave_file: 'file_keywords',
  percorso: 'path',
  posizione: 'position',
  prefissi_ifs_consentiti: 'allowed_ifs_prefixes',
  prima_riga: 'first_line',
  procedure: 'procedures',
  profondita: 'depth',
  programma: 'program',
  programmi_chiamati: 'called_programs',
  proprietario: 'owner',
  quando: 'timing',
  riferisce: 'references',
  riga: 'line',
  riga_sorgente: 'source_line',
  righe: 'lines',
  righe_sorgente: 'source_lines',
  righe_totali: 'total_lines',
  risultati: 'results',
  routine: 'routines',
  service_program_collegati: 'bound_service_programs',
  sistema: 'system',
  sistema_operativo: 'operating_system',
  sorgente: 'source',
  sorgente_dai_moduli: 'source_from_modules',
  sorgente_modificato: 'source_modified',
  source_max_righe: 'source_max_lines',
  spool_max_file: 'spool_max_files',
  sql_max_righe: 'sql_max_rows',
  stampante: 'printer',
  stato: 'status',
  suggerimento: 'hint',
  tabelle_figlie_foreign_key: 'child_tables_foreign_key',
  tabelle_sql: 'sql_tables',
  testo: 'text',
  tipi: 'types',
  tipo: 'type',
  tipo_file: 'file_type',
  tipo_sorgente: 'source_type',
  troncato: 'truncated',
  trovate: 'found',
  trovati: 'found',
  ultima_riga: 'last_line',
  ultimo_uso: 'last_used',
  univoco: 'unique',
  uso: 'usage',
  utente: 'user',
  versione: 'version',
  vincolo: 'constraint',
  vincoli: 'constraints',
  vincoli_chiave: 'key_constraints',
  vista: 'view',
  voci_dirette: 'direct_entries',
};

export interface LocalizeOptions {
  /** chiavi il cui contenuto è dato dell'utente (righe di tabelle): si traduce il nome della chiave, non il contenuto */
  opaque?: string[];
  /** sostituzioni puntuali che hanno la precedenza sul dizionario (es. { righe: 'rows' } dove "righe" è un conteggio) */
  rename?: Record<string, string>;
}

/** Traduzione di una singola chiave. */
export function localizeKey(k: string, rename?: Record<string, string>): string {
  if (rename && rename[k] !== undefined) return rename[k];
  if (KEYS_EN[k] !== undefined) return KEYS_EN[k];
  // alias SQL in maiuscolo (CAMPO, TIPO, ...)
  if (k.length > 1 && k === k.toUpperCase()) {
    const lower = k.toLowerCase();
    if (KEYS_EN[lower] !== undefined) return KEYS_EN[lower].toUpperCase();
  }
  return k;
}

/** Nome, nella lingua scelta, di una chiave dei risultati (per citarla nei testi dei prompt). */
export function keyName(internal: string): string {
  return getLocale() === 'EN' ? localizeKey(internal) : internal;
}

/** Traduce ricorsivamente le chiavi di un risultato (no-op in italiano). */
export function localizeKeys(value: unknown, opts: LocalizeOptions = {}): unknown {
  if (getLocale() === 'IT') return value;
  const opaque = new Set(opts.opaque ?? []);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[localizeKey(k, opts.rename)] = opaque.has(k) ? x : walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
