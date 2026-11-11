# Troubleshooting

**Language:** English · [Italiano](RISOLUZIONE-PROBLEMI.md)

Guide to the most common problems with `my-mcp-as400`. Back to the [README](../README.md).

The solutions below come from cases met during development, verified on an IBM i V7R4. Where something has not been tried on
other releases (in particular 7.3) it is stated explicitly.

> **About names and messages.** The server's language is chosen with `LOCALE` in the `.env` (`EN` by default, or `IT`).
> This guide uses the English names (tools are always `as400_*`; parameters such as `library`, `fromLine`; result keys such as `note`)
> and quotes the English messages. With `LOCALE=IT` names and messages are Italian: see the Italian guide
> ([RISOLUZIONE-PROBLEMI.md](RISOLUZIONE-PROBLEMI.md)) and the name table in the [README](../README.md#language-locale).
> Messages that come from IBM i itself (SQL errors, `CPF` messages) are in the language of the job on the server, whatever `LOCALE` is.

## Contents

1. [Where to start](#1-where-to-start)
2. [Installation and startup](#2-installation-and-startup)
3. [The server does not appear or does not respond in the MCP client](#3-the-server-does-not-appear-or-does-not-respond-in-the-mcp-client)
4. [Connection and credentials](#4-connection-and-credentials)
5. [Authorities and "not found"](#5-authorities-and-not-found)
6. [Tool error messages](#6-tool-error-messages)
7. [Wrong content: characters, spaces, numbers](#7-wrong-content-characters-spaces-numbers)
8. [Slowness and timeouts](#8-slowness-and-timeouts)
9. [IBM i releases earlier than 7.4](#9-ibm-i-releases-earlier-than-74)
10. [How to report a problem](#10-how-to-report-a-problem)

---

## 1. Where to start

Three commands, in order, almost always show where the problem is:

```bash
npm run build            # compiles: if it fails, the problem is the installation (section 2)
npm run test:connection  # tests the connection and access to the QSYS2 catalog (sections 4 and 5)
npm run test:e2e         # starts the real server and exercises it with an MCP client, from another directory
```

`test:e2e` uses some objects of the development system (libraries `TSTPGMR` and `TST90DAT`): on another system some checks
will fail only because those objects do not exist. The structural checks (number of tools, resources, prompts, rejection of
a `DELETE`) remain valid.

**Where the logs are.** The server writes only to `stderr`, because `stdout` is reserved for the MCP protocol. Every tool call
produces a `my-mcp-as400 audit {...}` line with the tool name, arguments, duration and outcome. To keep them in a file set
`AUDIT_LOG=/path/audit.log` in the `.env`. In Claude Code use `claude mcp list` for the server status and `/mcp` inside the session.

---

## 2. Installation and startup

### `npm install` fails while compiling `java`

`node-jt400` uses the native `java` module (a bridge to the JVM), which has to be compiled. You need:

- a compiler and `make` (on Debian/Ubuntu: `sudo apt install build-essential`);
- Python 3 (required by `node-gyp`);
- a **JDK** (the JRE is not enough) with a valid `JAVA_HOME`.

```bash
java -version            # must answer
echo "$JAVA_HOME"        # must point to the JDK
```

If the installation already happened with the wrong JDK, after fixing it: `rm -rf node_modules && npm install`.
The project was tried with Node 22 and OpenJDK 21. `package.json` requires Node ≥ 22.

### `Missing environment variable: AS400_HOST (see .env.example)`

The `.env` was not found or is incomplete. The server looks for it **first in the project folder** (the one with `package.json`,
wherever it is launched from) and then in the current directory. So:

```bash
cp .env.example .env
chmod 600 .env
# fill in AS400_HOST, AS400_USER, AS400_PASSWORD
```

Variables already present in the process environment take precedence over the `.env`.

### `NoClassDefFoundError: com/ibm/as400/access/AS400`

It only appears in test scripts that import `java` directly. The classpath with `jt400.jar` is configured when the `node-jt400`
pool is created: in your own script call `getPool()` (or any query) first and import `java` afterwards.
The real server is not affected.

### The script does not exit

The JVM keeps the process alive. In test scripts finish with `process.exit(0)`, as `scripts/test-connection.ts`
and `scripts/e2e.ts` do. The server handles `SIGINT`/`SIGTERM` on its own by closing the pools.

---

## 3. The server does not appear or does not respond in the MCP client

This applies to Claude Code, Codex and OpenCode (the activation instructions are in the [README](../README.md#integrating-with-mcp-clients)).
To see the status of the registered server:

```bash
claude mcp list      # Claude Code
codex mcp list       # Codex
opencode mcp list    # OpenCode
```

Register the server with the **absolute** path of the compiled file, and check in order:

- **`dist/` does not exist or is stale.** The server runs `dist/index.js`: after every code change you need `npm run build`.
- **`node` is not the right one.** With `nvm`/`fnm` the `node` seen by the client may not be Node 22. Use the absolute path
  of the binary (`command -v node`) instead of `node` in the command.
- **The `.env` is not found.** With the current version it does not depend on the launch directory (see section 2). If you have an
  older version, update: it only used the current directory.
- **Something writes to `stdout`.** It breaks the MCP protocol (symptom: the server starts but tools do not answer or the connection
  drops). The server writes nothing to `stdout`; if you add a `console.log` use `console.error`.
- **Slow first start.** Starting the JVM and the first connection take 2-3 seconds: the first call is slower than the following ones.
  In Codex you can raise `startup_timeout_sec` if the client reports the server as not started.
- **Searches are interrupted by the client.** Codex has a per-call timeout (`tool_timeout_sec` in `config.toml`): if it is shorter
  than the time `as400_source_search` or `as400_ifs_search` need (up to `SEARCH_TIMEOUT_MS`, 180 s by default), the call
  fails on the client side even though the server was still working. Raise `tool_timeout_sec` or narrow the search (section 8).
- **The client does not show resources or prompts.** Their support depends on the client; the tools cover the same functions (table in the README).
- **OpenCode: the entry does not appear in `opencode mcp list`.** Check the file written by `opencode mcp add` (`opencode.json` in the
  project, or the global configuration with `--global`) and that the format is the one written by your version's command.

To try the server by hand, with no client at all, use `npm run test:e2e`.

---

## 4. Connection and credentials

| Symptom | Likely cause | What to do |
|---|---|---|
| Timeout or `Unable to connect` on the first query | Host unreachable or Host Servers not running | `ping` the host. On the IBM i: `STRHOSTSVR SERVER(*ALL)` and check that the *DATABASE and *SIGNON servers are active (ports 8471 and 8476; with SSL 9471 and 9476). |
| `[CPF22E2]`, `[CPF22E3]`, `Password not correct`, authentication errors | Wrong user or password, disabled profile or expired password | Try the same credentials with a 5250 session. `DSPUSRPRF` shows status and expiry. |
| `Connection authorization failure occurred` | A write statement (for example `CREATE ALIAS` or `CALL`) was run on the main pool, which is `access=read only` | This is intended: the server is read-only and the IBM i server rejects the write. Legitimate tools never try it; if it appears, it almost always means an unexpected query. See section 6. |
| `Timeout (60000 ms) on SQL query: operation abandoned` | Slow query or catalog | Section 8. |

**SSL.** For an encrypted connection add to the `.env`:

```
AS400_JDBC_EXTRA=secure=true
```

`AS400_JDBC_EXTRA` accepts several properties in `key=value&key=value` format (JDBC properties of the JT400 driver).
With certificates not recognized by the JDK, import them into the Java truststore.

---

## 5. Authorities and "not found"

Many tools return an empty or "not found" result both when the object does not exist and when the profile lacks the
authority to see it. The message says so: `directory empty, nonexistent or no authority`,
`Path not found or no authority`. If you suspect an authority problem, try with a 5250 session using the same profile.

Authorities the dedicated profile needs, read-only:

| To use | Needed |
|---|---|
| SQL catalogs (`SYSTABLES`, `SYSCOLUMNS`, `SYSPARTITIONSTAT`, ...) | The profile only sees objects it has authority to: unauthorized libraries appear empty. |
| `as400_index_list`, `as400_where_used` | Read on `QSYS/QADBFDEP`, `QADBKFLD` and `QADBXREF` (the tables used by `DSPDBR`). If missing, `where_used` reports the error in the affected section instead of failing entirely. |
| Sources | `*USE` on the source file and the library. |
| IFS | Read on the directories and files. |
| Spool | Authority on the output queue (`*READ`) and, to read the content, on the spooled file: owner, `*SPLCTL` or `*JOBCTL` depending on the queue configuration. |
| `as400_spool_read` | The WSCST object named by `SPOOL_WSCST` must exist and be readable (default `/QSYS.LIB/QWPDEFAULT.WSCST`). |

A quick check from `test:connection` or from `as400_sql_query`:

```sql
SELECT COUNT(*) FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = 'LIBRARY'
```

---

## 6. Tool error messages

These are the messages with the default `LOCALE=EN`. `X`, `LIB`, ... stand for the values in your request.

### Restrictions configured by the administrator

| Message | Meaning | Fix |
|---|---|---|
| `Library not allowed (ALLOWED_LIBS): X` | `ALLOWED_LIBS` is set and X is not in it | Add X to `ALLOWED_LIBS` or empty the variable. |
| `With ALLOWED_LIBS active every table/function must be qualified with its library (LIB.TABLE): 'name'` | With the list active, the SQL cannot use names without a library | Write `LIB.TABLE` for every table in `FROM`/`JOIN`. The `QSYS2`, `SYSIBM`, `SYSIBMADM`, `SYSTOOLS` catalogs are always allowed. |
| `IFS path not allowed (IFS_ALLOWED_PREFIXES=...): /path` | The path is outside the allowed prefixes | Add the prefix to `IFS_ALLOWED_PREFIXES` or use a path inside it. |
| `Path not allowed: '...' is a symbolic link (not followed while IFS_ALLOWED_PREFIXES is active)` | A path component is a symbolic link | This is intended: a link could point outside the allowed area. Use the real target path, if it falls within the prefixes. |

### Read-only

| Message | Meaning |
|---|---|
| `Only SELECT or WITH statements are allowed (read-only server)` | `as400_sql_query` accepts only `SELECT` and `WITH`. |
| `Keyword not allowed (read-only server): X` | The query contains `INSERT`, `UPDATE`, `DELETE`, `CALL`, `CREATE`, `DROP`, ... |
| `Object/function not allowed in sql_query: IFS_READ (use the dedicated tools for IFS and spool)` | `IFS_*`, `SPOOLED_FILE_DATA` and `QCMDEXC` are blocked in free-form SQL, because they have dedicated tools with their own checks. Use `as400_ifs_read`, `as400_spool_read`, ... |
| `Only one SQL statement, without a semicolon` | One statement per call. |
| `Unterminated SQL comment` / `Unterminated SQL string` | Unclosed quotes or `/* ... */` in the query. |

### Sources

| Message | Fix |
|---|---|
| `Reading members needs temporary aliases: set ALLOW_QTEMP_ALIAS=true` | `ALLOW_QTEMP_ALIAS` is `false`: set it back to `true`, or do not use `source_read`, `source_search`, `source_refs`, `dds_describe`. |
| `Member or source file not found: LIB/FILE(MEMBER)` | Check the names with `as400_source_list`. |
| `ZZZ in *N di tipo *MEM non trovato` (raw SQL message) | Nonexistent member, in versions that do not remap the error: same meaning. This text comes from IBM i, in the job language of your server. |

### Spool

| Message | Fix |
|---|---|
| `Several spooled files named X: specify 'number' (most recent: ...)` | The message lists the most recent numbers. Add `number`, or `user` or `job`. |
| `Spooled file not found: LIB/QUEUE NAME` | Check library and queue with `as400_spool_search`. The spooled file may have been deleted. |
| `Spool conversion failed (...). Check SPOOL_WSCST=...` | The WSCST object does not exist or is not readable: set `SPOOL_WSCST` to a valid WSCST (`DSPOBJD OBJ(QSYS/QWPDEFAULT) OBJTYPE(*WSCST)`). |
| `Provide at least one filter among user, file, job, userData, from or library (scanning all queues is slow)` | Scanning all queues is slow: provide user, name, job, date or library. |

### Other

| Message | Fix |
|---|---|
| `Timeout (N ms) on ...: operation abandoned` | Section 8. The timeout stops the MCP server's wait, not necessarily the work on the system. |
| `Invalid library: 'x' (max 10 characters [A-Z0-9_$#@])` (also `member`, `file`, `object`, ...) | Object names are at most 10 characters and allow neither spaces nor dots. Long SQL names are not accepted by the object tools. |
| `Invalid IFS path (must be absolute): ...` or `Invalid IFS path ('..' component not allowed): ...` | Use absolute paths without `..`. |
| `Invalid object type: 'x' (e.g. *PGM, *SRVPGM, *CMD, *DTAARA)` | Types are written with the asterisk: `*PGM`, `*SRVPGM`, `*DTAARA`. |
| `Search is not available in the special file systems (QSYS.LIB, QDLS, ...): for sources use as400_source_search` | In `/QSYS.LIB`, `/QDLS`, ... use `as400_source_search` and `as400_object_list`. |
| `Invalid LOCALE 'xx': allowed values are IT or EN (default EN)` (at startup) | `LOCALE` in the `.env` must be `IT` or `EN` (case-insensitive), or empty/absent for `EN`. |

---

## 7. Wrong content: characters, spaces, numbers

### Wrong accented letters in spooled files

Spool text arrives from the server as ASCII; the default `SPOOL_CHARSET=cp850` is the one used by `QWPDEFAULT` on the development system
(`è`, `à`, `ù` come out right). If you see wrong characters (`Ô` instead of `È`, `?` or boxes), your WSCST uses a different
table: try `SPOOL_CHARSET=latin1` (ISO-8859-1/Windows-1252) or `utf-8`.

### Wrong letters in IFS files

`as400_ifs_read` decodes according to the CCSID the file is tagged with. If the tag is wrong (for example a UTF-8 file tagged 37):

- use `utf8: true` to force UTF-8 decoding;
- check the tag with `as400_ifs_stat` (field `ccsid`).

A file with `CCSID 65535` is binary: `as400_ifs_read` does not return readable text, use `as400_ifs_read_binary`.

### "Glued" AFPDS spooled files

For `*AFPDS` the server extracts only the text, without positions: lines and columns may end up adjacent or merged.
The page layout cannot be reconstructed. For the layout use `as400_dds_describe` on the print file and, if the document is produced by a
form definition/overlay, inspect those on the system. `*SCS` files, instead, are rendered with correct line breaks and separate pages.

### "Shifted" columns in RPG sources

Early versions of the project lost leading spaces (RPG fixed-format: column 6 is the specification type). Now
`source_read`, `ifs_read` and `sql_query` preserve them. If you still see shifted sources, check that you have a recent version
(`git log`) and that you rebuilt with `npm run build`.

### All numbers are strings

`"number": "15"`, `"pages": "3"`: the JDBC driver returns numbers as strings. This is the expected behavior; on input,
numeric parameters (`number`, `fromLine`, `limit`, ...) stay numbers.

### Truncated source lines or fields

The limits (`SQL_MAX_ROWS`, `SOURCE_MAX_LINES`, `IFS_MAX_LINES`, `SPOOL_MAX_FILES`, `SPOOL_MAX_CHARS`, ...) cut the answers and say so
in a `note` in the result. Use `fromLine`/`toLine`, `fromPage`/`toPage` and the filters, or raise the limit in the `.env`.

---

## 8. Slowness and timeouts

Production libraries hold thousands of objects and some catalog views are slow. What helps:

- **Always filter.** `as400_table_list`, `as400_object_list` and `as400_column_search` have filters on name, type and text.
  Listing all the `*FILE` objects of a library with 8000 files can exceed 60 seconds; with a prefix (`filter: "AB%"`)
  `as400_object_list` passes it to the API as a generic name and answers in a fraction of a second.
- **`as400_column_search` requires at least `field` or `text`**, for the same reason.
- **`as400_source_search`** takes about 0.5 seconds per member (alias creation plus scan). Narrow it with `file` and
  `member`; the default cap is `SEARCH_MAX_MEMBERS=150` and the time limit is `SEARCH_TIMEOUT_MS=180000`.
- **`as400_ifs_search`** is limited by `IFS_SEARCH_MAX_FILES`, by depth (default 3) and by the maximum size per file.
  It skips binary files and very large ones.
- **`as400_ifs_list` on very populated directories** needs one call per directory (about 1 second, more with hundreds of entries).
- **General timeout.** `SQL_TIMEOUT_MS` (default 60000) applies to each query; `SEARCH_TIMEOUT_MS` to searches.
  Raising them is a last resort: narrow the request first.
- **`as400_ifs_read_binary` at very high offsets** in files of hundreds of MB is slow because the server reads from the start.

The timeout abandons the wait on the MCP server side; the query on the system may keep running to the end (or until the
connection is closed by the `socket timeout`). A long SQL job can be seen with `WRKACTJOB` (`QZDASOINIT` jobs) and stopped with `ENDJOB`.

---

## 9. IBM i releases earlier than 7.4

The project was developed and tried on **V7R4**. The compatibility target is 7.3 onwards, but these functions have not been
tried on 7.3 and must be verified before use:

| Used by | Function or object | If missing |
|---|---|---|
| `as400_ifs_read_binary` | `QSYS2.IFS_READ_BINARY` | SQL "routine not found" error (typically `SQL0204`) on the tool; the rest of the IFS works. |
| `as400_ifs_search`, `as400_ifs_read` | `QSYS2.IFS_READ` with `IGNORE_ERRORS` | As above; plain `ifs_read` may still work. |
| `as400_ifs_list`, `as400_ifs_stat` | `QSYS2.IFS_OBJECT_STATISTICS` | Same. |
| `as400_spool_*` | `QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC` and `OUTPUT_QUEUE_INFO` | The tool reports `SQL0204` on the missing view. |
| `as400_object_describe` | `QSYS2.PROGRAM_INFO`, `BOUND_MODULE_INFO`, `BOUND_SRVPGM_INFO`, `DATA_AREA_INFO` | The corresponding sections report an `error`; the rest of the result stays. |
| `as400_routine_list` | `QSYS2.SYSROUTINES` | Same. |
| `as400_spool_read` | `QWPDEFAULT` WSCST object | Set `SPOOL_WSCST`. |

To find out what your system has:

```sql
-- service functions available
SELECT ROUTINE_NAME FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = 'QSYS2' AND ROUTINE_NAME LIKE 'IFS_%';
-- views available
SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'QSYS2' AND TABLE_NAME LIKE 'OUTPUT_QUEUE%';
```

If a service function is missing, it is usually fixed by updating the *Db2 for i* PTF group, which brings the SQL services: on 7.4 it is
`SF99704` (verified on the development system, level 19); on 7.3 it should be `SF99703`, following the IBM convention, but this has not been
verified. The group level determines which functions are available.

---

## 10. How to report a problem

Attach, without passwords:

1. the IBM i version (`as400_system_info`, field `system.version`), the Node version (`node -v`) and the JDK version (`java -version`);
2. the command you ran and the full message;
3. the matching `audit` line (stderr or `AUDIT_LOG`), which reports tool, arguments and outcome;
4. if the problem is in the results: the tool, the arguments and the type of object (CCSID, spool type, source type).

Do not attach the `.env`: it contains the credentials.
