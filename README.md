# my-mcp-as400

Server MCP (stdio) **read-only** per collegare Claude Code a un sistema IBM i (AS/400):
sorgenti (RPG/CL/DDS), IFS, file fisici/logici via SQL, code di stampa.

Basato su `node-jt400` (JDBC JT400 via bridge Java): richiede **Node >= 22** e **un JDK/JRE Java**.

## Tool disponibili

| Tool | Descrizione |
|---|---|
| `as400_system_info` | utente connesso, sistema, limiti attivi |
| `as400_source_list` | file sorgente di una libreria / membri di un file sorgente |
| `as400_source_read` | testo di un membro sorgente (RPG, CL, DDS, ...) |
| `as400_source_search` | cerca un testo in tutti i membri sorgente di una libreria (righe trovate, con file/membro/riga) |
| `as400_source_refs` | analisi statica di un membro RPG/CL/DDS: file, programmi chiamati, copy, data area, tabelle SQL, comandi, chiavi |
| `as400_object_list` | oggetti di una libreria per tipo (*PGM, *SRVPGM, *CMD, *DTAARA, ...), con attributo e sorgente |
| `as400_object_describe` | dettaglio di un oggetto: moduli e service program collegati, sorgente di origine, valore di una data area |
| `as400_ifs_list` | directory IFS, anche in profondità (fino a 6 livelli) con filtro su nome e tipo |
| `as400_ifs_stat` | tipo, dimensione, proprietario, CCSID e data di un file o directory |
| `as400_ifs_read` | file di testo IFS; la finestra di righe è selezionata sul server |
| `as400_ifs_read_binary` | hexdump di un file IFS a partire da un offset (binari, PDF, CCSID 65535) |
| `as400_ifs_search` | ricerca di un testo nei file sotto una directory IFS |
| `as400_sql_query` | SELECT read-only su PF/LF e viste QSYS2 |
| `as400_file_desc` | descrizione PF/LF: campi, chiavi, tipo |
| `as400_spool_list` | code di una libreria (con numero di file) o spool di una coda, più recenti per primi |
| `as400_spool_search` | spool in tutte le code per utente, nome, job, USRDTA, stato, tipo, intervallo di date |
| `as400_spool_info` | attributi completi di uno spool (pagine, copie, form type, font, overlay, ...) |
| `as400_spool_read` | contenuto di uno spool (SCS, AFPDS, LINE, USERASCII) come testo, con `daPagina`/`aPagina` |
| `as400_dds_describe` | struttura di PF/LF/DSPF/PRTF dal sorgente DDS: formati, campi, posizioni, chiavi, parole chiave |

## Risorse MCP

Oltre ai tool, il server espone risorse che il client può allegare al contesto (con completamento di libreria, file e membro):

| URI | Contenuto |
|---|---|
| `as400://sistema` | utente, versione IBM i e limiti attivi (JSON) |
| `as400://source/{lib}/{file}/{member}` | testo di un membro sorgente, con le colonne originali |
| `as400://file/{lib}/{name}` | descrizione JSON di un file (campi, tipi, chiave DDS) |
| `as400://ifs/{percorso}` | file di testo IFS, es. `as400://ifs/home/profilo/script.sh` |
| `as400://spool/{lib}/{outq}/{file}/{numero}` | contenuto testuale di un file di spool |

Le risorse usano la stessa logica dei tool: valgono `ALLOWED_LIBS`, `IFS_ALLOWED_PREFIXES`, i limiti e l'audit.

## Prompt MCP

| Prompt | Cosa chiede al modello |
|---|---|
| `spiega_programma` | leggere un sorgente RPG/CL, analizzarne i riferimenti e spiegarne scopo, flusso e anomalie |
| `documenta_libreria` | produrre un documento Markdown con programmi, file e dipendenze di una libreria |
| `analizza_file` | spiegare un file: campi, chiavi, logici, vincoli, dati di esempio, chi lo usa |
| `dove_e_usato` | trovare gli usi di un file, campo, programma o data area |
| `analizza_spool` | trovare e leggere spool e joblog, riassumere gli errori |
| `spiega_stampa` | descrivere il layout di un PRTF/DSPF e confrontarlo con gli spool reali |

## Configurazione

```bash
cp .env.example .env
chmod 600 .env          # le credenziali restano locali
# compila AS400_HOST / AS400_USER / AS400_PASSWORD
```

Variabili opzionali: `SQL_MAX_ROWS`, `SOURCE_MAX_LINES`, `IFS_MAX_LINES`, `IFS_MAX_CHARS`,
`SPOOL_MAX_FILES`, `SPOOL_MAX_CHARS`, `SOURCE_MAX_CHARS`, `SOURCE_MAX_MEMBERS`, `SPOOL_CHARSET` (charset ASCII del testo degli spool dopo la conversione, default `cp850`), `SPOOL_WSCST` (oggetto WSCST per la conversione, default `/QSYS.LIB/QWPDEFAULT.WSCST`), `SPOOL_MAX_READ_BYTES`, `ALLOW_QTEMP_ALIAS`, `SQL_TIMEOUT_MS`, `SEARCH_TIMEOUT_MS`, `SEARCH_MAX_MEMBERS`, `IFS_BINARY_MAX_BYTES`, `IFS_SEARCH_MAX_FILES`, `AUDIT_LOG`, `ALLOWED_LIBS` (lista librerie
consentite), `IFS_ALLOWED_PREFIXES` (prefissi percorso IFS consentiti), `AS400_JDBC_EXTRA`
(extraproperties JDBC in formato `chiave=valore&chiave=valore`).

## Build e test connessione

```bash
npm install     # richiede build-essential (make/gcc) per compilare il bridge java
npm run build
npm run test:connection
npm test            # test unitari (non richiedono connessione)
npm run typecheck
npm run test:e2e    # avvia il server e lo prova con un client MCP (richiede la connessione all'IBM i)
```

## Integrazione con Claude Code

```bash
claude mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js
```

oppure in `.mcp.json` del progetto:

```json
{
  "mcpServers": {
    "as400": {
      "command": "node",
      "args": ["<path-to-inst-folder>/my-mcp-as400/dist/index.js"]
    }
  }
}
```

Le credenziali vengono lette dal `.env` della directory del server (`dotenv`).

## Note di sicurezza

Difesa a strati:

1. **Connessione JDBC `access=read only`**: il server IBM i rifiuta ogni scrittura (verificato: `CREATE`, `CALL`).
2. **Guardia SQL lessicale** (`src/sqlguard.ts`): tokenizza la query ignorando commenti e stringhe, ammette
   solo `SELECT`/`WITH`, vieta DML/DDL/`CALL`, `FINAL TABLE`, `QCMDEXC`, e le funzioni IFS/spool
   (`IFS_READ`, `SPOOLED_FILE_DATA`, ...) che hanno tool dedicati con i propri controlli.
3. **`ALLOWED_LIBS` sulla SQL**: ogni tabella in `FROM`/`JOIN` deve essere qualificata (`LIB.TABELLA`) con una
   libreria consentita; i cataloghi `QSYS2`, `SYSIBM`, `SYSIBMADM`, `SYSTOOLS` restano leggibili (solo metadati).
4. **Limiti**: righe, caratteri, timeout (`SQL_TIMEOUT_MS`).
5. **Audit**: ogni chiamata è registrata come JSON su stderr e, se `AUDIT_LOG` è impostato, su file
   (i parametri SQL non vengono registrati).

Il solo punto che usa una connessione non read-only è `as400_source_read` (alias temporaneo in QTEMP),
con istruzioni fisse e nomi validati.

Con `IFS_ALLOWED_PREFIXES` attivo i **collegamenti simbolici non vengono seguiti**: prima di leggere, il server
verifica che nessun componente del percorso, dal prefisso consentito in giù, sia un `*SYMLNK`
(un link dentro l'area consentita potrebbe puntare fuori). Nei risultati i link sono omessi.
La ricerca IFS non opera nei file system speciali (`/QSYS.LIB`, `/QDLS`, ...).

Altre misure:

- Server **solo lettura**: la `as400_sql_query` accetta solo `SELECT`/`WITH`, rifiuta
  statement multipli e `FOR UPDATE`; nessun tool di scrittura o esecuzione CL.
- L'accesso può essere ristretto con `ALLOWED_LIBS` e `IFS_ALLOWED_PREFIXES`.
- Consigliato un profilo IBM i dedicato con autorità minime di lettura.
