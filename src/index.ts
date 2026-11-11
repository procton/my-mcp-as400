#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig } from './config.js';
import { closePool } from './pool.js';
import { sourceList, sourceRead } from './tools/source.js';
import { ifsList, ifsRead, ifsStat, ifsReadBinary, ifsSearch } from './tools/ifs.js';
import { sqlQuery, fileDesc } from './tools/sql.js';
import { spoolList, spoolRead, spoolSearch, spoolInfo } from './tools/spool.js';
import { systemInfo } from './tools/system.js';
import { objectList, objectDescribe } from './tools/objects.js';
import { ddsDescribe } from './tools/dds.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { sourceSearch, sourceRefs } from './tools/source.js';
import { schemaList, tableList, columnSearch, indexList, whereUsed, viewDef, constraints, routineList } from './tools/catalog.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function log(msg: string): void {
  // su stdio la stdout è riservata al protocollo MCP: log solo su stderr
  console.error(`my-mcp-as400: ${msg}`);
}

async function main(): Promise<void> {
  const cfg = getConfig();
  log(`configurazione caricata (host ${cfg.host}, utente ${cfg.user}, read-only)`);

  const server = new McpServer({ name: 'my-mcp-as400', version: '0.1.0' });

  server.registerTool(
    'as400_system_info',
    {
      title: 'Info sistema IBM i',
      description:
        'Mostra utente connesso, sistema IBM i e limiti attivi del server. Usalo per verificare la connessione.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    systemInfo,
  );

  server.registerTool(
    'as400_source_list',
    {
      title: 'Elenca sorgenti',
      description:
        'Elenca i file sorgente di una libreria (QSYS2.SYSTABLES, FILE_TYPE=S) oppure i membri di un file sorgente (QSYS2.QSYS2.SYSPARTITIONSTAT), con filtro opzionale.',
      inputSchema: {
        libreria: z.string().describe('Libreria (max 10 caratteri)'),
        file: z.string().optional().describe('File sorgente (es. QRPGSRC); se omesso elenca i file sorgente'),
        filtro: z.string().optional().describe('Filtro nome (SQL LIKE: % e _)'),
      },
      annotations: READ_ONLY,
    },
    sourceList,
  );

  server.registerTool(
    'as400_source_read',
    {
      title: 'Leggi membro sorgente',
      description:
        'Legge il testo di un membro sorgente RPG/CL/DDS da QSYS tramite alias temporaneo in QTEMP. Usa daRiga/aRiga per membri lunghi.',
      inputSchema: {
        libreria: z.string().describe('Libreria del file sorgente'),
        file: z.string().describe('File sorgente (es. QRPGSRC)'),
        membro: z.string().describe('Nome del membro'),
        numeriRiga: z.boolean().optional().describe('Numeri di riga prefissati (default true)'),
        daRiga: z.number().int().min(1).optional().describe('Riga di partenza (1-based)'),
        aRiga: z.number().int().min(1).optional().describe('Riga di fine inclusa'),
      },
      annotations: READ_ONLY,
    },
    sourceRead,
  );

  server.registerTool(
    'as400_ifs_list',
    {
      title: 'Elenca directory IFS',
      description:
        'Elenca il contenuto di una directory IFS (QSYS2.IFS_OBJECT_STATISTICS), anche in profondità fino a 6 livelli, con filtro su nome e tipo. Con IFS_ALLOWED_PREFIXES i collegamenti simbolici non vengono seguiti.',
      inputSchema: {
        percorso: z.string().describe('Percorso assoluto (es. /home/profilo)'),
        profondita: z.number().int().min(1).max(6).optional().describe('Livelli da scendere (default 1)'),
        filtro: z.string().optional().describe('Filtro nome (SQL LIKE), es. %.sh'),
        tipo: z.enum(['tutti', 'file', 'directory']).optional().describe("Default 'tutti'"),
        maxVoci: z.number().int().min(1).max(2000).optional().describe('Massimo voci (default 500)'),
      },
      annotations: READ_ONLY,
    },
    ifsList,
  );

  server.registerTool(
    'as400_ifs_stat',
    {
      title: 'Info su file o directory IFS',
      description: 'Tipo, dimensione, proprietario, CCSID e data di modifica di un percorso IFS (per le directory anche il numero di voci).',
      inputSchema: { percorso: z.string().describe('Percorso assoluto') },
      annotations: READ_ONLY,
    },
    ifsStat,
  );

  server.registerTool(
    'as400_ifs_read',
    {
      title: 'Leggi file IFS',
      description:
        'Legge un file di testo IFS (QSYS2.IFS_READ, decodifica secondo il CCSID del file). La finestra di righe (daRiga/aRiga) è selezionata sul server, quindi è efficiente anche su file grandi. Conserva l\'indentazione.',
      inputSchema: {
        percorso: z.string().describe('Percorso assoluto del file'),
        numeriRiga: z.boolean().optional().describe('Numeri di riga prefissati (default true)'),
        daRiga: z.number().int().min(1).optional().describe('Riga di partenza (1-based)'),
        aRiga: z.number().int().min(1).optional().describe('Riga di fine inclusa'),
        utf8: z.boolean().optional().describe('Forza UTF-8 (se il CCSID del file non è corretto)'),
      },
      annotations: READ_ONLY,
    },
    ifsRead,
  );

  server.registerTool(
    'as400_ifs_read_binary',
    {
      title: 'Anteprima binaria (hexdump) di un file IFS',
      description:
        'Mostra byte esadecimali e ASCII di un file IFS a partire da un offset (max IFS_BINARY_MAX_BYTES). Per file binari, PDF, archivi e file con CCSID 65535.',
      inputSchema: {
        percorso: z.string().describe('Percorso assoluto del file'),
        offset: z.number().int().min(0).optional().describe('Byte di partenza (default 0)'),
        lunghezza: z.number().int().min(1).optional().describe('Byte da leggere (default 256)'),
      },
      annotations: READ_ONLY,
    },
    ifsReadBinary,
  );

  server.registerTool(
    'as400_ifs_search',
    {
      title: 'Cerca testo nei file IFS',
      description:
        'Cerca un testo nei file di testo sotto una directory IFS (fino a 6 livelli): restituisce file, numero di riga e testo. Salta binari (CCSID 65535) e file molto grandi. Non disponibile in QSYS.LIB: per i sorgenti usa as400_source_search.',
      inputSchema: {
        percorso: z.string().describe('Directory di partenza'),
        testo: z.string().min(2).describe('Testo da cercare (sottostringa)'),
        profondita: z.number().int().min(1).max(6).optional().describe('Livelli (default 3)'),
        filtro: z.string().optional().describe('Filtro nome file (SQL LIKE), es. %.sh'),
        maiuscole: z.boolean().optional().describe('Distingue maiuscole/minuscole (default false)'),
        limite: z.number().int().min(1).max(1000).optional().describe('Massimo righe trovate (default 100)'),
        maxFile: z.number().int().min(1).optional().describe('Massimo file scansionati (default IFS_SEARCH_MAX_FILES)'),
        maxByteFile: z.number().int().min(1).optional().describe('Salta file più grandi di N byte (default 1000000)'),
      },
      annotations: READ_ONLY,
    },
    ifsSearch,
  );

  server.registerTool(
    'as400_sql_query',
    {
      title: 'Query SQL read-only',
      description:
        'Esegue una SELECT (o WITH) sui file fisici/logici e sulle viste QSYS2. Un solo statement, senza punto e virgola; limite SQL_MAX_ROWS applicato automaticamente.',
      inputSchema: {
        query: z.string().describe('SELECT o WITH, un solo statement'),
        parametri: z.array(z.union([z.string(), z.number(), z.null()])).optional()
          .describe('Parametri per i marker ?'),
      },
      annotations: READ_ONLY,
    },
    sqlQuery,
  );

  server.registerTool(
    'as400_file_desc',
    {
      title: 'Descrivi file PF/LF',
      description:
        'Descrive un file fisico o logico: tipo, descrizione, campi (nome/tipo/lunghezza), chiavi. Per i file sorgente rimanda a as400_source_list.',
      inputSchema: {
        libreria: z.string().describe('Libreria del file'),
        file: z.string().describe('Nome del file (max 10 caratteri)'),
      },
      annotations: READ_ONLY,
    },
    fileDesc,
  );

  const SPOOL_ID = {
    libreria: z.string().describe('Libreria della coda di stampa (max 10 caratteri)'),
    outq: z.string().describe('Coda di stampa (max 10 caratteri)'),
    file: z.string().describe('Nome del file di spool (max 10 caratteri)'),
    numero: z.number().int().optional().describe('Numero del file di spool, se il nome è duplicato'),
    utente: z.string().optional().describe('Utente proprietario, per distinguere omonimi'),
    job: z.string().optional().describe("Job 'numero/utente/nome', per distinguere omonimi"),
  };

  server.registerTool(
    'as400_spool_list',
    {
      title: 'Elenca code di stampa e spool',
      description:
        'Senza outq: elenca le code di una libreria con numero di file e stato. Con outq: i file di spool della coda (più recenti per primi) con utente, job, pagine, tipo dati, data. Filtri su utente e nome.',
      inputSchema: {
        libreria: z.string().describe('Libreria della coda (es. QUSRSYS, QGPL)'),
        outq: z.string().optional().describe('Coda di stampa; se omessa elenca le code della libreria'),
        utente: z.string().optional().describe('Filtra per profilo utente (SQL LIKE)'),
        filtro: z.string().optional().describe('Filtro nome file di spool (SQL LIKE)'),
        limite: z.number().int().min(1).optional().describe('Massimo file (default 100)'),
      },
      annotations: READ_ONLY,
    },
    spoolList,
  );

  server.registerTool(
    'as400_spool_search',
    {
      title: 'Cerca spool in tutte le code',
      description:
        'Cerca file di spool in tutte le code per utente, nome, job, USRDTA, stato, tipo dati e intervallo di date di creazione. Richiede almeno un filtro. Restituisce anche la coda, da usare con as400_spool_read.',
      inputSchema: {
        utente: z.string().optional().describe('Utente proprietario (SQL LIKE)'),
        file: z.string().optional().describe('Nome file di spool (SQL LIKE)'),
        job: z.string().optional().describe("Job 'numero/utente/nome' (SQL LIKE)"),
        datiUtente: z.string().optional().describe('Campo USRDTA (SQL LIKE)'),
        stato: z.string().optional().describe('READY, HELD, PRINTING, SAVED, ...'),
        tipo: z.string().optional().describe('*SCS, *AFPDS, *USERASCII, *LINE, ...'),
        dal: z.string().optional().describe('Creati dal (AAAA-MM-GG)'),
        al: z.string().optional().describe('Creati fino al (AAAA-MM-GG, incluso)'),
        libreria: z.string().optional().describe('Restringe a una libreria di code'),
        outq: z.string().optional().describe('Restringe a una coda (con libreria)'),
        limite: z.number().int().min(1).optional().describe('Massimo file (default 100)'),
      },
      annotations: READ_ONLY,
    },
    spoolSearch,
  );

  server.registerTool(
    'as400_spool_info',
    {
      title: 'Attributi di un file di spool',
      description: 'Attributi completi di un file di spool: pagine, copie, form type, larghezza/lunghezza pagina, lpi/cpi, font, overlay, programma che lo ha aperto.',
      inputSchema: SPOOL_ID,
      annotations: READ_ONLY,
    },
    spoolInfo,
  );

  server.registerTool(
    'as400_spool_read',
    {
      title: 'Leggi file di spool',
      description:
        'Legge il contenuto di un file di spool come testo (SCS, AFPDS, LINE, USERASCII). Il server converte il flusso in ASCII; le pagine sono separate da form feed e selezionabili con daPagina/aPagina. Per AFPDS è estratto solo il testo.',
      inputSchema: {
        ...SPOOL_ID,
        daPagina: z.number().int().min(1).optional().describe('Prima pagina (1-based)'),
        aPagina: z.number().int().min(1).optional().describe('Ultima pagina inclusa'),
        pulisci: z.boolean().optional().describe('Rimuove i caratteri di controllo residui (default true)'),
      },
      annotations: READ_ONLY,
    },
    spoolRead,
  );

  const LIB = z.string().describe('Libreria (max 10 caratteri)');
  const FILE = z.string().describe('Nome del file/oggetto (max 10 caratteri)');
  const LIMITE = z.number().int().min(1).optional().describe('Numero massimo di risultati (default 200, tetto SQL_MAX_ROWS)');

  server.registerTool(
    'as400_schema_list',
    {
      title: 'Elenca librerie',
      description: 'Elenca le librerie/schemi (QSYS2.SYSSCHEMAS) con descrizione e proprietario; rispetta ALLOWED_LIBS.',
      inputSchema: { filtro: z.string().optional().describe('Filtro nome libreria (SQL LIKE)'), limite: LIMITE },
      annotations: READ_ONLY,
    },
    schemaList,
  );

  server.registerTool(
    'as400_table_list',
    {
      title: 'Elenca file, tabelle e viste',
      description:
        'Elenca i file di una libreria dal catalogo SQL: PF/tabelle, LF, viste, file sorgente, con descrizione, numero campi e lunghezza record. Filtri per tipo, nome e testo della descrizione. Le librerie di produzione hanno migliaia di oggetti: usa i filtri.',
      inputSchema: {
        libreria: LIB,
        tipo: z.enum(['tutti', 'fisici', 'logici', 'viste', 'sorgenti']).optional().describe("Default 'tutti'"),
        filtro: z.string().optional().describe('Filtro nome (SQL LIKE)'),
        testo: z.string().optional().describe('Sottostringa nella descrizione del file'),
        limite: LIMITE,
      },
      annotations: READ_ONLY,
    },
    tableList,
  );

  server.registerTool(
    'as400_column_search',
    {
      title: 'Cerca campi',
      description:
        'Cerca campi per nome (breve o lungo) e/o per testo/intestazione in tutti i file di una libreria. Utile per trovare dove compare un campo.',
      inputSchema: {
        libreria: LIB,
        campo: z.string().optional().describe('Filtro nome campo (SQL LIKE)'),
        testo: z.string().optional().describe('Sottostringa nella descrizione/intestazione del campo'),
        file: z.string().optional().describe('Restringe ai file con questo nome (SQL LIKE)'),
        limite: LIMITE,
      },
      annotations: READ_ONLY,
    },
    columnSearch,
  );

  server.registerTool(
    'as400_index_list',
    {
      title: 'Indici e logici di un file',
      description: 'Indici SQL e file logici con chiave basati su un file fisico: campi chiave e ordinamento, univocità; elenca anche i LF non indicizzati.',
      inputSchema: { libreria: LIB, file: FILE },
      annotations: READ_ONLY,
    },
    indexList,
  );

  server.registerTool(
    'as400_where_used',
    {
      title: 'Dipendenze di un file',
      description: 'Oggetti che dipendono da un file: viste, logici/indici, tabelle figlie via foreign key, trigger. Non rileva i programmi RPG/CL.',
      inputSchema: { libreria: LIB, file: FILE },
      annotations: READ_ONLY,
    },
    whereUsed,
  );

  server.registerTool(
    'as400_view_def',
    {
      title: 'Definizione di una vista',
      description: 'Testo SQL della definizione di una vista SQL (QSYS2.SYSVIEWS).',
      inputSchema: { libreria: LIB, file: z.string().describe('Nome (di sistema) della vista') },
      annotations: READ_ONLY,
    },
    viewDef,
  );

  server.registerTool(
    'as400_constraints',
    {
      title: 'Vincoli di un file',
      description: 'Chiave primaria, univoci, check e foreign key (con tabella referenziata e regole) di un file.',
      inputSchema: { libreria: LIB, file: FILE },
      annotations: READ_ONLY,
    },
    constraints,
  );

  server.registerTool(
    'as400_routine_list',
    {
      title: 'Procedure e funzioni SQL',
      description: 'Elenca procedure e funzioni (SQL ed esterne) di una libreria da QSYS2.SYSROUTINES.',
      inputSchema: {
        libreria: LIB,
        tipo: z.enum(['procedure', 'funzioni', 'tutte']).optional().describe("Default 'tutte'"),
        filtro: z.string().optional().describe('Filtro nome (SQL LIKE)'),
        limite: LIMITE,
      },
      annotations: READ_ONLY,
    },
    routineList,
  );

  server.registerTool(
    'as400_source_search',
    {
      title: 'Cerca testo nei sorgenti',
      description:
        'Cerca un testo (sottostringa) in tutti i membri sorgente di una libreria o di file sorgente selezionati; restituisce file, membro, numero di riga e testo. Esegue la scansione lato server; con molti membri può richiedere decine di secondi: restringi con file/membro.',
      inputSchema: {
        libreria: LIB,
        testo: z.string().min(2).describe('Testo da cercare (sottostringa, non regex)'),
        file: z.string().optional().describe('File sorgente (SQL LIKE, es. QRPGLESRC); default tutti'),
        membro: z.string().optional().describe('Filtro nome membro (SQL LIKE)'),
        maiuscole: z.boolean().optional().describe('Distingue maiuscole/minuscole (default false)'),
        limite: z.number().int().min(1).max(1000).optional().describe('Massimo righe trovate (default 100)'),
        maxMembri: z.number().int().min(1).optional().describe('Massimo membri scansionati (default SEARCH_MAX_MEMBERS)'),
      },
      annotations: READ_ONLY,
    },
    sourceSearch,
  );

  server.registerTool(
    'as400_source_refs',
    {
      title: 'Riferimenti di un sorgente',
      description:
        'Analisi statica di un membro RPG/CL/DDS: file usati (con modo di accesso), programmi e procedure chiamati, /COPY, data area, tabelle SQL, comandi CL, formati record e chiavi DDS. Euristica: non vede le chiamate dinamiche.',
      inputSchema: {
        libreria: LIB,
        file: z.string().describe('File sorgente (es. QRPGLESRC)'),
        membro: z.string().describe('Nome del membro'),
        tipo: z.string().optional().describe('Tipo sorgente (RPGLE, CLLE, PF, ...); default letto dal membro'),
      },
      annotations: READ_ONLY,
    },
    sourceRefs,
  );

  server.registerTool(
    'as400_object_list',
    {
      title: 'Elenca oggetti',
      description:
        'Elenca oggetti di una libreria (QSYS2.OBJECT_STATISTICS) per tipo (*PGM, *SRVPGM, *CMD, *DTAARA, *DTAQ, *FILE, ...): attributo/linguaggio, descrizione, date, sorgente di origine. Filtri su nome, testo e attributo.',
      inputSchema: {
        libreria: LIB,
        tipo: z.string().optional().describe("Tipi separati da spazio, es. '*PGM *SRVPGM' (default *ALL)"),
        filtro: z.string().optional().describe('Filtro nome (SQL LIKE)'),
        testo: z.string().optional().describe('Sottostringa nella descrizione'),
        attributo: z.string().optional().describe('Es. RPGLE, CLLE, PF'),
        limite: LIMITE,
      },
      annotations: READ_ONLY,
    },
    objectList,
  );

  server.registerTool(
    'as400_object_describe',
    {
      title: 'Descrivi oggetto',
      description:
        'Dettaglio di un oggetto: date, proprietario, sorgente di origine; per *PGM/*SRVPGM anche moduli e service program collegati, activation group; per *DTAARA il valore.',
      inputSchema: {
        libreria: LIB,
        oggetto: z.string().describe('Nome oggetto (max 10 caratteri)'),
        tipo: z.string().describe("Tipo oggetto, es. '*PGM', '*SRVPGM', '*DTAARA', '*FILE'"),
      },
      annotations: READ_ONLY,
    },
    objectDescribe,
  );

  server.registerTool(
    'as400_dds_describe',
    {
      title: 'Struttura di un file dal sorgente DDS',
      description:
        'Descrive PF, LF, DSPF e PRTF leggendo il sorgente DDS: formati record, campi (tipo, lunghezza, decimali, uso, riga/posizione, testo, intestazione), costanti di schermo/stampa, indicatori, chiavi, select/omit, parole chiave (DSPSIZ, CA03, ...). Con "oggetto" ricava il sorgente dal file compilato e avvisa se è stato modificato dopo la compilazione. Per PF/LF il catalogo SQL (as400_file_desc) resta la fonte più affidabile.',
      inputSchema: {
        libreria: z.string().describe('Libreria del file (con oggetto) o del sorgente (con file+membro)'),
        oggetto: z.string().optional().describe('File compilato (PF, LF, DSPF, PRTF)'),
        file: z.string().optional().describe('File sorgente DDS (es. QDDSSRC), in alternativa a oggetto'),
        membro: z.string().optional().describe('Membro DDS, con file'),
      },
      annotations: READ_ONLY,
    },
    ddsDescribe,
  );

  registerResources(server);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('pronto (stdio)');
}

main().catch((err: unknown) => {
  console.error('my-mcp-as400: errore fatale:', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closePool().finally(() => process.exit(0));
  });
}
