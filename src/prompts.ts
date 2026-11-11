import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';
import { internalParamName, keyName, paramName, t, type Msg } from './i18n.js';
import { completeLibrary, completeSourceFile, completeMember, completeFile } from './resources.js';

/* Testi dei prompt: funzioni pure (dipendono solo dalla lingua scelta), così sono testabili.
 * Ognuno indica al modello quali tool usare e in che ordine. I nomi dei parametri e delle chiavi dei risultati
 * citati nel testo sono quelli della lingua scelta ({da}, {testo}, ...). */

/** Nomi dei parametri e delle chiavi citati nei testi. */
function names(): Record<string, string> {
  return {
    da: paramName('daRiga'), a: paramName('aRiga'), daPagina: paramName('daPagina'), aPagina: paramName('aPagina'),
    filtro: paramName('filtro'), tipo: paramName('tipo'), testo: paramName('testo'), campo: paramName('campo'),
    oggetto: paramName('oggetto'), file: paramName('file'), membro: paramName('membro'),
    parametri: paramName('parametri'), utente: paramName('utente'), dal: paramName('dal'), al: paramName('al'),
    troncato: keyName('troncato'), nota: keyName('nota'),
  };
}

export function promptSpiegaProgramma(lib: string, file: string, membro: string): string {
  return t({
    it: `Spiega il programma {lib}/{file}({membro}) di un sistema IBM i.

Procedi così:
1. Usa as400_source_read per leggere il sorgente (se è lungo, leggilo a blocchi con {da}/{a}).
2. Usa as400_source_refs sullo stesso membro per avere file usati (con modo di accesso), programmi chiamati, /COPY, data area, tabelle SQL e comandi CL.
3. Per ogni file usato rilevante usa as400_file_desc (campi e chiave) per capire i dati trattati.
4. Se il programma è compilato, as400_object_describe (tipo *PGM) mostra moduli e service program collegati.

Poi scrivi, in italiano:
- scopo del programma in 2-3 frasi;
- parametri di ingresso e uscita (PLIST / DCL-PI / PARM);
- flusso principale passo per passo, citando i numeri di riga;
- file letti e scritti, programmi chiamati;
- anomalie, codice morto, rischi (chiavi non univoche, gestione errori assente, SQL non parametrizzato).
Non inventare: se un'informazione non è nel sorgente o nei tool, dichiaralo.`,
    en: `Explain the program {lib}/{file}({membro}) of an IBM i system.

Proceed as follows:
1. Use as400_source_read to read the source (if it is long, read it in blocks with {da}/{a}).
2. Use as400_source_refs on the same member to get the files used (with access mode), called programs, /COPY, data areas, SQL tables and CL commands.
3. For each relevant file used, use as400_file_desc (fields and key) to understand the data handled.
4. If the program is compiled, as400_object_describe (type *PGM) shows the bound modules and service programs.

Then write, in English:
- the purpose of the program in 2-3 sentences;
- input and output parameters (PLIST / DCL-PI / PARM);
- the main flow step by step, citing line numbers;
- files read and written, programs called;
- anomalies, dead code, risks (non-unique keys, missing error handling, non-parameterized SQL).
Do not make things up: if a piece of information is not in the source or in the tools, say so.`,
  }, { ...names(), lib, file, membro });
}

export function promptDocumentaLibreria(lib: string, filtro?: string): string {
  const limit = filtro
    ? t({ it: ' limitandoti agli oggetti che iniziano con "{prefix}"', en: ' limiting yourself to the objects whose names start with "{prefix}"' }, { prefix: filtro })
    : '';
  const withFilter = filtro ? t({ it: ' ({filtro} "{prefix}%")', en: ' ({filtro} "{prefix}%")' }, { prefix: filtro, ...names() }) : '';
  return t({
    it: `Produci la documentazione della libreria {lib} di un sistema IBM i{limit}.

Procedi così:
1. as400_schema_list ({filtro} {lib}) per descrizione e proprietario della libreria.
2. as400_object_list con {tipo} "*PGM *SRVPGM *CMD *DTAARA *DTAQ" per i programmi e gli oggetti eseguibili{withFilter}.
3. as400_table_list per i file (fisici, logici, viste) e as400_source_list per i file sorgente.
4. Per i file più importanti (per descrizione o dimensione) usa as400_file_desc e as400_index_list.
5. Per i programmi principali usa as400_source_refs per capire chi chiama chi.
Gli elenchi sono limitati: se compare una nota di troncamento, restringi con i filtri invece di ignorarla.

Restituisci un documento Markdown in italiano con: panoramica, tabella dei programmi (nome, linguaggio, descrizione, sorgente), tabella dei file (nome, tipo, descrizione, chiave), mappa delle dipendenze principali e le aree poco documentate (oggetti senza descrizione).`,
    en: `Produce the documentation of library {lib} of an IBM i system{limit}.

Proceed as follows:
1. as400_schema_list ({filtro} {lib}) for the description and owner of the library.
2. as400_object_list with {tipo} "*PGM *SRVPGM *CMD *DTAARA *DTAQ" for the programs and executable objects{withFilter}.
3. as400_table_list for the files (physical, logical, views) and as400_source_list for the source files.
4. For the most important files (by description or size) use as400_file_desc and as400_index_list.
5. For the main programs use as400_source_refs to understand who calls whom.
The lists are limited: if a truncation note appears, narrow down with the filters instead of ignoring it.

Return a Markdown document in English with: overview, table of programs (name, language, description, source), table of files (name, type, description, key), map of the main dependencies and the poorly documented areas (objects without a description).`,
  }, { ...names(), lib, limit, withFilter });
}

export function promptAnalizzaFile(lib: string, file: string): string {
  return t({
    it: `Analizza il file {lib}/{file} di un sistema IBM i.

1. as400_file_desc: tipo, campi, tipi e chiave.
2. as400_index_list: chiave del file e logici/indici/viste che ne dipendono.
3. as400_constraints e as400_where_used: vincoli, foreign key, trigger e oggetti che lo usano.
4. as400_sql_query con "SELECT * FROM {lib}.{file}" per vedere alcuni record di esempio (il limite di righe è già applicato; chiedi al massimo 10 righe e non esporre dati personali nella risposta).
5. as400_source_search nella libreria con il nome del file per trovare i programmi che lo referenziano.

Spiega in italiano: cosa rappresenta il file, significato dei campi non ovvi (usa le descrizioni dei campi del catalogo), come si accede (chiavi e logici), chi lo legge e lo scrive, e cosa fare attenzione modificandolo.`,
    en: `Analyze the file {lib}/{file} of an IBM i system.

1. as400_file_desc: type, fields, types and key.
2. as400_index_list: key of the file and the logicals/indexes/views that depend on it.
3. as400_constraints and as400_where_used: constraints, foreign keys, triggers and the objects that use it.
4. as400_sql_query with "SELECT * FROM {lib}.{file}" to see some sample records (the row limit is already applied; ask for at most 10 rows and do not expose personal data in the answer).
5. as400_source_search in the library with the file name to find the programs that reference it.

Explain in English: what the file represents, the meaning of the non-obvious fields (use the field descriptions from the catalog), how it is accessed (keys and logicals), who reads and writes it, and what to watch out for when changing it.`,
  }, { lib, file });
}

export function promptDoveEUsato(lib: string, nome: string): string {
  return t({
    it: `Trova dove viene usato "{nome}" nella libreria {lib} (può essere un file, un campo, un programma o una data area).

1. as400_column_search ({campo} "{nome}") per sapere se è un campo e in quali file compare.
2. as400_where_used (se è un file) per logici, viste, foreign key e trigger.
3. as400_source_search con {testo} "{nome}" per le righe di sorgente che lo citano; restringi con {file}/{membro} se i risultati sono troppi.
4. as400_object_list ({filtro} "{nome}%") per verificare se esiste come oggetto (programma, comando, data area).
5. Per i membri più rilevanti usa as400_source_refs per classificare l'uso (lettura, scrittura, chiamata).

Restituisci una tabella (membro, riga, tipo di uso: definizione / lettura / scrittura / chiamata) e un riepilogo in italiano dell'impatto di una modifica. Ricorda che l'analisi statica non vede le chiamate dinamiche: segnalalo.`,
    en: `Find where "{nome}" is used in library {lib} (it can be a file, a field, a program or a data area).

1. as400_column_search ({campo} "{nome}") to find out whether it is a field and in which files it appears.
2. as400_where_used (if it is a file) for logicals, views, foreign keys and triggers.
3. as400_source_search with {testo} "{nome}" for the source lines that mention it; narrow down with {file}/{membro} if there are too many results.
4. as400_object_list ({filtro} "{nome}%") to check whether it exists as an object (program, command, data area).
5. For the most relevant members use as400_source_refs to classify the usage (read, write, call).

Return a table (member, line, kind of use: definition / read / write / call) and a summary in English of the impact of a change. Remember that static analysis does not see dynamic calls: point this out.`,
  }, { ...names(), lib, nome });
}

export function promptAnalizzaSpool(utente?: string, file?: string, data?: string): string {
  const filtri = [
    utente && t({ it: 'utente {v}', en: 'user {v}' }, { v: utente }),
    file && t({ it: 'nome {v}', en: 'name {v}' }, { v: file }),
    data && t({ it: 'data {v}', en: 'date {v}' }, { v: data }),
  ].filter(Boolean).join(', ') || t({ it: "i filtri indicati dall'utente", en: 'the filters given by the user' });
  const n = names();
  const q = (label: string, v: string): string => `${label} "${v}"`;
  const parts = [
    utente ? q(n.utente, utente) : t({ it: 'i filtri disponibili', en: 'the available filters' }),
    file ? q(n.file, file) : '',
    data ? q(`${n.dal}/${n.al}`, data) : '',
  ].filter(Boolean).join(', ');
  return t({
    it: `Analizza gli spool IBM i per {filtri}.

1. as400_spool_search con {parts} per individuare i file (sono ordinati dal più recente).
2. as400_spool_info sui file candidati per pagine, tipo dati e job.
3. as400_spool_read per leggere il contenuto (usa {daPagina}/{aPagina} sui file lunghi). Per le joblog (QPJOBLOG) cerca messaggi di errore, gravità alta e il programma che li ha generati.

Riassumi in italiano: cosa contiene ogni spool, eventuali errori con ID messaggio, causa probabile e azione consigliata. Per gli AFPDS ricorda che è estratto solo il testo e l'impaginazione non è riprodotta.`,
    en: `Analyze the IBM i spooled files for {filtri}.

1. as400_spool_search with {parts} to find the files (they are sorted from the most recent).
2. as400_spool_info on the candidate files for pages, data type and job.
3. as400_spool_read to read the content (use {daPagina}/{aPagina} on long files). For joblogs (QPJOBLOG) look for error messages, high severity and the program that generated them.

Summarize in English: what each spooled file contains, any errors with message ID, probable cause and recommended action. For AFPDS remember that only the text is extracted and the page layout is not reproduced.`,
  }, { ...n, filtri, parts });
}

export function promptSpiegaStampa(lib: string, oggetto: string): string {
  return t({
    it: `Spiega la struttura del file di stampa o video {lib}/{oggetto}.

1. as400_dds_describe con {oggettoParam} "{oggetto}" per formati, campi, posizioni (riga/colonna), costanti, indicatori e parole chiave. Controlla la nota: se il sorgente è stato modificato dopo la compilazione, segnalalo.
2. as400_object_describe (tipo *FILE) per descrizione e date.
3. as400_source_search ({testo} "{oggetto}") per i programmi che lo usano e as400_source_refs su quelli principali.
4. Se esistono spool prodotti da questo file (as400_spool_search con {file} "{oggetto}"), leggine uno con as400_spool_read per confrontare il risultato reale con il layout.

Descrivi in italiano il layout (anche come schema testuale a colonne per le stampe), i campi di ingresso/uscita, gli indicatori e i tasti funzione per i video.`,
    en: `Explain the structure of the print or display file {lib}/{oggetto}.

1. as400_dds_describe with {oggettoParam} "{oggetto}" for formats, fields, positions (line/column), constants, indicators and keywords. Check the note: if the source was modified after compilation, point it out.
2. as400_object_describe (type *FILE) for description and dates.
3. as400_source_search ({testo} "{oggetto}") for the programs that use it, and as400_source_refs on the main ones.
4. If spooled files produced by this file exist (as400_spool_search with {file} "{oggetto}"), read one with as400_spool_read to compare the real output with the layout.

Describe in English the layout (also as a column-based text diagram for print files), the input/output fields, the indicators and the function keys for display files.`,
  }, { ...names(), lib, oggetto, oggettoParam: paramName('oggetto') });
}

export function promptInterrogaDati(lib: string, domanda: string, file?: string): string {
  const partenza = file
    ? '\n' + t({
      it: 'File da cui partire: {lib}/{file} (verifica comunque che sia quello giusto).',
      en: 'File to start from: {lib}/{file} (check anyway that it is the right one).',
    }, { lib, file })
    : '';
  return t({
    it: `Rispondi a una domanda sui dati del database di un sistema IBM i.

Domanda: "{domanda}"
Libreria dei dati: {lib}{partenza}

Procedi così:
1. Individua i file giusti: as400_table_list (filtri su nome o testo della descrizione) e, se la domanda cita un concetto o un campo, as400_column_search (per nome o per testo). Le librerie hanno migliaia di file: usa i filtri.
2. Per ogni file candidato usa as400_file_desc: nomi di sistema dei campi, tipo, lunghezza, decimali, descrizioni e chiave. Non indovinare i nomi dei campi.
3. Se servono più file, ricava chiavi e relazioni con as400_index_list e as400_constraints, e verifica che il collegamento sia sensato prima di unirli.
4. Scrivi una SELECT (o WITH) alla volta, con nomi qualificati {lib}.FILE, solo i campi necessari, un WHERE preciso e i valori passati come parametri (?) con l'argomento "{parametri}", non concatenati nel testo.
5. Se la domanda chiede un conteggio, un totale o una distribuzione, usa COUNT, SUM, GROUP BY e non leggere le righe. Per gli elenchi chiedi poche righe (FETCH FIRST 20 ROWS ONLY) e aumenta solo se serve.
6. Esegui con as400_sql_query e controlla il risultato: se il numero di righe o i valori non hanno senso, rivedi la query invece di commentarli.

Attenzione ai dati IBM i:
- le date sono spesso numeri (AAAAMMGG o CYYMMDD) o testo, non DATE: guarda il tipo del campo prima di confrontare o ordinare;
- i campi numerici (zoned, packed) hanno i decimali nel file_desc; nei risultati i numeri arrivano come stringhe;
- i campi di testo tornano senza spazi finali; per i confronti usa i valori esatti del campo;
- i nomi lunghi SQL possono differire dai nomi di sistema: usa quelli indicati da as400_file_desc;
- il server è in sola lettura: sono ammessi solo SELECT e WITH; il numero di righe è limitato e, se il risultato indica "{troncato}" o una nota, dillo nella risposta;
- se il server è configurato con una lista di librerie consentite, ogni tabella va qualificata con la libreria.

Dati personali: riporta solo ciò che serve a rispondere; se basta un aggregato non copiare record di persone.

Rispondi in italiano: prima la risposta alla domanda, poi la query usata (così si può verificare), le assunzioni fatte (per esempio come hai interpretato un campo) e i limiti (troncamenti, campi ambigui). Se i dati non ci sono o la domanda è ambigua, dillo e chiedi un chiarimento invece di inventare.`,
    en: `Answer a question about the data in the database of an IBM i system.

Question: "{domanda}"
Library of the data: {lib}{partenza}

Proceed as follows:
1. Find the right files: as400_table_list (filters on name or description text) and, if the question mentions a concept or a field, as400_column_search (by name or by text). Libraries hold thousands of files: use the filters.
2. For each candidate file use as400_file_desc: system names of the fields, type, length, decimals, descriptions and key. Do not guess field names.
3. If several files are needed, get keys and relationships with as400_index_list and as400_constraints, and check that the link makes sense before joining them.
4. Write one SELECT (or WITH) at a time, with qualified names {lib}.FILE, only the needed fields, a precise WHERE, and the values passed as parameters (?) with the "{parametri}" argument, not concatenated into the text.
5. If the question asks for a count, a total or a distribution, use COUNT, SUM, GROUP BY and do not read the rows. For lists ask for few rows (FETCH FIRST 20 ROWS ONLY) and raise it only if needed.
6. Run it with as400_sql_query and check the result: if the number of rows or the values make no sense, revise the query instead of commenting on them.

Watch out for IBM i data:
- dates are often numbers (YYYYMMDD or CYYMMDD) or text, not DATE: look at the field type before comparing or sorting;
- numeric fields (zoned, packed) have their decimals in the file_desc; in the results numbers arrive as strings;
- text fields come back without trailing spaces; for comparisons use the exact values of the field;
- long SQL names can differ from system names: use the ones given by as400_file_desc;
- the server is read-only: only SELECT and WITH are allowed; the number of rows is limited and, if the result says "{troncato}" or has a note, say so in the answer;
- if the server is configured with a list of allowed libraries, every table must be qualified with its library.

Personal data: report only what is needed to answer; if an aggregate is enough, do not copy people's records.

Answer in English: first the answer to the question, then the query used (so it can be checked), the assumptions made (for example how you interpreted a field) and the limits (truncations, ambiguous fields). If the data is not there or the question is ambiguous, say so and ask for clarification instead of making things up.`,
  }, { ...names(), lib, domanda, partenza });
}

const msg = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

/** Argomento di un prompt, dato il nome interno, dal contesto di completamento (che usa i nomi della lingua scelta). */
function ctxArg(ctx: { arguments?: Record<string, string> } | undefined, internal: string): string | undefined {
  return ctx?.arguments?.[paramName(internal)];
}

/** Argomenti ricevuti (nomi della lingua scelta) → nomi interni. */
function internalArgs(raw: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) out[internalParamName(k)] = v as string | undefined;
  return out;
}

interface PromptDef {
  name: Msg;
  title: Msg;
  description: Msg;
  /** argomenti: nome interno → schema (con descrizione già localizzata) */
  args: () => Record<string, z.ZodTypeAny>;
  build: (a: Record<string, string | undefined>) => string;
}

const LIB_ARG = (): z.ZodTypeAny => completable(z.string().describe(t({ it: 'Libreria', en: 'Library' })), (v) => completeLibrary(v));

export const PROMPTS: PromptDef[] = [
  {
    name: { it: 'spiega_programma', en: 'explain_program' },
    title: { it: 'Spiega un programma', en: 'Explain a program' },
    description: {
      it: 'Legge e spiega un programma RPG/CL (scopo, parametri, flusso, file, chiamate, anomalie).',
      en: 'Reads and explains an RPG/CL program (purpose, parameters, flow, files, calls, anomalies).',
    },
    args: () => ({
      libreria: LIB_ARG(),
      file: completable(z.string().describe(t({ it: 'File sorgente (es. QRPGLESRC)', en: 'Source file (e.g. QRPGLESRC)' })), (v, ctx) => completeSourceFile(ctxArg(ctx, 'libreria'), v)),
      membro: completable(z.string().describe(t({ it: 'Membro sorgente', en: 'Source member' })), (v, ctx) => completeMember(ctxArg(ctx, 'libreria'), ctxArg(ctx, 'file'), v)),
    }),
    build: (a) => promptSpiegaProgramma(a.libreria ?? '', a.file ?? '', a.membro ?? ''),
  },
  {
    name: { it: 'documenta_libreria', en: 'document_library' },
    title: { it: 'Documenta una libreria', en: 'Document a library' },
    description: {
      it: 'Produce un documento Markdown con programmi, file, dipendenze e lacune di una libreria.',
      en: 'Produces a Markdown document with the programs, files, dependencies and gaps of a library.',
    },
    args: () => ({
      libreria: LIB_ARG(),
      filtro: z.string().optional().describe(t({ it: 'Prefisso dei nomi da documentare (facoltativo)', en: 'Prefix of the names to document (optional)' })),
    }),
    build: (a) => promptDocumentaLibreria(a.libreria ?? '', a.filtro),
  },
  {
    name: { it: 'analizza_file', en: 'analyze_file' },
    title: { it: 'Analizza un file dati', en: 'Analyze a data file' },
    description: {
      it: 'Spiega un file: campi, chiavi, logici, vincoli, esempi di dati e chi lo usa.',
      en: 'Explains a file: fields, keys, logicals, constraints, sample data and who uses it.',
    },
    args: () => ({
      libreria: LIB_ARG(),
      file: completable(z.string().describe(t({ it: 'Nome del file', en: 'File name' })), (v, ctx) => completeFile(ctxArg(ctx, 'libreria'), v)),
    }),
    build: (a) => promptAnalizzaFile(a.libreria ?? '', a.file ?? ''),
  },
  {
    name: { it: 'dove_e_usato', en: 'find_usages' },
    title: { it: 'Dove è usato', en: 'Where is it used' },
    description: {
      it: 'Trova gli usi di un file, campo, programma o data area nei sorgenti e nel catalogo.',
      en: 'Finds the uses of a file, field, program or data area in the sources and in the catalog.',
    },
    args: () => ({
      libreria: LIB_ARG(),
      nome: z.string().describe(t({ it: 'File, campo, programma o data area', en: 'File, field, program or data area' })),
    }),
    build: (a) => promptDoveEUsato(a.libreria ?? '', a.nome ?? ''),
  },
  {
    name: { it: 'analizza_spool', en: 'analyze_spool' },
    title: { it: 'Analizza spool e joblog', en: 'Analyze spooled files and joblogs' },
    description: {
      it: 'Trova e legge file di spool (anche joblog) e ne riassume contenuto ed errori.',
      en: 'Finds and reads spooled files (including joblogs) and summarizes their content and errors.',
    },
    args: () => ({
      utente: z.string().optional().describe(t({ it: 'Profilo utente', en: 'User profile' })),
      file: z.string().optional().describe(t({ it: 'Nome file di spool (es. QPJOBLOG)', en: 'Spooled file name (e.g. QPJOBLOG)' })),
      data: z.string().optional().describe(t({ it: 'Data AAAA-MM-GG', en: 'Date YYYY-MM-DD' })),
    }),
    build: (a) => promptAnalizzaSpool(a.utente, a.file, a.data),
  },
  {
    name: { it: 'interroga_dati', en: 'query_data' },
    title: { it: 'Interroga i dati', en: 'Query the data' },
    description: {
      it: 'Risponde a una domanda sui dati: trova i file e i campi giusti, scrive una SELECT di sola lettura, la esegue e riporta risposta, query e assunzioni.',
      en: 'Answers a question about the data: finds the right files and fields, writes a read-only SELECT, runs it and reports the answer, the query and the assumptions.',
    },
    args: () => ({
      libreria: LIB_ARG(),
      domanda: z.string().describe(t({ it: 'Domanda sui dati, in linguaggio naturale', en: 'Question about the data, in natural language' })),
      file: completable(z.string().optional().describe(t({ it: 'File da cui partire (facoltativo)', en: 'File to start from (optional)' })), (v, ctx) => completeFile(ctxArg(ctx, 'libreria'), v ?? '')),
    }),
    build: (a) => promptInterrogaDati(a.libreria ?? '', a.domanda ?? '', a.file),
  },
  {
    name: { it: 'spiega_stampa', en: 'explain_print_file' },
    title: { it: 'Spiega un file di stampa o video', en: 'Explain a print or display file' },
    description: {
      it: 'Descrive il layout di un PRTF/DSPF dal sorgente DDS e lo confronta con gli spool reali.',
      en: 'Describes the layout of a PRTF/DSPF from the DDS source and compares it with real spooled files.',
    },
    args: () => ({
      libreria: LIB_ARG(),
      oggetto: completable(z.string().describe(t({ it: 'File di stampa o video', en: 'Print or display file' })), (v, ctx) => completeFile(ctxArg(ctx, 'libreria'), v)),
    }),
    build: (a) => promptSpiegaStampa(a.libreria ?? '', a.oggetto ?? ''),
  },
];

export function registerPrompts(server: McpServer): void {
  for (const def of PROMPTS) {
    // gli argomenti sono dichiarati con i nomi della lingua scelta
    const argsSchema: Record<string, z.ZodTypeAny> = {};
    for (const [internal, schema] of Object.entries(def.args())) argsSchema[paramName(internal)] = schema;
    server.registerPrompt(
      t(def.name),
      { title: t(def.title), description: t(def.description), argsSchema } as never,
      ((raw: Record<string, unknown>) => msg(def.build(internalArgs(raw ?? {})))) as never,
    );
  }
}
