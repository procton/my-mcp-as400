/* Definizione dichiarativa dei tool MCP, in italiano e in inglese.
 *
 * I nomi interni dei parametri (libreria, membro, daRiga, ...) sono quelli usati dalla logica in src/tools/*.
 * Con LOCALE=EN lo schema esposto al client usa i nomi inglesi (library, member, fromLine, ...) e qui gli argomenti
 * ricevuti vengono riportati ai nomi interni prima di chiamare l'handler. Lo stesso vale per i valori enumerati.
 * Nelle descrizioni, {daRiga} & co. diventano il nome del parametro nella lingua scelta. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PARAM_EN, getLocale, internalParamName, paramName, t, type Msg } from './i18n.js';
import type { ToolResult } from './tools/common.js';
import { sourceList, sourceRead, sourceSearch, sourceRefs } from './tools/source.js';
import { ifsList, ifsRead, ifsStat, ifsReadBinary, ifsSearch } from './tools/ifs.js';
import { sqlQuery, fileDesc } from './tools/sql.js';
import { spoolList, spoolRead, spoolSearch, spoolInfo } from './tools/spool.js';
import { systemInfo } from './tools/system.js';
import { objectList, objectDescribe } from './tools/objects.js';
import { ddsDescribe } from './tools/dds.js';
import { schemaList, tableList, columnSearch, indexList, whereUsed, viewDef, constraints, routineList } from './tools/catalog.js';

export interface ParamSpec {
  schema: z.ZodTypeAny;
  desc: Msg;
  /** valori ammessi: il valore interno (it) e quello mostrato in inglese (en) */
  values?: Array<{ it: string; en: string }>;
  optional?: boolean;
}

export interface ToolSpec {
  name: string;
  title: Msg;
  description: Msg;
  params: Record<string, ParamSpec>;
  // gli handler hanno argomenti tipizzati per tool: qui il confine è dinamico
  handler: (args: never) => Promise<ToolResult>;
}

/* ---------- costruttori di parametri ---------- */

const S = (desc: Msg): ParamSpec => ({ schema: z.string(), desc });
const SO = (desc: Msg): ParamSpec => ({ schema: z.string().optional(), desc });
const S2 = (desc: Msg): ParamSpec => ({ schema: z.string().min(2), desc });
const IO = (desc: Msg, min = 1, max?: number): ParamSpec => {
  let n = z.number().int().min(min);
  if (max !== undefined) n = n.max(max);
  return { schema: n.optional(), desc };
};
const BO = (desc: Msg): ParamSpec => ({ schema: z.boolean().optional(), desc });
const E = (values: Array<{ it: string; en: string }>, desc: Msg): ParamSpec => ({ schema: z.string(), desc, values, optional: true });

/* ---------- parametri ricorrenti ---------- */

const LIB: ParamSpec = S({ it: 'Libreria (max 10 caratteri)', en: 'Library (max 10 characters)' });
const FILE: ParamSpec = S({ it: 'Nome del file/oggetto (max 10 caratteri)', en: 'File/object name (max 10 characters)' });
const LIMITE: ParamSpec = IO({
  it: 'Numero massimo di risultati (default 200, tetto SQL_MAX_ROWS)',
  en: 'Maximum number of results (default 200, capped by SQL_MAX_ROWS)',
});
const LIKE_NAME: Msg = { it: 'Filtro nome (SQL LIKE: % e _)', en: 'Name filter (SQL LIKE: % and _)' };

const SPOOL_ID: Record<string, ParamSpec> = {
  libreria: S({ it: 'Libreria della coda di stampa (max 10 caratteri)', en: 'Library of the output queue (max 10 characters)' }),
  outq: S({ it: 'Coda di stampa (max 10 caratteri)', en: 'Output queue (max 10 characters)' }),
  file: S({ it: 'Nome del file di spool (max 10 caratteri)', en: 'Spooled file name (max 10 characters)' }),
  numero: IO({ it: 'Numero del file di spool, se il nome è duplicato', en: 'Spooled file number, if the name is duplicated' }),
  utente: SO({ it: 'Utente proprietario, per distinguere omonimi', en: 'Owner user, to tell same-named files apart' }),
  job: SO({ it: "Job 'numero/utente/nome', per distinguere omonimi", en: "Job 'number/user/name', to tell same-named files apart" }),
};

export const TOOLS: ToolSpec[] = [
  {
    name: 'as400_system_info',
    title: { it: 'Info sistema IBM i', en: 'IBM i system info' },
    description: {
      it: 'Mostra utente connesso, sistema IBM i e limiti attivi del server. Usalo per verificare la connessione.',
      en: "Shows the connected user, the IBM i system and the server's active limits. Use it to check the connection.",
    },
    params: {},
    handler: systemInfo as never,
  },
  {
    name: 'as400_source_list',
    title: { it: 'Elenca sorgenti', en: 'List sources' },
    description: {
      it: 'Elenca i file sorgente di una libreria (QSYS2.SYSTABLES, FILE_TYPE=S) oppure i membri di un file sorgente (QSYS2.SYSPARTITIONSTAT), con filtro opzionale.',
      en: 'Lists the source files of a library (QSYS2.SYSTABLES, FILE_TYPE=S) or the members of a source file (QSYS2.SYSPARTITIONSTAT), with an optional filter.',
    },
    params: {
      libreria: LIB,
      file: SO({ it: 'File sorgente (es. QRPGSRC); se omesso elenca i file sorgente', en: 'Source file (e.g. QRPGSRC); if omitted, lists the source files' }),
      filtro: SO(LIKE_NAME),
    },
    handler: sourceList as never,
  },
  {
    name: 'as400_source_read',
    title: { it: 'Leggi membro sorgente', en: 'Read source member' },
    description: {
      it: 'Legge il testo di un membro sorgente RPG/CL/DDS da QSYS tramite alias temporaneo in QTEMP. Usa {daRiga}/{aRiga} per membri lunghi.',
      en: 'Reads the text of an RPG/CL/DDS source member through a temporary alias in QTEMP. Use {daRiga}/{aRiga} for long members.',
    },
    params: {
      libreria: S({ it: 'Libreria del file sorgente', en: 'Library of the source file' }),
      file: S({ it: 'File sorgente (es. QRPGSRC)', en: 'Source file (e.g. QRPGSRC)' }),
      membro: S({ it: 'Nome del membro', en: 'Member name' }),
      numeriRiga: BO({ it: 'Numeri di riga prefissati (default true)', en: 'Prefix lines with line numbers (default true)' }),
      daRiga: IO({ it: 'Riga di partenza (1-based)', en: 'Starting line (1-based)' }),
      aRiga: IO({ it: 'Riga di fine inclusa', en: 'Last line, inclusive' }),
    },
    handler: sourceRead as never,
  },
  {
    name: 'as400_source_search',
    title: { it: 'Cerca testo nei sorgenti', en: 'Search text in sources' },
    description: {
      it: 'Cerca un testo (sottostringa) in tutti i membri sorgente di una libreria o di file sorgente selezionati; restituisce file, membro, numero di riga e testo. Esegue la scansione lato server; con molti membri può richiedere decine di secondi: restringi con {file}/{membro}.',
      en: 'Searches for text (substring) in all the source members of a library or of selected source files; returns file, member, line number and text. The scan runs on the server; with many members it can take tens of seconds: narrow it with {file}/{membro}.',
    },
    params: {
      libreria: LIB,
      testo: S2({ it: 'Testo da cercare (sottostringa, non regex)', en: 'Text to search for (substring, not a regex)' }),
      file: SO({ it: 'File sorgente (SQL LIKE, es. QRPGLESRC); default tutti', en: 'Source file (SQL LIKE, e.g. QRPGLESRC); default all' }),
      membro: SO({ it: 'Filtro nome membro (SQL LIKE)', en: 'Member name filter (SQL LIKE)' }),
      maiuscole: BO({ it: 'Distingue maiuscole/minuscole (default false)', en: 'Case-sensitive (default false)' }),
      limite: IO({ it: 'Massimo righe trovate (default 100)', en: 'Maximum matching lines (default 100)' }, 1, 1000),
      maxMembri: IO({ it: 'Massimo membri scansionati (default SEARCH_MAX_MEMBERS)', en: 'Maximum members scanned (default SEARCH_MAX_MEMBERS)' }),
    },
    handler: sourceSearch as never,
  },
  {
    name: 'as400_source_refs',
    title: { it: 'Riferimenti di un sorgente', en: 'References of a source' },
    description: {
      it: 'Analisi statica di un membro RPG/CL/DDS: file usati (con modo di accesso), programmi e procedure chiamati, /COPY, data area, tabelle SQL, comandi CL, formati record e chiavi DDS. Euristica: non vede le chiamate dinamiche.',
      en: 'Static analysis of an RPG/CL/DDS member: files used (with access mode), programs and procedures called, /COPY, data areas, SQL tables, CL commands, record formats and DDS keys. Heuristic: it does not see dynamic calls.',
    },
    params: {
      libreria: LIB,
      file: S({ it: 'File sorgente (es. QRPGLESRC)', en: 'Source file (e.g. QRPGLESRC)' }),
      membro: S({ it: 'Nome del membro', en: 'Member name' }),
      tipo: SO({ it: 'Tipo sorgente (RPGLE, CLLE, PF, ...); default letto dal membro', en: 'Source type (RPGLE, CLLE, PF, ...); default read from the member' }),
    },
    handler: sourceRefs as never,
  },
  {
    name: 'as400_object_list',
    title: { it: 'Elenca oggetti', en: 'List objects' },
    description: {
      it: 'Elenca oggetti di una libreria (QSYS2.OBJECT_STATISTICS) per tipo (*PGM, *SRVPGM, *CMD, *DTAARA, *DTAQ, *FILE, ...): attributo/linguaggio, descrizione, date, sorgente di origine. Filtri su nome, testo e attributo.',
      en: 'Lists the objects of a library (QSYS2.OBJECT_STATISTICS) by type (*PGM, *SRVPGM, *CMD, *DTAARA, *DTAQ, *FILE, ...): attribute/language, description, dates, source of origin. Filters on name, text and attribute.',
    },
    params: {
      libreria: LIB,
      tipo: SO({ it: "Tipi separati da spazio, es. '*PGM *SRVPGM' (default *ALL)", en: "Types separated by spaces, e.g. '*PGM *SRVPGM' (default *ALL)" }),
      filtro: SO({ it: 'Filtro nome (SQL LIKE)', en: 'Name filter (SQL LIKE)' }),
      testo: SO({ it: 'Sottostringa nella descrizione', en: 'Substring in the description' }),
      attributo: SO({ it: 'Es. RPGLE, CLLE, PF', en: 'E.g. RPGLE, CLLE, PF' }),
      limite: LIMITE,
    },
    handler: objectList as never,
  },
  {
    name: 'as400_object_describe',
    title: { it: 'Descrivi oggetto', en: 'Describe object' },
    description: {
      it: 'Dettaglio di un oggetto: date, proprietario, sorgente di origine; per *PGM/*SRVPGM anche moduli e service program collegati, activation group; per *DTAARA il valore.',
      en: 'Detail of an object: dates, owner, source of origin; for *PGM/*SRVPGM also bound modules and service programs and the activation group; for *DTAARA the value.',
    },
    params: {
      libreria: LIB,
      oggetto: S({ it: 'Nome oggetto (max 10 caratteri)', en: 'Object name (max 10 characters)' }),
      tipo: S({ it: "Tipo oggetto, es. '*PGM', '*SRVPGM', '*DTAARA', '*FILE'", en: "Object type, e.g. '*PGM', '*SRVPGM', '*DTAARA', '*FILE'" }),
    },
    handler: objectDescribe as never,
  },
  {
    name: 'as400_ifs_list',
    title: { it: 'Elenca directory IFS', en: 'List IFS directory' },
    description: {
      it: 'Elenca il contenuto di una directory IFS (QSYS2.IFS_OBJECT_STATISTICS), anche in profondità fino a 6 livelli, con filtro su nome e tipo. Con IFS_ALLOWED_PREFIXES i collegamenti simbolici non vengono seguiti.',
      en: 'Lists the content of an IFS directory (QSYS2.IFS_OBJECT_STATISTICS), also in depth up to 6 levels, with filters on name and type. With IFS_ALLOWED_PREFIXES symbolic links are not followed.',
    },
    params: {
      percorso: S({ it: 'Percorso assoluto (es. /home/profilo)', en: 'Absolute path (e.g. /home/profile)' }),
      profondita: IO({ it: 'Livelli da scendere (default 1)', en: 'Levels to descend (default 1)' }, 1, 6),
      filtro: SO({ it: 'Filtro nome (SQL LIKE), es. %.sh', en: 'Name filter (SQL LIKE), e.g. %.sh' }),
      tipo: E(
        [{ it: 'tutti', en: 'all' }, { it: 'file', en: 'file' }, { it: 'directory', en: 'directory' }],
        { it: "Default 'tutti'", en: "Default 'all'" },
      ),
      maxVoci: IO({ it: 'Massimo voci (default 500)', en: 'Maximum entries (default 500)' }, 1, 2000),
    },
    handler: ifsList as never,
  },
  {
    name: 'as400_ifs_stat',
    title: { it: 'Info su file o directory IFS', en: 'IFS file or directory info' },
    description: {
      it: 'Tipo, dimensione, proprietario, CCSID e data di modifica di un percorso IFS (per le directory anche il numero di voci).',
      en: 'Type, size, owner, CCSID and modification date of an IFS path (for directories also the number of entries).',
    },
    params: { percorso: S({ it: 'Percorso assoluto', en: 'Absolute path' }) },
    handler: ifsStat as never,
  },
  {
    name: 'as400_ifs_read',
    title: { it: 'Leggi file IFS', en: 'Read IFS file' },
    description: {
      it: "Legge un file di testo IFS (QSYS2.IFS_READ, decodifica secondo il CCSID del file). La finestra di righe ({daRiga}/{aRiga}) è selezionata sul server, quindi è efficiente anche su file grandi. Conserva l'indentazione.",
      en: "Reads an IFS text file (QSYS2.IFS_READ, decoded according to the file's CCSID). The line window ({daRiga}/{aRiga}) is selected on the server, so it is efficient even on large files. Preserves indentation.",
    },
    params: {
      percorso: S({ it: 'Percorso assoluto del file', en: 'Absolute path of the file' }),
      numeriRiga: BO({ it: 'Numeri di riga prefissati (default true)', en: 'Prefix lines with line numbers (default true)' }),
      daRiga: IO({ it: 'Riga di partenza (1-based)', en: 'Starting line (1-based)' }),
      aRiga: IO({ it: 'Riga di fine inclusa', en: 'Last line, inclusive' }),
      utf8: BO({ it: 'Forza UTF-8 (se il CCSID del file non è corretto)', en: "Force UTF-8 (if the file's CCSID is wrong)" }),
    },
    handler: ifsRead as never,
  },
  {
    name: 'as400_ifs_read_binary',
    title: { it: 'Anteprima binaria (hexdump) di un file IFS', en: 'Binary preview (hexdump) of an IFS file' },
    description: {
      it: 'Mostra byte esadecimali e ASCII di un file IFS a partire da un offset (max IFS_BINARY_MAX_BYTES). Per file binari, PDF, archivi e file con CCSID 65535.',
      en: 'Shows hexadecimal and ASCII bytes of an IFS file from an offset (max IFS_BINARY_MAX_BYTES). For binary files, PDFs, archives and files with CCSID 65535.',
    },
    params: {
      percorso: S({ it: 'Percorso assoluto del file', en: 'Absolute path of the file' }),
      offset: IO({ it: 'Byte di partenza (default 0)', en: 'Starting byte (default 0)' }, 0),
      lunghezza: IO({ it: 'Byte da leggere (default 256)', en: 'Bytes to read (default 256)' }),
    },
    handler: ifsReadBinary as never,
  },
  {
    name: 'as400_ifs_search',
    title: { it: 'Cerca testo nei file IFS', en: 'Search text in IFS files' },
    description: {
      it: 'Cerca un testo nei file di testo sotto una directory IFS (fino a 6 livelli): restituisce file, numero di riga e testo. Salta binari (CCSID 65535) e file molto grandi. Non disponibile in QSYS.LIB: per i sorgenti usa as400_source_search.',
      en: 'Searches for text in the text files under an IFS directory (up to 6 levels): returns file, line number and text. Skips binaries (CCSID 65535) and very large files. Not available in QSYS.LIB: for sources use as400_source_search.',
    },
    params: {
      percorso: S({ it: 'Directory di partenza', en: 'Starting directory' }),
      testo: S2({ it: 'Testo da cercare (sottostringa)', en: 'Text to search for (substring)' }),
      profondita: IO({ it: 'Livelli (default 3)', en: 'Levels (default 3)' }, 1, 6),
      filtro: SO({ it: 'Filtro nome file (SQL LIKE), es. %.sh', en: 'File name filter (SQL LIKE), e.g. %.sh' }),
      maiuscole: BO({ it: 'Distingue maiuscole/minuscole (default false)', en: 'Case-sensitive (default false)' }),
      limite: IO({ it: 'Massimo righe trovate (default 100)', en: 'Maximum matching lines (default 100)' }, 1, 1000),
      maxFile: IO({ it: 'Massimo file scansionati (default IFS_SEARCH_MAX_FILES)', en: 'Maximum files scanned (default IFS_SEARCH_MAX_FILES)' }),
      maxByteFile: IO({ it: 'Salta file più grandi di N byte (default 1000000)', en: 'Skip files larger than N bytes (default 1000000)' }),
    },
    handler: ifsSearch as never,
  },
  {
    name: 'as400_sql_query',
    title: { it: 'Query SQL read-only', en: 'Read-only SQL query' },
    description: {
      it: 'Esegue una SELECT (o WITH) sui file fisici/logici e sulle viste QSYS2. Un solo statement, senza punto e virgola; limite SQL_MAX_ROWS applicato automaticamente.',
      en: 'Runs a SELECT (or WITH) on physical/logical files and QSYS2 views. A single statement, without a semicolon; the SQL_MAX_ROWS limit is applied automatically.',
    },
    params: {
      query: S({ it: 'SELECT o WITH, un solo statement', en: 'SELECT or WITH, a single statement' }),
      parametri: {
        schema: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
        desc: { it: 'Parametri per i marker ?', en: 'Values for the ? parameter markers' },
      },
    },
    handler: sqlQuery as never,
  },
  {
    name: 'as400_file_desc',
    title: { it: 'Descrivi file PF/LF', en: 'Describe PF/LF file' },
    description: {
      it: 'Descrive un file fisico o logico: tipo, descrizione, campi (nome/tipo/lunghezza), chiavi. Per i file sorgente rimanda a as400_source_list.',
      en: 'Describes a physical or logical file: type, description, fields (name/type/length), keys. For source files it points to as400_source_list.',
    },
    params: {
      libreria: S({ it: 'Libreria del file', en: 'Library of the file' }),
      file: S({ it: 'Nome del file (max 10 caratteri)', en: 'File name (max 10 characters)' }),
    },
    handler: fileDesc as never,
  },
  {
    name: 'as400_schema_list',
    title: { it: 'Elenca librerie', en: 'List libraries' },
    description: {
      it: 'Elenca le librerie/schemi (QSYS2.SYSSCHEMAS) con descrizione e proprietario; rispetta ALLOWED_LIBS.',
      en: 'Lists the libraries/schemas (QSYS2.SYSSCHEMAS) with description and owner; honors ALLOWED_LIBS.',
    },
    params: {
      filtro: SO({ it: 'Filtro nome libreria (SQL LIKE)', en: 'Library name filter (SQL LIKE)' }),
      limite: LIMITE,
    },
    handler: schemaList as never,
  },
  {
    name: 'as400_table_list',
    title: { it: 'Elenca file, tabelle e viste', en: 'List files, tables and views' },
    description: {
      it: 'Elenca i file di una libreria dal catalogo SQL: PF/tabelle, LF, viste, file sorgente, con descrizione, numero campi e lunghezza record. Filtri per tipo, nome e testo della descrizione. Le librerie di produzione hanno migliaia di oggetti: usa i filtri.',
      en: 'Lists the files of a library from the SQL catalog: PF/tables, LF, views, source files, with description, field count and record length. Filters on type, name and description text. Production libraries hold thousands of objects: use the filters.',
    },
    params: {
      libreria: LIB,
      tipo: E(
        [
          { it: 'tutti', en: 'all' }, { it: 'fisici', en: 'physical' }, { it: 'logici', en: 'logical' },
          { it: 'viste', en: 'views' }, { it: 'sorgenti', en: 'sources' },
        ],
        { it: "Default 'tutti'", en: "Default 'all'" },
      ),
      filtro: SO(LIKE_NAME),
      testo: SO({ it: 'Sottostringa nella descrizione del file', en: 'Substring in the file description' }),
      limite: LIMITE,
    },
    handler: tableList as never,
  },
  {
    name: 'as400_column_search',
    title: { it: 'Cerca campi', en: 'Search fields' },
    description: {
      it: 'Cerca campi per nome (breve o lungo) e/o per testo/intestazione in tutti i file di una libreria. Utile per trovare dove compare un campo.',
      en: 'Searches fields by name (short or long) and/or by text/heading in all the files of a library. Useful to find where a field appears.',
    },
    params: {
      libreria: LIB,
      campo: SO({ it: 'Filtro nome campo (SQL LIKE)', en: 'Field name filter (SQL LIKE)' }),
      testo: SO({ it: 'Sottostringa nella descrizione/intestazione del campo', en: 'Substring in the field description/heading' }),
      file: SO({ it: 'Restringe ai file con questo nome (SQL LIKE)', en: 'Restrict to files with this name (SQL LIKE)' }),
      limite: LIMITE,
    },
    handler: columnSearch as never,
  },
  {
    name: 'as400_index_list',
    title: { it: 'Indici e logici di un file', en: 'Indexes and logicals of a file' },
    description: {
      it: 'Indici SQL e file logici con chiave basati su un file fisico: campi chiave e ordinamento, univocità; elenca anche i LF non indicizzati.',
      en: 'SQL indexes and keyed logical files built on a physical file: key fields and ordering, uniqueness; also lists non-indexed LFs.',
    },
    params: { libreria: LIB, file: FILE },
    handler: indexList as never,
  },
  {
    name: 'as400_where_used',
    title: { it: 'Dipendenze di un file', en: 'Dependencies of a file' },
    description: {
      it: 'Oggetti che dipendono da un file: viste, logici/indici, tabelle figlie via foreign key, trigger. Non rileva i programmi RPG/CL.',
      en: 'Objects that depend on a file: views, logicals/indexes, child tables through foreign keys, triggers. It does not detect RPG/CL programs.',
    },
    params: { libreria: LIB, file: FILE },
    handler: whereUsed as never,
  },
  {
    name: 'as400_view_def',
    title: { it: 'Definizione di una vista', en: 'Definition of a view' },
    description: {
      it: 'Testo SQL della definizione di una vista SQL (QSYS2.SYSVIEWS).',
      en: 'SQL text of the definition of an SQL view (QSYS2.SYSVIEWS).',
    },
    params: { libreria: LIB, file: S({ it: 'Nome (di sistema) della vista', en: '(System) name of the view' }) },
    handler: viewDef as never,
  },
  {
    name: 'as400_constraints',
    title: { it: 'Vincoli di un file', en: 'Constraints of a file' },
    description: {
      it: 'Chiave primaria, univoci, check e foreign key (con tabella referenziata e regole) di un file.',
      en: 'Primary key, unique, check and foreign key constraints (with referenced table and rules) of a file.',
    },
    params: { libreria: LIB, file: FILE },
    handler: constraints as never,
  },
  {
    name: 'as400_routine_list',
    title: { it: 'Procedure e funzioni SQL', en: 'SQL procedures and functions' },
    description: {
      it: 'Elenca procedure e funzioni (SQL ed esterne) di una libreria da QSYS2.SYSROUTINES.',
      en: 'Lists the procedures and functions (SQL and external) of a library from QSYS2.SYSROUTINES.',
    },
    params: {
      libreria: LIB,
      tipo: E(
        [{ it: 'procedure', en: 'procedures' }, { it: 'funzioni', en: 'functions' }, { it: 'tutte', en: 'all' }],
        { it: "Default 'tutte'", en: "Default 'all'" },
      ),
      filtro: SO({ it: 'Filtro nome (SQL LIKE)', en: 'Name filter (SQL LIKE)' }),
      limite: LIMITE,
    },
    handler: routineList as never,
  },
  {
    name: 'as400_spool_list',
    title: { it: 'Elenca code di stampa e spool', en: 'List output queues and spooled files' },
    description: {
      it: 'Senza {outq}: elenca le code di una libreria con numero di file e stato. Con {outq}: i file di spool della coda (più recenti per primi) con utente, job, pagine, tipo dati, data. Filtri su utente e nome.',
      en: 'Without {outq}: lists the queues of a library with file count and status. With {outq}: the spooled files of the queue (most recent first) with user, job, pages, data type, date. Filters on user and name.',
    },
    params: {
      libreria: S({ it: 'Libreria della coda (es. QUSRSYS, QGPL)', en: 'Library of the queue (e.g. QUSRSYS, QGPL)' }),
      outq: SO({ it: 'Coda di stampa; se omessa elenca le code della libreria', en: 'Output queue; if omitted, lists the library queues' }),
      utente: SO({ it: 'Filtra per profilo utente (SQL LIKE)', en: 'Filter by user profile (SQL LIKE)' }),
      filtro: SO({ it: 'Filtro nome file di spool (SQL LIKE)', en: 'Spooled file name filter (SQL LIKE)' }),
      limite: IO({ it: 'Massimo file (default 100)', en: 'Maximum files (default 100)' }),
    },
    handler: spoolList as never,
  },
  {
    name: 'as400_spool_search',
    title: { it: 'Cerca spool in tutte le code', en: 'Search spooled files in all queues' },
    description: {
      it: 'Cerca file di spool in tutte le code per utente, nome, job, USRDTA, stato, tipo dati e intervallo di date di creazione. Richiede almeno un filtro. Restituisce anche la coda, da usare con as400_spool_read.',
      en: 'Searches spooled files in all queues by user, name, job, USRDTA, status, data type and creation date range. Requires at least one filter. It also returns the queue, to use with as400_spool_read.',
    },
    params: {
      utente: SO({ it: 'Utente proprietario (SQL LIKE)', en: 'Owner user (SQL LIKE)' }),
      file: SO({ it: 'Nome file di spool (SQL LIKE)', en: 'Spooled file name (SQL LIKE)' }),
      job: SO({ it: "Job 'numero/utente/nome' (SQL LIKE)", en: "Job 'number/user/name' (SQL LIKE)" }),
      datiUtente: SO({ it: 'Campo USRDTA (SQL LIKE)', en: 'USRDTA field (SQL LIKE)' }),
      stato: SO({ it: 'READY, HELD, PRINTING, SAVED, ...', en: 'READY, HELD, PRINTING, SAVED, ...' }),
      tipo: SO({ it: '*SCS, *AFPDS, *USERASCII, *LINE, ...', en: '*SCS, *AFPDS, *USERASCII, *LINE, ...' }),
      dal: SO({ it: 'Creati dal (AAAA-MM-GG)', en: 'Created from (YYYY-MM-DD)' }),
      al: SO({ it: 'Creati fino al (AAAA-MM-GG, incluso)', en: 'Created up to (YYYY-MM-DD, inclusive)' }),
      libreria: SO({ it: 'Restringe a una libreria di code', en: 'Restrict to a queue library' }),
      outq: SO({ it: 'Restringe a una coda (con libreria)', en: 'Restrict to a queue (with library)' }),
      limite: IO({ it: 'Massimo file (default 100)', en: 'Maximum files (default 100)' }),
    },
    handler: spoolSearch as never,
  },
  {
    name: 'as400_spool_info',
    title: { it: 'Attributi di un file di spool', en: 'Spooled file attributes' },
    description: {
      it: 'Attributi completi di un file di spool: pagine, copie, form type, larghezza/lunghezza pagina, lpi/cpi, font, overlay, programma che lo ha aperto.',
      en: 'Full attributes of a spooled file: pages, copies, form type, page width/length, lpi/cpi, fonts, overlays, program that opened it.',
    },
    params: SPOOL_ID,
    handler: spoolInfo as never,
  },
  {
    name: 'as400_spool_read',
    title: { it: 'Leggi file di spool', en: 'Read spooled file' },
    description: {
      it: 'Legge il contenuto di un file di spool come testo (SCS, AFPDS, LINE, USERASCII). Il server converte il flusso in ASCII; le pagine sono separate da form feed e selezionabili con {daPagina}/{aPagina}. Per AFPDS è estratto solo il testo.',
      en: 'Reads the content of a spooled file as text (SCS, AFPDS, LINE, USERASCII). The server converts the stream to ASCII; pages are separated by form feeds and can be selected with {daPagina}/{aPagina}. For AFPDS only the text is extracted.',
    },
    params: {
      ...SPOOL_ID,
      daPagina: IO({ it: 'Prima pagina (1-based)', en: 'First page (1-based)' }),
      aPagina: IO({ it: 'Ultima pagina inclusa', en: 'Last page, inclusive' }),
      pulisci: BO({ it: 'Rimuove i caratteri di controllo residui (default true)', en: 'Remove leftover control characters (default true)' }),
    },
    handler: spoolRead as never,
  },
  {
    name: 'as400_dds_describe',
    title: { it: 'Struttura di un file dal sorgente DDS', en: 'File structure from the DDS source' },
    description: {
      it: 'Descrive PF, LF, DSPF e PRTF leggendo il sorgente DDS: formati record, campi (tipo, lunghezza, decimali, uso, riga/posizione, testo, intestazione), costanti di schermo/stampa, indicatori, chiavi, select/omit, parole chiave (DSPSIZ, CA03, ...). Con "{oggetto}" ricava il sorgente dal file compilato e avvisa se è stato modificato dopo la compilazione. Per PF/LF il catalogo SQL (as400_file_desc) resta la fonte più affidabile.',
      en: 'Describes PF, LF, DSPF and PRTF by reading the DDS source: record formats, fields (type, length, decimals, usage, line/position, text, heading), screen/print constants, indicators, keys, select/omit, keywords (DSPSIZ, CA03, ...). With "{oggetto}" it derives the source from the compiled file and warns if it was modified after compilation. For PF/LF the SQL catalog (as400_file_desc) remains the most reliable source.',
    },
    params: {
      libreria: S({ it: 'Libreria del file (con {oggetto}) o del sorgente (con {file}+{membro})', en: 'Library of the file (with {oggetto}) or of the source (with {file}+{membro})' }),
      oggetto: SO({ it: 'File compilato (PF, LF, DSPF, PRTF)', en: 'Compiled file (PF, LF, DSPF, PRTF)' }),
      file: SO({ it: 'File sorgente DDS (es. QDDSSRC), in alternativa a {oggetto}', en: 'DDS source file (e.g. QDDSSRC), as an alternative to {oggetto}' }),
      membro: SO({ it: 'Membro DDS, con {file}', en: 'DDS member, with {file}' }),
    },
    handler: ddsDescribe as never,
  },
];

/* ---------- registrazione ---------- */

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** {daRiga} & co. → nome del parametro nella lingua scelta (anche per i nomi uguali nelle due lingue, es. {file}). */
function nameMap(): Record<string, string> {
  const all = new Set<string>(Object.keys(PARAM_EN));
  for (const spec of TOOLS) for (const k of Object.keys(spec.params)) all.add(k);
  return Object.fromEntries([...all].map((k) => [k, paramName(k)]));
}

function shownValues(p: ParamSpec): string[] {
  return (p.values ?? []).map((v) => (getLocale() === 'EN' ? v.en : v.it));
}

/** Schema esposto al client per un tool, con nomi e descrizioni nella lingua scelta. */
export function buildInputShape(spec: ToolSpec): Record<string, z.ZodTypeAny> {
  const names = nameMap();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [internal, p] of Object.entries(spec.params)) {
    let schema = p.schema;
    if (p.values) {
      const vals = shownValues(p);
      schema = z.enum(vals as [string, ...string[]]);
      if (p.optional) schema = schema.optional();
    }
    shape[paramName(internal)] = schema.describe(t(p.desc, names));
  }
  return shape;
}

/** Argomenti ricevuti dal client (nomi e valori nella lingua scelta) → argomenti interni per l'handler. */
export function toInternalArgs(spec: ToolSpec, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const internal = internalParamName(k);
    const p = spec.params[internal];
    if (p?.values && typeof v === 'string') {
      const idx = shownValues(p).indexOf(v);
      out[internal] = idx >= 0 ? p.values[idx].it : v;
    } else {
      out[internal] = v;
    }
  }
  return out;
}

export function registerTools(server: McpServer): void {
  const names = nameMap();
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: t(spec.title),
        description: t(spec.description, names),
        inputSchema: buildInputShape(spec),
        annotations: READ_ONLY,
      } as never,
      (async (raw: Record<string, unknown>) => spec.handler(toInternalArgs(spec, raw ?? {}) as never)) as never,
    );
  }
}
