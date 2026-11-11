import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

process.env.AS400_HOST ??= 'test';
process.env.AS400_USER ??= 'test';
process.env.AS400_PASSWORD ??= 'test';

const i18n = await import('../src/i18n.js');
const { setLocale, t, parseLocale, localizeKeys, localizeKey, KEYS_EN, PARAM_EN, paramName, internalParamName, placeholders } = i18n;
const { TOOLS, buildInputShape, toInternalArgs, registerTools } = await import('../src/toolspecs.js');
const { PROMPTS, registerPrompts } = await import('../src/prompts.js');
const { registerResources } = await import('../src/resources.js');

setLocale('EN');

/* ---------- lettura dei sorgenti per i controlli statici ---------- */

function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
}

/** Tutte le coppie `it: '…', en: '…'` presenti nei sorgenti. */
function extractPairs(): Array<{ file: string; it: string; en: string }> {
  const re = /\bit:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*en:\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/gs;
  const out: Array<{ file: string; it: string; en: string }> = [];
  for (const f of sourceFiles()) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(re)) out.push({ file: f, it: m[2], en: m[4] });
  }
  return out;
}

/** Testo senza segnaposto: i nomi dei parametri ({membro}) sono identificativi, non lingua. */
const plain = (s: string): string => s.replace(/\{\w+\}/g, '');

/** Parole italiane che non devono comparire in un testo inglese (indicano una traduzione dimenticata). */
const ITALIAN_WORDS = /(?<![-\w])(non|della|dello|delle|degli|nel|nella|sono|viene|quando|oppure|questo|questa|nessun|nessuna|più|alla|agli|dalla|sulla|anche|invece|ogni|deve|devono|può|usa|indica|libreria|membro|trovato|trovati|troncato|restringi|aumenta|verifica|imposta)(?![-\w])/i;

/* ---------- LOCALE ---------- */

test('parseLocale: default EN, IT/EN senza distinzione di maiuscole, valori non validi rifiutati', () => {
  assert.equal(parseLocale(undefined), 'EN');
  assert.equal(parseLocale(''), 'EN');
  assert.equal(parseLocale('   '), 'EN');
  assert.equal(parseLocale('IT'), 'IT');
  assert.equal(parseLocale('it'), 'IT');
  assert.equal(parseLocale(' en '), 'EN');
  assert.throws(() => parseLocale('FR'), /Invalid LOCALE 'FR'.*Valore LOCALE non valido 'FR'/s);
  assert.throws(() => parseLocale('it-IT'));
});

test('t: scelta della lingua e segnaposto', () => {
  const m = { it: 'File {f} non trovato in {l}', en: 'File {f} not found in {l}' };
  assert.equal(t(m, { f: 'A', l: 'B' }), 'File A not found in B');
  setLocale('IT');
  try {
    assert.equal(t(m, { f: 'A', l: 'B' }), 'File A non trovato in B');
    assert.equal(t(m, { f: 'A' }), 'File A non trovato in {l}', 'un segnaposto senza valore resta com\'è');
  } finally {
    setLocale('EN');
  }
});

/* ---------- chiavi dei risultati ---------- */

test('localizeKeys: traduce ricorsivamente, rispetta i dati opachi, gli alias maiuscoli e i rename', () => {
  const value = { libreria: 'L', elenco: [{ nome: 'A', tipo: 'x', CAMPO: 'c', NULL_ABLE: 'N' }], dati: [{ libreria: 'dato utente', CAMPO: 'x' }], righe: 3 };
  const en = localizeKeys(value, { opaque: ['dati'], rename: { righe: 'rows' } }) as Record<string, unknown>;
  assert.deepEqual(en, {
    library: 'L',
    list: [{ name: 'A', type: 'x', FIELD: 'c', NULLABLE: 'N' }],
    data: [{ libreria: 'dato utente', CAMPO: 'x' }],
    rows: 3,
  });
  assert.equal(localizeKey('righe'), 'lines');
  assert.equal(localizeKey('file'), 'file', 'chiavi uguali nelle due lingue restano invariate');
  setLocale('IT');
  try {
    assert.equal(localizeKeys(value), value, 'in italiano è un no-op');
  } finally {
    setLocale('EN');
  }
});

test('dizionario delle chiavi: valori inglesi ben formati, senza parole italiane', () => {
  for (const [it, en] of Object.entries(KEYS_EN)) {
    assert.match(en, /^[a-z][a-z0-9_]*$/, `chiave EN malformata per ${it}: ${en}`);
    assert.doesNotMatch(en, ITALIAN_WORDS, `parola italiana nella traduzione di ${it}: ${en}`);
  }
  const values = Object.values(KEYS_EN);
  // due chiavi diverse possono avere la stessa traduzione solo se è voluto (creata/creato, trovate/trovati)
  const dup = values.filter((v, i) => values.indexOf(v) !== i);
  assert.deepEqual([...new Set(dup)].sort(), ['created', 'found']);
});

/** Chiavi di oggetti nei file dei tool: tutte quelle che sembrano italiane devono essere nel dizionario. */
test('copertura: nessuna chiave dei risultati in italiano resta senza traduzione', () => {
  const ITALIAN_STEMS = /^(righ|riga|nom[ei]|tipo|tipi|camp[io]|elenc|libreri|membr|dimension|creat|modific|pagin|utent|propriet|descrizion|stat[oi]$|cod[ae]$|sorgent|chiav|vist[ae]|trovat|scansion|total|nota$|usat|chiamat|vincol|indic|logic|figli|dipend|ordin|univoc|formati|formato|condizion|costant|lunghezz|decimal|posizion|uso$|sistem|conness|contenut|cercat|errore|esempio|dettagl|oggett|ultim|prim[ao]_|livell|giorni|memori|modo$|lingu|limiti|prefissi|profond|programm|quando|evento|abilitat|aggiornabil|intestazion|troncat|tabelle|suggerim|moduli|parole|argoment|attribut|caratter|copie|famiglia|byte_|directory_)/;
  // falsi positivi noti: parole italiane dentro stringhe o commenti, o nomi di parametri/variabili interne
  const IGNORE = new Set(['created', 'logical', 'chiaveDds', 'logico', 'recenti', 'valida', 'valido', 'limite', 'limiti', 'profondita', 'maxMembri', 'maxVoci', 'maxFile', 'maxByteFile', 'numeriRiga', 'daRiga', 'aRiga', 'daPagina', 'aPagina', 'datiUtente']);
  const known = new Set(Object.keys(KEYS_EN));
  const files = [...sourceFiles('src/tools'), 'src/srcanalysis.ts', 'src/ddsparse.ts', 'src/resources.ts'];
  const missing = new Set<string>();
  for (const f of files) {
    let s = readFileSync(f, 'utf8');
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    s = s.replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    for (const m of s.matchAll(/(?<![\w.$?])([a-z][a-zA-Z0-9_]*)\s*:(?!:)/g)) {
      const k = m[1];
      if (!known.has(k) && !IGNORE.has(k) && !(k in PARAM_EN) && ITALIAN_STEMS.test(k)) missing.add(`${k} (${path.basename(f)})`);
    }
  }
  assert.deepEqual([...missing], [], 'aggiungere queste chiavi a KEYS_EN in src/i18n.ts');
});

/* ---------- messaggi bilingui ---------- */

test('ogni messaggio { it, en } ha gli stessi segnaposto nelle due lingue', () => {
  const pairs = extractPairs();
  assert.ok(pairs.length > 150, `trovate solo ${pairs.length} coppie: l'estrazione potrebbe essere rotta`);
  for (const { file, it, en } of pairs) {
    assert.deepEqual(placeholders(it), placeholders(en), `segnaposto diversi in ${file}: «${it.slice(0, 60)}»`);
  }
});

test('nessun testo inglese contiene parole italiane (traduzione dimenticata)', () => {
  for (const { file, it, en } of extractPairs()) {
    // «non» compare in «non-unique»/«non-parameterized», già escluso dalla regex; gli identificativi tecnici non contano
    assert.doesNotMatch(plain(en), ITALIAN_WORDS, `parola italiana in un testo EN (${file}): «${en.slice(0, 80)}»`);
    assert.notEqual(it.trim(), '', `testo IT vuoto in ${file}`);
    assert.notEqual(en.trim(), '', `testo EN vuoto in ${file}`);
  }
});

/* ---------- nomi dei parametri ---------- */

test('nomi dei parametri: biunivoci e senza collisioni dentro un tool', () => {
  for (const [it, en] of Object.entries(PARAM_EN)) {
    assert.match(en, /^[a-zA-Z][a-zA-Z0-9]*$/, `nome EN malformato per ${it}`);
    assert.doesNotMatch(en, ITALIAN_WORDS);
    assert.equal(internalParamName(en), it, `mappa inversa errata per ${en}`);
  }
  for (const loc of ['EN', 'IT'] as const) {
    setLocale(loc);
    try {
      for (const spec of TOOLS) {
        const shown = Object.keys(spec.params).map((k) => paramName(k));
        assert.equal(new Set(shown).size, shown.length, `${spec.name}: parametri con lo stesso nome in ${loc}`);
      }
    } finally {
      setLocale('EN');
    }
  }
});

/* ---------- definizione dei tool ---------- */

test('27 tool, nomi unici e sempre inglesi, con titolo e descrizione in entrambe le lingue', () => {
  assert.equal(TOOLS.length, 27);
  assert.equal(new Set(TOOLS.map((s) => s.name)).size, 27);
  for (const s of TOOLS) {
    assert.match(s.name, /^as400_[a-z_]+$/);
    for (const m of [s.title, s.description, ...Object.values(s.params).map((p) => p.desc)]) {
      assert.deepEqual(placeholders(m.it), placeholders(m.en), `${s.name}: segnaposto diversi`);
      assert.doesNotMatch(plain(m.en), ITALIAN_WORDS, `${s.name}: italiano in un testo EN «${m.en.slice(0, 70)}»`);
    }
  }
});

test('lo schema esposto usa i nomi della lingua scelta e le descrizioni non hanno segnaposto irrisolti', () => {
  const byName = (n: string) => TOOLS.find((s) => s.name === n)!;
  const en = Object.keys(buildInputShape(byName('as400_source_read')));
  assert.deepEqual(en, ['library', 'file', 'member', 'lineNumbers', 'fromLine', 'toLine']);
  setLocale('IT');
  try {
    assert.deepEqual(Object.keys(buildInputShape(byName('as400_source_read'))), ['libreria', 'file', 'membro', 'numeriRiga', 'daRiga', 'aRiga']);
  } finally {
    setLocale('EN');
  }
  for (const loc of ['EN', 'IT'] as const) {
    setLocale(loc);
    try {
      for (const s of TOOLS) {
        for (const [k, schema] of Object.entries(buildInputShape(s))) {
          const d = schema.description ?? '';
          assert.ok(d.length > 0, `${s.name}.${k}: descrizione mancante (${loc})`);
          assert.doesNotMatch(d, /\{[a-zA-Z]+\}/, `${s.name}.${k}: segnaposto irrisolto (${loc})`);
        }
      }
    } finally {
      setLocale('EN');
    }
  }
});

test('toInternalArgs: nomi e valori enumerati tornano ai nomi interni', () => {
  const spec = TOOLS.find((s) => s.name === 'as400_table_list')!;
  assert.deepEqual(
    toInternalArgs(spec, { library: 'MYLIB', type: 'physical', filter: 'AB%', text: 'cust', limit: 5 }),
    { libreria: 'MYLIB', tipo: 'fisici', filtro: 'AB%', testo: 'cust', limite: 5 },
  );
  const routine = TOOLS.find((s) => s.name === 'as400_routine_list')!;
  assert.deepEqual(toInternalArgs(routine, { library: 'L', type: 'functions' }), { libreria: 'L', tipo: 'funzioni' });
  assert.deepEqual(toInternalArgs(routine, { library: 'L', type: 'all' }), { libreria: 'L', tipo: 'tutte' });
  const ifs = TOOLS.find((s) => s.name === 'as400_ifs_list')!;
  assert.deepEqual(toInternalArgs(ifs, { path: '/x', depth: 2, maxEntries: 9, type: 'all' }), { percorso: '/x', profondita: 2, maxVoci: 9, tipo: 'tutti' });
  setLocale('IT');
  try {
    assert.deepEqual(toInternalArgs(spec, { libreria: 'L', tipo: 'fisici' }), { libreria: 'L', tipo: 'fisici' });
  } finally {
    setLocale('EN');
  }
});

test('i valori enumerati hanno la stessa cardinalità nelle due lingue e nessun duplicato', () => {
  for (const s of TOOLS) {
    for (const [k, p] of Object.entries(s.params)) {
      if (!p.values) continue;
      assert.equal(new Set(p.values.map((v) => v.it)).size, p.values.length, `${s.name}.${k}: valori IT duplicati`);
      assert.equal(new Set(p.values.map((v) => v.en)).size, p.values.length, `${s.name}.${k}: valori EN duplicati`);
    }
  }
});

/* ---------- registrazione completa (server finto) ---------- */

interface Captured {
  tools: Array<{ name: string; config: { title?: string; description?: string; inputSchema: Record<string, unknown> } }>;
  prompts: Array<{ name: string; config: { title?: string; argsSchema: Record<string, unknown> } }>;
  resources: Array<{ name: string; uri: string }>;
}

function captureRegistration(): Captured {
  const cap: Captured = { tools: [], prompts: [], resources: [] };
  const fake = {
    registerTool: (name: string, config: never) => { cap.tools.push({ name, config }); },
    registerPrompt: (name: string, config: never) => { cap.prompts.push({ name, config }); },
    registerResource: (name: string, uriOrTemplate: unknown) => {
      const uri = typeof uriOrTemplate === 'string' ? uriOrTemplate : String((uriOrTemplate as { uriTemplate: { toString(): string } }).uriTemplate);
      cap.resources.push({ name, uri });
    },
  };
  registerTools(fake as never);
  registerPrompts(fake as never);
  registerResources(fake as never);
  return cap;
}

test('registrazione in EN: tool, prompt e risorse con nomi inglesi', () => {
  setLocale('EN');
  const c = captureRegistration();
  assert.equal(c.tools.length, 27);
  assert.deepEqual(c.prompts.map((p) => p.name), ['explain_program', 'document_library', 'analyze_file', 'find_usages', 'analyze_spool', 'query_data', 'explain_print_file']);
  assert.deepEqual(c.prompts[0].config.argsSchema && Object.keys(c.prompts[0].config.argsSchema), ['library', 'file', 'member']);
  assert.ok(c.resources.some((r) => r.uri === 'as400://system'));
  assert.ok(!c.resources.some((r) => r.uri === 'as400://sistema'));
  const sql = c.tools.find((x) => x.name === 'as400_sql_query')!;
  assert.deepEqual(Object.keys(sql.config.inputSchema), ['query', 'parameters']);
  assert.match(sql.config.description ?? '', /Runs a SELECT/);
});

test('registrazione in IT: tool invariati nei nomi, prompt e risorse in italiano', () => {
  setLocale('IT');
  try {
    const c = captureRegistration();
    assert.equal(c.tools.length, 27);
    assert.deepEqual(c.prompts.map((p) => p.name), ['spiega_programma', 'documenta_libreria', 'analizza_file', 'dove_e_usato', 'analizza_spool', 'interroga_dati', 'spiega_stampa']);
    assert.ok(c.resources.some((r) => r.uri === 'as400://sistema'));
    const sql = c.tools.find((x) => x.name === 'as400_sql_query')!;
    assert.deepEqual(Object.keys(sql.config.inputSchema), ['query', 'parametri']);
    assert.match(sql.config.description ?? '', /Esegue una SELECT/);
  } finally {
    setLocale('EN');
  }
});

test('i nomi dei tool sono gli stessi nelle due lingue', () => {
  const names = (loc: 'EN' | 'IT'): string[] => {
    setLocale(loc);
    try { return captureRegistration().tools.map((x) => x.name); } finally { setLocale('EN'); }
  };
  assert.deepEqual(names('EN'), names('IT'));
});

test('PROMPTS: nomi unici e argomenti presenti nelle due lingue', () => {
  assert.equal(PROMPTS.length, 7);
  for (const loc of ['EN', 'IT'] as const) {
    setLocale(loc);
    try {
      const names = PROMPTS.map((p) => t(p.name));
      assert.equal(new Set(names).size, 7);
      for (const p of PROMPTS) {
        for (const m of [p.title, p.description]) assert.notEqual(t(m).trim(), '');
        assert.ok(Object.keys(p.args()).length >= 1);
      }
    } finally {
      setLocale('EN');
    }
  }
});

/* ---------- documentazione coerente con il codice ---------- */

const README_EN = readFileSync('README.md', 'utf8');
const README_IT = readFileSync('README.it.md', 'utf8');
const ENV_EXAMPLE = readFileSync('.env.example', 'utf8');

test('i README documentano tutti i tool e tutti i prompt, in entrambe le lingue', () => {
  for (const [label, doc] of [['README.md', README_EN], ['README.it.md', README_IT]] as const) {
    for (const s of TOOLS) assert.ok(doc.includes(`\`${s.name}\``), `${label}: manca il tool ${s.name}`);
    for (const pr of PROMPTS) {
      for (const loc of ['EN', 'IT'] as const) {
        setLocale(loc);
        try {
          assert.ok(doc.includes(`\`${t(pr.name)}\``), `${label}: manca il prompt ${t(pr.name)} (${loc})`);
        } finally {
          setLocale('EN');
        }
      }
    }
  }
});

test('i README hanno la tabella di corrispondenza di tutti i nomi dei parametri', () => {
  for (const [it, en] of Object.entries(PARAM_EN)) {
    assert.ok(README_EN.includes(`| \`${en}\` | \`${it}\` |`), `README.md: manca la riga ${en} ↔ ${it}`);
    assert.ok(README_IT.includes(`| \`${it}\` | \`${en}\` |`), `README.it.md: manca la riga ${it} ↔ ${en}`);
  }
});

test('LOCALE è documentata nei README e in .env.example', () => {
  assert.match(README_EN, /`LOCALE` \(`EN` or `IT`, default `EN`\)/);
  assert.match(README_IT, /`LOCALE` \(`EN` o `IT`, default `EN`\)/);
  assert.match(README_EN, /\[Language\]\(#language-locale\)/);
  assert.match(README_IT, /\[Lingua\]\(#lingua-locale\)/);
  assert.match(ENV_EXAMPLE, /^LOCALE=EN$/m);
});

test('le variabili lette dal codice sono documentate nei README e in .env.example', () => {
  const code = readFileSync('src/config.ts', 'utf8') + readFileSync('src/i18n.ts', 'utf8');
  const used = new Set([
    ...[...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/(?:int|required)\('([A-Z0-9_]+)'/g)].map((m) => m[1]),
  ]);
  const secret = new Set(['AS400_HOST', 'AS400_USER', 'AS400_PASSWORD']);
  for (const v of used) {
    assert.ok(README_EN.includes(`\`${v}\``) || secret.has(v) , `README.md: variabile non documentata ${v}`);
    assert.ok(README_IT.includes(`\`${v}\``) || secret.has(v), `README.it.md: variabile non documentata ${v}`);
    assert.ok(new RegExp(`^${v}=`, 'm').test(ENV_EXAMPLE), `.env.example: manca ${v}`);
  }
});
