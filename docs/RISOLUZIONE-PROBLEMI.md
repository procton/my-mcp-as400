# Risoluzione dei problemi

Guida ai problemi più comuni di `my-mcp-as400`. Torna al [README](../README.md).

Le soluzioni qui sotto vengono da casi incontrati durante lo sviluppo, verificati su un IBM i V7R4. Dove una cosa non è stata
provata su altre release (in particolare la 7.3) è detto esplicitamente.

## Indice

1. [Da dove cominciare](#1-da-dove-cominciare)
2. [Installazione e avvio](#2-installazione-e-avvio)
3. [Il server non compare o non risponde in Claude Code](#3-il-server-non-compare-o-non-risponde-in-claude-code)
4. [Connessione e credenziali](#4-connessione-e-credenziali)
5. [Autorità e "non trovato"](#5-autorità-e-non-trovato)
6. [Messaggi di errore dei tool](#6-messaggi-di-errore-dei-tool)
7. [Contenuti sbagliati: caratteri, spazi, numeri](#7-contenuti-sbagliati-caratteri-spazi-numeri)
8. [Lentezza e timeout](#8-lentezza-e-timeout)
9. [Release IBM i precedenti alla 7.4](#9-release-ibm-i-precedenti-alla-74)
10. [Come segnalare un problema](#10-come-segnalare-un-problema)

---

## 1. Da dove cominciare

Tre comandi, in ordine, dicono quasi sempre dove sta il problema:

```bash
npm run build            # compila: se fallisce, il problema è l'installazione (sezione 2)
npm run test:connection  # prova la connessione e l'accesso al catalogo QSYS2 (sezioni 4 e 5)
npm run test:e2e         # avvia il server vero e lo prova con un client MCP, da un'altra directory
```

`test:e2e` usa alcuni oggetti del sistema di sviluppo (librerie `TSTPGMR` e `TST90DAT`): su un altro sistema alcuni controlli
falliranno solo perché quegli oggetti non esistono. I controlli sulla struttura (numero di tool, risorse, prompt, rifiuto di
un `DELETE`) restano validi.

**Dove sono i log.** Il server scrive solo su `stderr`, perché `stdout` è riservato al protocollo MCP. Ogni chiamata a un tool
produce una riga `my-mcp-as400 audit {...}` con nome del tool, argomenti, durata ed esito. Per tenerle in un file imposta
`AUDIT_LOG=/percorso/audit.log` nel `.env`. In Claude Code usa `claude mcp list` per lo stato del server e `/mcp` nella sessione.

---

## 2. Installazione e avvio

### `npm install` fallisce nella compilazione di `java`

`node-jt400` usa il modulo nativo `java` (un ponte verso la JVM), che va compilato. Servono:

- un compilatore e `make` (su Debian/Ubuntu: `sudo apt install build-essential`);
- Python 3 (richiesto da `node-gyp`);
- un **JDK** (non basta il JRE) con `JAVA_HOME` valido.

```bash
java -version            # deve rispondere
echo "$JAVA_HOME"        # deve puntare al JDK
```

Se l'installazione è già avvenuta con il JDK sbagliato, dopo averlo corretto: `rm -rf node_modules && npm install`.
Il progetto è stato provato con Node 22 e OpenJDK 21. Il `package.json` richiede Node ≥ 22.

### `Variabile ambiente mancante: AS400_HOST (vedi .env.example)`

Il `.env` non è stato trovato o è incompleto. Il server lo cerca **prima nella cartella del progetto** (quella con `package.json`,
indipendentemente da dove viene avviato) e poi nella directory corrente. Quindi:

```bash
cp .env.example .env
chmod 600 .env
# compila AS400_HOST, AS400_USER, AS400_PASSWORD
```

Le variabili già presenti nell'ambiente del processo hanno la precedenza sul `.env`.

### `NoClassDefFoundError: com/ibm/as400/access/AS400`

Compare solo negli script di prova che importano `java` direttamente. Il classpath con `jt400.jar` viene configurato quando si crea
il pool di `node-jt400`: in uno script proprio chiama prima `getPool()` (o una qualsiasi query) e importa `java` dopo.
Il server vero non è interessato.

### Lo script non termina

La JVM mantiene vivo il processo. Negli script di prova chiudi con `process.exit(0)`, come fanno `scripts/test-connection.ts`
e `scripts/e2e.ts`. Il server gestisce da solo `SIGINT`/`SIGTERM` chiudendo i pool.

---

## 3. Il server non compare o non risponde in Claude Code

Registra il server con il percorso **assoluto** del file compilato:

```bash
npm run build
claude mcp add as400 -- node /percorso/assoluto/my-mcp-as400/dist/index.js
claude mcp list
```

Controlla in ordine:

- **`dist/` non esiste o è vecchio.** Il server usa `dist/index.js`: dopo ogni modifica al codice serve `npm run build`.
- **`node` non è quello giusto.** Con `nvm`/`fnm` il `node` visto da Claude Code può non essere Node 22. Usa il percorso assoluto
  del binario (`which node`) al posto di `node` nel comando.
- **Il `.env` non viene trovato.** Con la versione attuale non dipende dalla directory di avvio (vedi sezione 2). Se hai una versione
  precedente, aggiorna: usava solo la directory corrente.
- **Qualcosa scrive su `stdout`.** Rompe il protocollo MCP (sintomo: il server si avvia ma i tool non rispondono o la connessione
  cade). Il server non scrive nulla su `stdout`; se aggiungi un `console.log` usa `console.error`.
- **Primo avvio lento.** L'avvio della JVM e la prima connessione richiedono 2-3 secondi: la prima chiamata è più lenta delle successive.

Per provare il server a mano, senza Claude Code, usa `npm run test:e2e`.

---

## 4. Connessione e credenziali

| Sintomo | Causa probabile | Cosa fare |
|---|---|---|
| Timeout o `Unable to connect` all'avvio della prima query | Host non raggiungibile o Host Server non attivi | `ping` dell'host. Sull'IBM i: `STRHOSTSVR SERVER(*ALL)` e verifica che i server *DATABASE e *SIGNON siano attivi (porte 8471 e 8476; con SSL 9471 e 9476). |
| `[CPF22E2]`, `[CPF22E3]`, `Password not correct`, errori di autenticazione | Utente o password sbagliati, profilo disabilitato o password scaduta | Prova gli stessi dati con una sessione 5250. `DSPUSRPRF` mostra stato e scadenza. |
| `Connection authorization failure occurred` | Un'istruzione di scrittura (per esempio `CREATE ALIAS` o `CALL`) è stata eseguita sul pool principale, che è `access=read only` | È voluto: il server è di sola lettura e il server IBM i rifiuta la scrittura. I tool legittimi non la tentano; se compare, indica quasi sempre una query non prevista. Vedi sezione 6. |
| `Timeout (60000 ms) su query SQL` | Query o catalogo lenti | Sezione 8. |

**SSL.** Per una connessione cifrata aggiungi al `.env`:

```
AS400_JDBC_EXTRA=secure=true
```

`AS400_JDBC_EXTRA` accetta più proprietà nel formato `chiave=valore&chiave=valore` (proprietà JDBC del driver JT400).
Con certificati non riconosciuti dal JDK, importali nel truststore Java.

---

## 5. Autorità e "non trovato"

Molti tool restituiscono un risultato vuoto o "non trovato" sia quando l'oggetto non esiste sia quando il profilo non ha
l'autorità per vederlo. Il messaggio lo dice: `directory vuota, inesistente o senza autorità`,
`Percorso non trovato o senza autorità`. Se sospetti un problema di autorità, prova con una sessione 5250 con lo stesso profilo.

Autorità che il profilo dedicato deve avere in sola lettura:

| Per usare | Serve |
|---|---|
| Cataloghi SQL (`SYSTABLES`, `SYSCOLUMNS`, `SYSPARTITIONSTAT`, ...) | Il profilo vede solo gli oggetti su cui ha autorità: librerie non autorizzate risultano vuote. |
| `as400_index_list`, `as400_where_used` | Lettura su `QSYS/QADBFDEP`, `QADBKFLD` e `QADBXREF` (le tabelle usate da `DSPDBR`). Se mancano, `where_used` riporta l'errore nella sezione interessata invece di fallire del tutto. |
| Sorgenti | `*USE` sul file sorgente e sulla libreria. |
| IFS | Lettura sulle directory e sui file. |
| Spool | Autorità sulla coda di stampa (`*READ`) e, per leggere il contenuto, sullo spool: proprietario, `*SPLCTL` o `*JOBCTL` secondo la configurazione della coda. |
| `as400_spool_read` | Che l'oggetto WSCST indicato da `SPOOL_WSCST` esista e sia leggibile (default `/QSYS.LIB/QWPDEFAULT.WSCST`). |

Un controllo rapido da `test:connection` o da `as400_sql_query`:

```sql
SELECT COUNT(*) FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = 'LIBRERIA'
```

---

## 6. Messaggi di errore dei tool

### Restrizioni configurate dall'amministratore

| Messaggio | Significato | Soluzione |
|---|---|---|
| `Libreria non consentita (ALLOWED_LIBS): X` | `ALLOWED_LIBS` è impostato e X non c'è | Aggiungi X a `ALLOWED_LIBS` oppure svuota la variabile. |
| `Con ALLOWED_LIBS attivo ogni tabella/funzione va qualificata con la libreria (LIB.TABELLA)` | Con la lista attiva, la SQL non può usare nomi senza libreria | Scrivi `LIB.TABELLA` per ogni tabella in `FROM`/`JOIN`. I cataloghi `QSYS2`, `SYSIBM`, `SYSIBMADM`, `SYSTOOLS` sono sempre ammessi. |
| `Percorso IFS non consentito (IFS_ALLOWED_PREFIXES=...)` | Il percorso è fuori dai prefissi consentiti | Aggiungi il prefisso a `IFS_ALLOWED_PREFIXES` o usa un percorso interno. |
| `... è un collegamento simbolico (non seguito con IFS_ALLOWED_PREFIXES attivo)` | Un componente del percorso è un link simbolico | È voluto: un link potrebbe puntare fuori dall'area consentita. Usa il percorso reale di destinazione, se rientra nei prefissi. |

### Sola lettura

| Messaggio | Significato |
|---|---|
| `Ammesse solo istruzioni SELECT o WITH (server read-only)` | `as400_sql_query` accetta solo `SELECT` e `WITH`. |
| `Parola chiave non consentita (server read-only): X` | La query contiene `INSERT`, `UPDATE`, `DELETE`, `CALL`, `CREATE`, `DROP`, ... |
| `Oggetto/funzione non consentita in sql_query: IFS_READ` | `IFS_*`, `SPOOLED_FILE_DATA` e `QCMDEXC` sono bloccati nella SQL libera, perché hanno tool dedicati con i propri controlli. Usa `as400_ifs_read`, `as400_spool_read`, ... |
| `Un solo statement SQL, senza punto e virgola` | Una sola istruzione per chiamata. |
| `Commento SQL non terminato` / `Stringa SQL non terminata` | Apici o `/* ... */` non chiusi nella query. |

### Sorgenti

| Messaggio | Soluzione |
|---|---|
| `La lettura dei membri richiede alias temporanei: imposta ALLOW_QTEMP_ALIAS=true` | `ALLOW_QTEMP_ALIAS` è `false`. Rimettilo a `true` o non usare `source_read`, `source_search`, `source_refs`, `dds_describe`. |
| `Membro o file sorgente non trovato: LIB/FILE(MEMBRO)` | Verifica i nomi con `as400_source_list`. |
| `ZZZ in *N di tipo *MEM non trovato` (messaggio SQL grezzo) | Membro inesistente in versioni che non rimappano l'errore: stesso significato. |

### Spool

| Messaggio | Soluzione |
|---|---|
| `Più file di spool col nome X: specifica 'numero'` | Il messaggio elenca i numeri più recenti. Aggiungi `numero`, oppure `utente` o `job`. |
| `File di spool non trovato` | Controlla libreria e coda con `as400_spool_search`. Lo spool può essere stato cancellato. |
| `Conversione dello spool non riuscita (...). Verifica SPOOL_WSCST=...` | L'oggetto WSCST non esiste o non è leggibile: imposta `SPOOL_WSCST` con un WSCST valido (`DSPOBJD OBJ(QSYS/QWPDEFAULT) OBJTYPE(*WSCST)`). |
| `Indica almeno un filtro ...` (`spool_search`) | La scansione di tutte le code è lenta: indica utente, nome, job, data o libreria. |

### Altri

| Messaggio | Soluzione |
|---|---|
| `Timeout (N ms) su ...: operazione abbandonata` | Sezione 8. Il timeout interrompe l'attesa del server MCP, non necessariamente il lavoro sul sistema. |
| `... non valido: 'x' (max 10 caratteri [A-Z0-9_$#@])` | I nomi oggetto sono di massimo 10 caratteri e non ammettono spazi né punti. I nomi lunghi SQL non sono accettati dai tool per oggetti. |
| `Percorso IFS non valido (deve essere assoluto)` o `componente '..' vietata` | Usa percorsi assoluti senza `..`. |
| `Tipo oggetto non valido: 'x'` | I tipi si scrivono con l'asterisco: `*PGM`, `*SRVPGM`, `*DTAARA`. |
| `La ricerca non è disponibile nei file system speciali` | In `/QSYS.LIB`, `/QDLS`, ... usa `as400_source_search` e `as400_object_list`. |

---

## 7. Contenuti sbagliati: caratteri, spazi, numeri

### Lettere accentate sbagliate negli spool

Il testo degli spool arriva dal server in ASCII; il default `SPOOL_CHARSET=cp850` è quello di `QWPDEFAULT` sul sistema di sviluppo
(`è`, `à`, `ù` corretti). Se vedi caratteri sbagliati (`Ô` al posto di `È`, `?` o riquadri), il tuo WSCST usa un'altra
tabella: prova `SPOOL_CHARSET=latin1` (ISO-8859-1/Windows-1252) o `utf-8`.

### Lettere sbagliate nei file IFS

`as400_ifs_read` decodifica secondo il CCSID con cui è marcato il file. Se il tag è errato (per esempio un file UTF-8 marcato 37):

- usa `utf8: true` per forzare la decodifica UTF-8;
- verifica il tag con `as400_ifs_stat` (campo `ccsid`).

Un file con `CCSID 65535` è binario: `as400_ifs_read` non restituisce testo leggibile, usa `as400_ifs_read_binary`.

### Spool AFPDS "incollati"

Per gli `*AFPDS` il server estrae solo il testo, senza le posizioni: righe e colonne possono risultare adiacenti o unite.
Non si ricostruisce l'impaginazione. Per il layout usa `as400_dds_describe` sul file di stampa e, se il documento è prodotto da un
form definition/overlay, ispeziona quelli sul sistema. Gli `*SCS` sono invece resi con gli a-capo corretti e le pagine separate.

### Colonne dei sorgenti RPG "spostate"

Le versioni iniziali del progetto perdevano gli spazi iniziali (RPG fixed-format: la colonna 6 è il tipo di specifica). Ora
`source_read`, `ifs_read` e `sql_query` li conservano. Se vedi ancora sorgenti spostati, controlla di avere una versione recente
(`git log`) e di aver rifatto `npm run build`.

### Tutti i numeri sono stringhe

`"numero": "15"`, `"pagine": "3"`: il driver JDBC restituisce i numeri come stringhe. È il comportamento atteso; in input i
parametri numerici (`numero`, `daRiga`, `limite`, ...) restano numeri.

### Righe sorgente o campi troncati

I limiti (`SQL_MAX_ROWS`, `SOURCE_MAX_LINES`, `IFS_MAX_LINES`, `SPOOL_MAX_FILES`, `SPOOL_MAX_CHARS`, ...) tagliano le risposte e lo
dichiarano in una `nota` nel risultato. Usa `daRiga`/`aRiga`, `daPagina`/`aPagina` e i filtri, oppure alza il limite nel `.env`.

---

## 8. Lentezza e timeout

Le librerie di produzione hanno migliaia di oggetti e alcune viste di catalogo sono lente. Cosa aiuta:

- **Filtra sempre.** `as400_table_list`, `as400_object_list` e `as400_column_search` hanno filtri su nome, tipo e testo.
  Un'elencazione di tutti i `*FILE` di una libreria da 8000 file può superare i 60 secondi; con un prefisso (`filtro: "AB%"`)
  `as400_object_list` lo passa all'API come nome generico e risponde in frazioni di secondo.
- **`as400_column_search` richiede almeno `campo` o `testo`**, per lo stesso motivo.
- **`as400_source_search`** impiega circa 0,5 secondi per membro (creazione dell'alias più scansione). Restringi con `file` e
  `membro`; il tetto di default è `SEARCH_MAX_MEMBERS=150` e il limite di tempo è `SEARCH_TIMEOUT_MS=180000`.
- **`as400_ifs_search`** è limitata da `IFS_SEARCH_MAX_FILES`, dalla profondità (default 3) e dalla dimensione massima per file.
  Salta i file binari e quelli molto grandi.
- **`as400_ifs_list` su directory molto popolate** richiede una chiamata per directory (circa 1 secondo, di più con centinaia di voci).
- **Timeout generale.** `SQL_TIMEOUT_MS` (default 60000) vale per ogni query; `SEARCH_TIMEOUT_MS` per le ricerche.
  Alzarli è l'ultima risorsa: prima restringi la richiesta.
- **`as400_ifs_read_binary` a offset molto alti** in file da centinaia di MB è lento perché il server legge dall'inizio.

Il timeout abbandona l'attesa lato server MCP; la query sul sistema può continuare fino alla fine (o alla chiusura della
connessione per il `socket timeout`). Un lavoro SQL lungo si vede con `WRKACTJOB` (lavori `QZDASOINIT`) e si ferma con `ENDJOB`.

---

## 9. Release IBM i precedenti alla 7.4

Il progetto è stato sviluppato e provato su **V7R4**. L'obiettivo di compatibilità è dalla 7.3 in poi, ma queste funzioni non
sono state provate sulla 7.3 e vanno verificate prima dell'uso:

| Usata da | Funzione o oggetto | Se manca |
|---|---|---|
| `as400_ifs_read_binary` | `QSYS2.IFS_READ_BINARY` | Errore SQL di routine non trovata (tipicamente `SQL0204`) sul tool; il resto dell'IFS funziona. |
| `as400_ifs_search`, `as400_ifs_read` | `QSYS2.IFS_READ` con `IGNORE_ERRORS` | Come sopra; `ifs_read` base può comunque funzionare. |
| `as400_ifs_list`, `as400_ifs_stat` | `QSYS2.IFS_OBJECT_STATISTICS` | Idem. |
| `as400_spool_*` | `QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC` e `OUTPUT_QUEUE_INFO` | Il tool riporta `SQL0204` sulla vista mancante. |
| `as400_object_describe` | `QSYS2.PROGRAM_INFO`, `BOUND_MODULE_INFO`, `BOUND_SRVPGM_INFO`, `DATA_AREA_INFO` | Le sezioni corrispondenti riportano un `errore`, il resto del risultato resta. |
| `as400_routine_list` | `QSYS2.SYSROUTINES` | Idem. |
| `as400_spool_read` | Oggetto WSCST `QWPDEFAULT` | Imposta `SPOOL_WSCST`. |

Per sapere cosa c'è sul tuo sistema:

```sql
-- funzioni di servizio disponibili
SELECT ROUTINE_NAME FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = 'QSYS2' AND ROUTINE_NAME LIKE 'IFS_%';
-- viste disponibili
SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2' AND TABLE_NAME LIKE 'OUTPUT_QUEUE%';
```

Se una funzione di servizio manca, di solito si risolve aggiornando il gruppo PTF *Db2 for i*, che porta i servizi SQL: sulla 7.4 è
`SF99704` (verificato sul sistema di sviluppo, livello 19); sulla 7.3 dovrebbe essere `SF99703`, secondo la convenzione IBM, ma non è stato
verificato. Il livello del gruppo determina quali funzioni sono disponibili.

---

## 10. Come segnalare un problema

Allega, senza password:

1. versione IBM i (`as400_system_info`, campo `sistema.versione`), versione di Node (`node -v`) e del JDK (`java -version`);
2. il comando eseguito e il messaggio completo;
3. la riga `audit` corrispondente (stderr o `AUDIT_LOG`), che riporta tool, argomenti ed esito;
4. se il problema è nei risultati: il tool, gli argomenti e il tipo di oggetto (CCSID, tipo di spool, tipo di sorgente).

Non allegare il `.env`: contiene le credenziali.
