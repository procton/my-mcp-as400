# my-mcp-as400

**Language:** English · [Italiano](README.it.md)

**Read-only** MCP server (stdio) that connects an AI assistant to an IBM i (AS/400) system:
sources (RPG/CL/DDS), IFS, physical/logical files via SQL, and output queues (spool).
It works with any MCP client that can launch a local stdio server; [Claude Code](#claude-code),
[Codex](#codex) and [OpenCode](#opencode) are documented below.

Built on `node-jt400` (JDBC JT400 through a Java bridge): requires **Node >= 22** and **a Java JDK**.
Tested on **IBM i 7.4**. To check compatibility with other releases, run **npm run test:e2e**
(see section 9 of the [troubleshooting guide](docs/RISOLUZIONE-PROBLEMI.md#9-release-ibm-i-precedenti-alla-74), in Italian).

> **Language of the server.** Tool names are in English, but the server's tool descriptions, result field names
> (for example `libreria`, `righe`, `elenco`), error messages, prompt names and prompt texts are in Italian,
> as are the names of many tool parameters (`libreria`, `file`, `membro`, `percorso`, `daRiga`, ...).
> Names are given exactly as the server exposes them in the tables below.
> The troubleshooting guide is also available in Italian only.

## Available tools

| Tool | Description |
|---|---|
| `as400_system_info` | connected user, system, active limits |
| `as400_source_list` | source files of a library / members of a source file |
| `as400_source_read` | text of a source member (RPG, CL, DDS, ...) |
| `as400_source_search` | search for text across all source members of a library (matching lines, with file/member/line) |
| `as400_source_refs` | static analysis of an RPG/CL/DDS member: files, called programs, copy members, data areas, SQL tables, commands, keys |
| `as400_object_list` | objects of a library by type (*PGM, *SRVPGM, *CMD, *DTAARA, ...), with attribute and source |
| `as400_object_describe` | object detail: bound modules and service programs, source of origin, value of a data area |
| `as400_ifs_list` | IFS directory, also in depth (up to 6 levels), with name and type filters |
| `as400_ifs_stat` | type, size, owner, CCSID and date of a file or directory |
| `as400_ifs_read` | IFS text file; the line window is selected on the server |
| `as400_ifs_read_binary` | hexdump of an IFS file from a given offset (binaries, PDF, CCSID 65535) |
| `as400_ifs_search` | search for text in the files under an IFS directory |
| `as400_sql_query` | read-only SELECT on PF/LF and QSYS2 views |
| `as400_file_desc` | PF/LF description: fields, keys, type |
| `as400_schema_list` | libraries/schemas with description and owner |
| `as400_table_list` | files of a library: PF/tables, LF, views, source files; filters on name, type and description |
| `as400_column_search` | search fields by name (short/long) or by text in a library |
| `as400_index_list` | DDS key of a file, plus the logicals/indexes/views built on it, with keys and record format |
| `as400_where_used` | dependencies of a file: logicals, views, child foreign keys, triggers |
| `as400_view_def` | SQL definition of a view |
| `as400_constraints` | primary keys, unique, check and foreign key constraints |
| `as400_routine_list` | SQL/external procedures and functions of a library |
| `as400_spool_list` | queues of a library (with file counts) or spooled files of a queue, newest first |
| `as400_spool_search` | spooled files across all queues by user, name, job, USRDTA, status, type, date range |
| `as400_spool_info` | full attributes of a spooled file (pages, copies, form type, fonts, overlays, ...) |
| `as400_spool_read` | content of a spooled file (SCS, AFPDS, LINE, USERASCII) as text, with `daPagina`/`aPagina` (from page / to page) |
| `as400_dds_describe` | structure of PF/LF/DSPF/PRTF from the DDS source: formats, fields, positions, keys, keywords |

## MCP resources

Besides tools, the server exposes resources that the client can attach to the context (with completion of library, file and member):

| URI | Content |
|---|---|
| `as400://sistema` | user, IBM i version and active limits (JSON) |
| `as400://source/{lib}/{file}/{member}` | text of a source member, with the original columns |
| `as400://file/{lib}/{name}` | JSON description of a file (fields, types, DDS key) |
| `as400://ifs/{path}` | IFS text file, e.g. `as400://ifs/home/profile/script.sh` |
| `as400://spool/{lib}/{outq}/{file}/{number}` | text content of a spooled file |

Resources use the same logic as the tools, so `ALLOWED_LIBS`, `IFS_ALLOWED_PREFIXES`, the limits and the audit all apply.

## MCP prompts

| Prompt | What it asks the model to do |
|---|---|
| `spiega_programma` | read an RPG/CL source, analyze its references and explain purpose, flow and anomalies |
| `documenta_libreria` | produce a Markdown document with the programs, files and dependencies of a library |
| `analizza_file` | explain a file: fields, keys, logicals, constraints, sample data, who uses it |
| `dove_e_usato` | find where a file, field, program or data area is used |
| `analizza_spool` | find and read spooled files and joblogs, and summarize the errors |
| `interroga_dati` | answer a question about the data: find the right files and fields, write a read-only SELECT, run it and report the answer, the query and the assumptions |
| `spiega_stampa` | describe the layout of a PRTF/DSPF and compare it with real spooled files |

## Configuration

```bash
cp .env.example .env
chmod 600 .env          # credentials stay local
# fill in AS400_HOST / AS400_USER / AS400_PASSWORD
```

Optional variables: `SQL_MAX_ROWS`, `SOURCE_MAX_LINES`, `IFS_MAX_LINES`, `IFS_MAX_CHARS`,
`SPOOL_MAX_FILES`, `SPOOL_MAX_CHARS`, `SOURCE_MAX_CHARS`, `SOURCE_MAX_MEMBERS`,
`SPOOL_CHARSET` (ASCII charset of the spool text after conversion, default `cp850`),
`SPOOL_WSCST` (WSCST object used for the conversion, default `/QSYS.LIB/QWPDEFAULT.WSCST`), `SPOOL_MAX_READ_BYTES`,
`ALLOW_QTEMP_ALIAS`, `SQL_TIMEOUT_MS`, `SEARCH_TIMEOUT_MS`, `SEARCH_MAX_MEMBERS`, `IFS_BINARY_MAX_BYTES`,
`IFS_SEARCH_MAX_FILES`, `AUDIT_LOG`, `ALLOWED_LIBS` (list of allowed libraries),
`IFS_ALLOWED_PREFIXES` (allowed IFS path prefixes), `AS400_JDBC_EXTRA`
(extra JDBC properties in `key=value&key=value` format).

## Build and connection test

```bash
npm install     # needs build-essential (make/gcc) to compile the java bridge
npm run build
npm run test:connection
npm test            # unit tests (no connection needed)
npm run typecheck
npm run test:e2e    # starts the server and exercises it with an MCP client (needs the IBM i connection)
```

## Integrating with MCP clients

The server speaks MCP over stdio, so it works with any client that can launch a local process.
In all examples `<path-to-inst-folder>` is the folder where you installed the project.

**Before connecting a client:**

1. `npm install` and `npm run build` (clients launch `dist/index.js`, which must be rebuilt after every code change);
2. create and fill in the `.env` as described in [Configuration](#configuration);
3. check the connection with `npm run test:connection`.

**Credentials.** They are read from the `.env` in the project folder (next to `package.json`), regardless of the
directory the client launches the server from; if it is not there, from the `.env` in the current directory. Variables
already present in the environment take precedence. So you never need to pass passwords to the client or write them
in its configuration.

**Path to `node`.** If Node is installed with `nvm`/`fnm`, the client may not see the same version as your shell:
in that case use the absolute path of the binary (`command -v node`) instead of `node` in the commands. Node >= 22 is required.

### Claude Code

```bash
claude mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js
claude mcp list
```

or in the project's `.mcp.json`:

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

Codex CLI reads MCP servers from `~/.codex/config.toml`. To enable it:

```bash
codex mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js
codex mcp list
```

or, by hand, in `~/.codex/config.toml`:

```toml
[mcp_servers.as400]
command = "node"
args = ["<path-to-inst-folder>/my-mcp-as400/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 300
```

`tool_timeout_sec` is the maximum time for a single tool call. Some server operations (`as400_source_search`,
`as400_ifs_search`, reads on very large libraries) can take more than a minute, and the server has its own limit of
180 seconds (`SEARCH_TIMEOUT_MS`): keep `tool_timeout_sec` at least at that value, otherwise Codex interrupts the call first.

### OpenCode

The easiest way is OpenCode's own command, which writes the configuration for you:

```bash
# current project only (writes opencode.json in the folder)
opencode mcp add as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js

# all projects (global configuration)
opencode mcp add --global as400 -- node <path-to-inst-folder>/my-mcp-as400/dist/index.js

opencode mcp list
```

With OpenCode 2.2.0 the command produces this entry:

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

Some guides show a different format (`"mcp": { "as400": { "type": "local", "command": [...] } }`, without the `servers`
level). If you edit the file by hand, use the format written by the `opencode mcp add` command of *your* version.

### What works with each client

- **Tools (27).** They are the standard part of MCP, and the one every client must support.
- **Resources and prompts.** Support depends on the client. If yours does not show them, no functionality is lost:
  every resource has an equivalent tool.

  | Resource | Equivalent tool |
  |---|---|
  | `as400://sistema` | `as400_system_info` |
  | `as400://source/{lib}/{file}/{member}` | `as400_source_read` |
  | `as400://file/{lib}/{name}` | `as400_file_desc` |
  | `as400://ifs/{path}` | `as400_ifs_read` |
  | `as400://spool/{lib}/{outq}/{file}/{number}` | `as400_spool_read` |

  Prompts are reusable work instructions (which tools to call and in what order): without prompt support you can type
  the same request by hand.

**Verification status.** The protocol (tools, resources, completions, prompts) is verified with a test MCP client
(`npm run test:e2e`, based on the official SDK), launching the server from a directory other than the project's.
Codex 0.167.0's configuration syntax was verified with its own `codex mcp list` command.
The connection with each real client, with a model calling the tools, has not been tried; for OpenCode it was not
possible to confirm how its `list` command reads the entry written by `add`. If something does not work, see the
[troubleshooting guide](docs/RISOLUZIONE-PROBLEMI.md#3-il-server-non-compare-o-non-risponde-nel-client-mcp) (in Italian).

## Troubleshooting

For installation, connection, authorities, tool error messages, wrong characters, slowness and compatibility with 7.3,
see the [troubleshooting guide](docs/RISOLUZIONE-PROBLEMI.md) (in Italian).

## Security notes

Layered defense:

1. **JDBC connection with `access=read only`**: the IBM i server rejects every write (verified: `CREATE`, `CALL`).
2. **Lexical SQL guard** (`src/sqlguard.ts`): tokenizes the query ignoring comments and strings, allows only
   `SELECT`/`WITH`, forbids DML/DDL/`CALL`, `FINAL TABLE`, `QCMDEXC`, and the IFS/spool functions
   (`IFS_READ`, `SPOOLED_FILE_DATA`, ...) that have dedicated tools with their own checks.
3. **`ALLOWED_LIBS` on SQL**: every table in `FROM`/`JOIN` must be qualified (`LIB.TABLE`) with an allowed
   library; the `QSYS2`, `SYSIBM`, `SYSIBMADM`, `SYSTOOLS` catalogs stay readable (metadata only).
4. **Limits**: rows, characters, timeouts (`SQL_TIMEOUT_MS`).
5. **Audit**: every call is logged as JSON on stderr and, if `AUDIT_LOG` is set, to a file
   (SQL parameters are not logged).

The only place that uses a non-read-only connection is `as400_source_read` (a temporary alias in QTEMP),
with fixed statements and validated names.

With `IFS_ALLOWED_PREFIXES` active, **symbolic links are not followed**: before reading, the server
checks that no component of the path, from the allowed prefix downwards, is a `*SYMLNK`
(a link inside the allowed area could point outside it). Links are omitted from results.
IFS search does not work in the special file systems (`/QSYS.LIB`, `/QDLS`, ...).

Other measures:

- **Read-only** server: `as400_sql_query` accepts only `SELECT`/`WITH` and rejects
  multiple statements and `FOR UPDATE`; there is no write tool and no CL execution tool.
- Access can be restricted with `ALLOWED_LIBS` and `IFS_ALLOWED_PREFIXES`.
- A dedicated IBM i profile with minimum read authorities is recommended.
