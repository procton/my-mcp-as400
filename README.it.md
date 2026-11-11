# my-mcp-as400

**Lingua / Language:** [English](README.md) · Italiano

Server MCP (stdio) **read-only** per collegare un assistente AI a un sistema IBM i (AS/400):
sorgenti (RPG/CL/DDS), IFS, file fisici/logici via SQL, code di stampa.
Si collega a qualunque client MCP su stdio; sono documentati [Claude Code](#claude-code),
[Codex](#codex) e [OpenCode](#opencode).

Basato su `node-jt400` (JDBC JT400 via bridge Java): richiede **Node >= 22** e **un JDK/JRE Java**.
Testato su **IBM i 7.4**. Per verificare la compatibilità con altra versioni, utilizzare il comando **npm run test:e2e**

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
| `as400_schema_list` | librerie/schemi con descrizione e proprietario |
| `as400_table_list` | file di una libreria: PF/tabelle, LF, viste, sorgenti; filtri su nome, tipo e descrizione |
| `as400_column_search` | ricerca campi per nome (breve/lungo) o testo in una libreria |
| `as400_index_list` | chiave DDS di un file, logici/indici/viste che lo usano, con chiavi e formato record |
| `as400_where_used` | dipendenze di un file: logici, viste, foreign key figlie, trigger |
| `as400_view_def` | definizione SQL di una vista |
| `as400_constraints` | PK, univoci, check, foreign key |
| `as400_routine_list` | procedure e funzioni SQL/esterne di una libreria |
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
| `interroga_dati` | rispondere a una domanda sui dati: trovare file e campi giusti, scrivere una SELECT di sola lettura, eseguirla e riportare risposta, query e assunzioni |
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

## Integrazione con i client MCP

Il server parla MCP su stdio, quindi funziona con qualunque client che sappia avviare un processo locale.
In tutti gli esempi `<path-to-inst-folder>` è la cartella in cui hai installato il progetto.

**Prima di collegare un client:**

1. `npm install` e `npm run build` (i client avviano `dist/index.js`, che va ricompilato dopo ogni modifica al codice);
2. crea e compila il `.env` come descritto in [Configurazione](#configurazione);
3. verifica la connessione con `npm run test:connection`.

**Credenziali.** Vengono lette dal `.env` nella cartella del progetto (accanto a `package.json`), indipendentemente dalla
directory da cui il client avvia il server; se non c'è, dal `.env` della directory corrente. Le variabili già presenti
nell'ambiente hanno la precedenza. Non serve quindi passare password al client, né scriverle nelle sue configurazioni.

**Percorso di `node`.** Se Node è installato con `nvm`/`fnm`, il client potrebbe non vedere la stessa versione della tua shell:
in quel caso metti nei comandi il percorso assoluto del binario (`command -v node`) al posto di `node`. Serve Node >= 22.

### Claude Code

```bash
claude mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js
claude mcp list
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

### Codex

Codex CLI legge i server MCP da `~/.codex/config.toml`. Per attivarlo:

```bash
codex mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js
codex mcp list
```

oppure, a mano, in `~/.codex/config.toml`:

```toml
[mcp_servers.as400]
command = "node"
args = ["<path-to-inst-folder>/my-mcp-as400/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 300
```

`tool_timeout_sec` è il tempo massimo per una singola chiamata a un tool. Alcune operazioni del server (`as400_source_search`,
`as400_ifs_search`, letture di librerie molto grandi) possono durare più di un minuto, e il server ha un proprio limite di
180 secondi (`SEARCH_TIMEOUT_MS`): tieni `tool_timeout_sec` almeno a quel valore, altrimenti Codex interrompe la chiamata prima.

### OpenCode

Il modo più semplice è il comando di OpenCode, che scrive la configurazione al posto tuo:

```bash
# solo per il progetto corrente (scrive opencode.json nella cartella)
opencode mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js

# per tutti i progetti (configurazione globale)
opencode mcp add --global as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js

opencode mcp list
```

Con OpenCode 2.2.0 il comando produce questa voce:

```json
{
  "mcp": {
    "servers": {
      "as400": {
        "type": "local",
        "command": ["node", "<path-to-inst-folder>/my-mcp-as400/dist/index.js"]
      }
    }
  }
}
```

Alcune guide mostrano un formato diverso (`"mcp": { "as400": { "type": "local", "command": [...] } }`, senza il livello
`servers`). Se modifichi il file a mano, usa il formato scritto dal comando `opencode mcp add` della *tua* versione.

### Cosa funziona con ciascun client

- **Tool (27).** Sono la parte standard di MCP e quella che ogni client deve supportare.
- **Risorse e prompt.** Il loro supporto dipende dal client. Se il tuo non li mostra, non manca nessuna funzione: ogni
  risorsa ha un tool equivalente.

  | Risorsa | Tool equivalente |
  |---|---|
  | `as400://sistema` | `as400_system_info` |
  | `as400://source/{lib}/{file}/{member}` | `as400_source_read` |
  | `as400://file/{lib}/{name}` | `as400_file_desc` |
  | `as400://ifs/{percorso}` | `as400_ifs_read` |
  | `as400://spool/{lib}/{outq}/{file}/{numero}` | `as400_spool_read` |

  I prompt sono istruzioni di lavoro riusabili (quali tool chiamare e in che ordine): senza supporto ai prompt puoi scrivere
  la stessa richiesta a mano.

**Stato della verifica.** Il protocollo (tool, risorse, completamenti, prompt) è verificato con un client MCP di prova
(`npm run test:e2e`, basato sull'SDK ufficiale), avviando il server da una directory diversa da quella del progetto.
La sintassi di configurazione di Codex 0.167.0 è stata verificata con il suo stesso comando `codex mcp list`.
Il collegamento con ciascun client reale, con un modello che chiama i tool, non è stato provato; per OpenCode non è stato
possibile confermare come il comando `list` legga la voce scritta da `add`. Se qualcosa non funziona vedi la
[guida ai problemi](docs/RISOLUZIONE-PROBLEMI.md#3-il-server-non-compare-o-non-risponde-nel-client-mcp).

## Problemi

Per installazione, connessione, autorità, messaggi di errore dei tool, caratteri sbagliati, lentezza e compatibilità con la 7.3
vedi la [guida alla risoluzione dei problemi](docs/RISOLUZIONE-PROBLEMI.md).

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
