import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';
import { completeLibrary, completeSourceFile, completeMember, completeFile } from './resources.js';

/* Testi dei prompt: funzioni pure, così sono testabili. Ognuno indica al modello quali tool usare e in che ordine. */

export function promptSpiegaProgramma(lib: string, file: string, membro: string): string {
  return `Spiega il programma ${lib}/${file}(${membro}) di un sistema IBM i.

Procedi così:
1. Usa as400_source_read per leggere il sorgente (se è lungo, leggilo a blocchi con daRiga/aRiga).
2. Usa as400_source_refs sullo stesso membro per avere file usati (con modo di accesso), programmi chiamati, /COPY, data area, tabelle SQL e comandi CL.
3. Per ogni file usato rilevante usa as400_file_desc (campi e chiave) per capire i dati trattati.
4. Se il programma è compilato, as400_object_describe (tipo *PGM) mostra moduli e service program collegati.

Poi scrivi, in italiano:
- scopo del programma in 2-3 frasi;
- parametri di ingresso e uscita (PLIST / DCL-PI / PARM);
- flusso principale passo per passo, citando i numeri di riga;
- file letti e scritti, programmi chiamati;
- anomalie, codice morto, rischi (chiavi non univoche, gestione errori assente, SQL non parametrizzato).
Non inventare: se un'informazione non è nel sorgente o nei tool, dichiaralo.`;
}

export function promptDocumentaLibreria(lib: string, filtro?: string): string {
  const f = filtro ? ` limitandoti agli oggetti che iniziano con "${filtro}"` : '';
  return `Produci la documentazione della libreria ${lib} di un sistema IBM i${f}.

Procedi così:
1. as400_schema_list (filtro ${lib}) per descrizione e proprietario della libreria.
2. as400_object_list con tipo "*PGM *SRVPGM *CMD *DTAARA *DTAQ" per i programmi e gli oggetti eseguibili${filtro ? ` (filtro "${filtro}%")` : ''}.
3. as400_table_list per i file (fisici, logici, viste) e as400_source_list per i file sorgente.
4. Per i file più importanti (per descrizione o dimensione) usa as400_file_desc e as400_index_list.
5. Per i programmi principali usa as400_source_refs per capire chi chiama chi.
Gli elenchi sono limitati: se compare una nota di troncamento, restringi con i filtri invece di ignorarla.

Restituisci un documento Markdown in italiano con: panoramica, tabella dei programmi (nome, linguaggio, descrizione, sorgente), tabella dei file (nome, tipo, descrizione, chiave), mappa delle dipendenze principali e le aree poco documentate (oggetti senza descrizione).`;
}

export function promptAnalizzaFile(lib: string, file: string): string {
  return `Analizza il file ${lib}/${file} di un sistema IBM i.

1. as400_file_desc: tipo, campi, tipi e chiave.
2. as400_index_list: chiave del file e logici/indici/viste che ne dipendono.
3. as400_constraints e as400_where_used: vincoli, foreign key, trigger e oggetti che lo usano.
4. as400_sql_query con "SELECT * FROM ${lib}.${file}" per vedere alcuni record di esempio (il limite di righe è già applicato; chiedi al massimo 10 righe e non esporre dati personali nella risposta).
5. as400_source_search nella libreria con il nome del file per trovare i programmi che lo referenziano.

Spiega in italiano: cosa rappresenta il file, significato dei campi non ovvi (usa le descrizioni dei campi del catalogo), come si accede (chiavi e logici), chi lo legge e lo scrive, e cosa fare attenzione modificandolo.`;
}

export function promptDoveEUsato(lib: string, nome: string): string {
  return `Trova dove viene usato "${nome}" nella libreria ${lib} (può essere un file, un campo, un programma o una data area).

1. as400_column_search (campo "${nome}") per sapere se è un campo e in quali file compare.
2. as400_where_used (se è un file) per logici, viste, foreign key e trigger.
3. as400_source_search con testo "${nome}" per le righe di sorgente che lo citano; restringi con file/membro se i risultati sono troppi.
4. as400_object_list (filtro "${nome}%") per verificare se esiste come oggetto (programma, comando, data area).
5. Per i membri più rilevanti usa as400_source_refs per classificare l'uso (lettura, scrittura, chiamata).

Restituisci una tabella (membro, riga, tipo di uso: definizione / lettura / scrittura / chiamata) e un riepilogo in italiano dell'impatto di una modifica. Ricorda che l'analisi statica non vede le chiamate dinamiche: segnalalo.`;
}

export function promptAnalizzaSpool(utente?: string, file?: string, data?: string): string {
  const filtri = [utente && `utente ${utente}`, file && `nome ${file}`, data && `data ${data}`].filter(Boolean).join(', ') || 'i filtri indicati dall\'utente';
  return `Analizza gli spool IBM i per ${filtri}.

1. as400_spool_search con ${utente ? `utente "${utente}"` : 'i filtri disponibili'}${file ? `, file "${file}"` : ''}${data ? `, dal/al "${data}"` : ''} per individuare i file (sono ordinati dal più recente).
2. as400_spool_info sui file candidati per pagine, tipo dati e job.
3. as400_spool_read per leggere il contenuto (usa daPagina/aPagina sui file lunghi). Per le joblog (QPJOBLOG) cerca messaggi di errore, gravità alta e il programma che li ha generati.

Riassumi in italiano: cosa contiene ogni spool, eventuali errori con ID messaggio, causa probabile e azione consigliata. Per gli AFPDS ricorda che è estratto solo il testo e l'impaginazione non è riprodotta.`;
}

export function promptSpiegaStampa(lib: string, oggetto: string): string {
  return `Spiega la struttura del file di stampa o video ${lib}/${oggetto}.

1. as400_dds_describe con oggetto "${oggetto}" per formati, campi, posizioni (riga/colonna), costanti, indicatori e parole chiave. Controlla la nota: se il sorgente è stato modificato dopo la compilazione, segnalalo.
2. as400_object_describe (tipo *FILE) per descrizione e date.
3. as400_source_search (testo "${oggetto}") per i programmi che lo usano e as400_source_refs su quelli principali.
4. Se esistono spool prodotti da questo file (as400_spool_search con file "${oggetto}"), leggine uno con as400_spool_read per confrontare il risultato reale con il layout.

Descrivi in italiano il layout (anche come schema testuale a colonne per le stampe), i campi di ingresso/uscita, gli indicatori e i tasti funzione per i video.`;
}

export function promptInterrogaDati(lib: string, domanda: string, file?: string): string {
  const partenza = file ? `\nFile da cui partire: ${lib}/${file} (verifica comunque che sia quello giusto).` : '';
  return `Rispondi a una domanda sui dati del database di un sistema IBM i.

Domanda: "${domanda}"
Libreria dei dati: ${lib}${partenza}

Procedi così:
1. Individua i file giusti: as400_table_list (filtri su nome o testo della descrizione) e, se la domanda cita un concetto o un campo, as400_column_search (per nome o per testo). Le librerie hanno migliaia di file: usa i filtri.
2. Per ogni file candidato usa as400_file_desc: nomi di sistema dei campi, tipo, lunghezza, decimali, descrizioni e chiave. Non indovinare i nomi dei campi.
3. Se servono più file, ricava chiavi e relazioni con as400_index_list e as400_constraints, e verifica che il collegamento sia sensato prima di unirli.
4. Scrivi una SELECT (o WITH) alla volta, con nomi qualificati ${lib}.FILE, solo i campi necessari, un WHERE preciso e i valori passati come parametri (?) con l'argomento "parametri", non concatenati nel testo.
5. Se la domanda chiede un conteggio, un totale o una distribuzione, usa COUNT, SUM, GROUP BY e non leggere le righe. Per gli elenchi chiedi poche righe (FETCH FIRST 20 ROWS ONLY) e aumenta solo se serve.
6. Esegui con as400_sql_query e controlla il risultato: se il numero di righe o i valori non hanno senso, rivedi la query invece di commentarli.

Attenzione ai dati IBM i:
- le date sono spesso numeri (AAAAMMGG o CYYMMDD) o testo, non DATE: guarda il tipo del campo prima di confrontare o ordinare;
- i campi numerici (zoned, packed) hanno i decimali nel file_desc; nei risultati i numeri arrivano come stringhe;
- i campi di testo tornano senza spazi finali; per i confronti usa i valori esatti del campo;
- i nomi lunghi SQL possono differire dai nomi di sistema: usa quelli indicati da as400_file_desc;
- il server è in sola lettura: sono ammessi solo SELECT e WITH; il numero di righe è limitato e, se il risultato indica "troncato" o una nota, dillo nella risposta;
- se il server è configurato con una lista di librerie consentite, ogni tabella va qualificata con la libreria.

Dati personali: riporta solo ciò che serve a rispondere; se basta un aggregato non copiare record di persone.

Rispondi in italiano: prima la risposta alla domanda, poi la query usata (così si può verificare), le assunzioni fatte (per esempio come hai interpretato un campo) e i limiti (troncamenti, campi ambigui). Se i dati non ci sono o la domanda è ambigua, dillo e chiedi un chiarimento invece di inventare.`;
}

const msg = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer): void {
  const lib = completable(z.string().describe('Libreria'), (v) => completeLibrary(v));

  server.registerPrompt(
    'spiega_programma',
    {
      title: 'Spiega un programma',
      description: 'Legge e spiega un programma RPG/CL (scopo, parametri, flusso, file, chiamate, anomalie).',
      argsSchema: {
        libreria: lib,
        file: completable(z.string().describe('File sorgente (es. QRPGLESRC)'), (v, ctx) => completeSourceFile(ctx?.arguments?.libreria, v)),
        membro: completable(z.string().describe('Membro sorgente'), (v, ctx) => completeMember(ctx?.arguments?.libreria, ctx?.arguments?.file, v)),
      },
    },
    ({ libreria, file, membro }) => msg(promptSpiegaProgramma(libreria, file, membro)),
  );

  server.registerPrompt(
    'documenta_libreria',
    {
      title: 'Documenta una libreria',
      description: 'Produce un documento Markdown con programmi, file, dipendenze e lacune di una libreria.',
      argsSchema: { libreria: lib, filtro: z.string().optional().describe('Prefisso dei nomi da documentare (facoltativo)') },
    },
    ({ libreria, filtro }) => msg(promptDocumentaLibreria(libreria, filtro)),
  );

  server.registerPrompt(
    'analizza_file',
    {
      title: 'Analizza un file dati',
      description: 'Spiega un file: campi, chiavi, logici, vincoli, esempi di dati e chi lo usa.',
      argsSchema: {
        libreria: lib,
        file: completable(z.string().describe('Nome del file'), (v, ctx) => completeFile(ctx?.arguments?.libreria, v)),
      },
    },
    ({ libreria, file }) => msg(promptAnalizzaFile(libreria, file)),
  );

  server.registerPrompt(
    'dove_e_usato',
    {
      title: 'Dove è usato',
      description: 'Trova gli usi di un file, campo, programma o data area nei sorgenti e nel catalogo.',
      argsSchema: { libreria: lib, nome: z.string().describe('File, campo, programma o data area') },
    },
    ({ libreria, nome }) => msg(promptDoveEUsato(libreria, nome)),
  );

  server.registerPrompt(
    'analizza_spool',
    {
      title: 'Analizza spool e joblog',
      description: 'Trova e legge file di spool (anche joblog) e ne riassume contenuto ed errori.',
      argsSchema: {
        utente: z.string().optional().describe('Profilo utente'),
        file: z.string().optional().describe('Nome file di spool (es. QPJOBLOG)'),
        data: z.string().optional().describe('Data AAAA-MM-GG'),
      },
    },
    ({ utente, file, data }) => msg(promptAnalizzaSpool(utente, file, data)),
  );

  server.registerPrompt(
    'spiega_stampa',
    {
      title: 'Spiega un file di stampa o video',
      description: 'Descrive il layout di un PRTF/DSPF dal sorgente DDS e lo confronta con gli spool reali.',
      argsSchema: {
        libreria: lib,
        oggetto: completable(z.string().describe('File di stampa o video'), (v, ctx) => completeFile(ctx?.arguments?.libreria, v)),
      },
    },
    ({ libreria, oggetto }) => msg(promptSpiegaStampa(libreria, oggetto)),
  );

  server.registerPrompt(
    'interroga_dati',
    {
      title: 'Interroga i dati',
      description: 'Risponde a una domanda sui dati: trova i file e i campi giusti, scrive una SELECT di sola lettura, la esegue e riporta risposta, query e assunzioni.',
      argsSchema: {
        libreria: lib,
        domanda: z.string().describe('Domanda sui dati, in linguaggio naturale'),
        file: completable(z.string().optional().describe('File da cui partire (facoltativo)'), (v, ctx) => completeFile(ctx?.arguments?.libreria, v ?? '')),
      },
    },
    ({ libreria, domanda, file }) => msg(promptInterrogaDati(libreria, domanda, file)),
  );
}
