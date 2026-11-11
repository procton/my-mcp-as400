#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig } from './config.js';
import { closePool } from './pool.js';
import { sourceList, sourceRead } from './tools/source.js';
import { ifsList, ifsRead } from './tools/ifs.js';
import { sqlQuery, fileDesc } from './tools/sql.js';
import { spoolList, spoolRead } from './tools/spool.js';
import { systemInfo } from './tools/system.js';
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
        'Elenca il contenuto di primo livello di una directory IFS via QSYS2.IFS_OBJECT_STATISTICS.',
      inputSchema: {
        percorso: z.string().describe('Percorso assoluto (es. /home/profilo)'),
      },
      annotations: READ_ONLY,
    },
    ifsList,
  );

  server.registerTool(
    'as400_ifs_read',
    {
      title: 'Leggi file IFS',
      description:
        'Legge un file di testo IFS via QSYS2.IFS_READ (decodifica CCSID). Usa daRiga per file lunghi.',
      inputSchema: {
        percorso: z.string().describe('Percorso assoluto del file'),
        numeriRiga: z.boolean().optional().describe('Numeri di riga prefissati (default true)'),
        daRiga: z.number().int().min(1).optional().describe('Riga di partenza (1-based)'),
      },
      annotations: READ_ONLY,
    },
    ifsRead,
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

  server.registerTool(
    'as400_spool_list',
    {
      title: 'Elenca code di stampa',
      description:
        'Elenca i file di spool: con libreria+outq filtrati, altrimenti tutte le code visibili. Filtro su nome file o utente.',
      inputSchema: {
        libreria: z.string().describe('Libreria della coda (es. QUSRSYS, QGPL)'),
        outq: z.string().optional().describe('Coda di stampa (es. PRT01); se omessa elenca le code della libreria'),
        utente: z.string().optional().describe('Filtra per profilo utente'),
        filtro: z.string().optional().describe('Filtro nome file di spool (SQL LIKE)'),
      },
      annotations: READ_ONLY,
    },
    spoolList,
  );

  server.registerTool(
    'as400_spool_read',
    {
      title: 'Leggi file di spool',
      description:
        'Legge il contenuto testuale di un file di spool via QSYS2.OUTPUT_QUEUE_ENTRIES; rimuove i caratteri di controllo SCS di default.',
      inputSchema: {
        libreria: z.string().describe('Libreria della coda di stampa'),
        outq: z.string().describe('Coda di stampa (max 10 caratteri)'),
        file: z.string().describe('Nome del file di spool (max 10 caratteri)'),
        numero: z.number().int().optional().describe('Numero file di spool se il nome è duplicato'),
        pulisci: z.boolean().optional().describe('Rimuove caratteri di controllo SCS (default true)'),
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
