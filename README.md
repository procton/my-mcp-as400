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
| `as400_ifs_list` | contenuto di una directory IFS |
| `as400_ifs_read` | file di testo IFS |
| `as400_sql_query` | SELECT read-only su PF/LF e viste QSYS2 |
| `as400_file_desc` | descrizione PF/LF: campi, chiavi, tipo |
| `as400_spool_list` | file di spool per outq / utente / filtro |
| `as400_spool_read` | contenuto testuale di un file di spool |

## Configurazione

```bash
cp .env.example .env
chmod 600 .env          # le credenziali restano locali
# compila AS400_HOST / AS400_USER / AS400_PASSWORD
```

Variabili opzionali: `SQL_MAX_ROWS`, `SOURCE_MAX_LINES`, `IFS_MAX_LINES`, `IFS_MAX_CHARS`,
`SPOOL_MAX_FILES`, `SPOOL_MAX_CHARS`, `SOURCE_MAX_CHARS`, `SOURCE_MAX_MEMBERS`, `SPOOL_CHARSET` (charset Java degli spool, default `IBM-273`), `ALLOW_QTEMP_ALIAS`, `ALLOWED_LIBS` (lista librerie
consentite), `IFS_ALLOWED_PREFIXES` (prefissi percorso IFS consentiti), `AS400_JDBC_EXTRA`
(extraproperties JDBC in formato `chiave=valore&chiave=valore`).

## Build e test connessione

```bash
npm install     # richiede build-essential (make/gcc) per compilare il bridge java
npm run build
npm run test:connection
npm test            # test unitari (non richiedono connessione)
npm run typecheck
```

## Integrazione con Claude Code

```bash
claude mcp add as400 -- node /home/paogia/MCP/my-mcp-as400/dist/index.js
```

oppure in `.mcp.json` del progetto:

```json
{
  "mcpServers": {
    "as400": {
      "command": "node",
      "args": ["/home/paogia/MCP/my-mcp-as400/dist/index.js"]
    }
  }
}
```

Le credenziali vengono lette dal `.env` della directory del server (`dotenv`).

## Note di sicurezza

- Server **solo lettura**: la `as400_sql_query` accetta solo `SELECT`/`WITH`, rifiuta
  statement multipli e `FOR UPDATE`; nessun tool di scrittura o esecuzione CL.
- L'accesso può essere ristretto con `ALLOWED_LIBS` e `IFS_ALLOWED_PREFIXES`.
- Consigliato un profilo IBM i dedicato con autorità minime di lettura.
