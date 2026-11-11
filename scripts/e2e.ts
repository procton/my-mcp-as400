/* Test end-to-end: avvia dist/index.js come server MCP stdio e lo interroga con un client MCP.
 * Richiede la connessione all'IBM i (.env). Uso: npm run build && npm run test:e2e */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
const ok = (cond: boolean, name: string, extra = ''): void => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};
const textOf = (r: { content?: Array<{ type: string; text?: string }> }): string =>
  (r.content ?? []).map((c) => c.text ?? '').join('\n');

// directory di lavoro diversa da quella del progetto, come quando Claude Code lo avvia da un altro progetto
const transport = new StdioClientTransport({ command: 'node', args: [path.resolve('dist/index.js')], cwd: os.tmpdir(), stderr: 'ignore' });
const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools;
ok(tools.length === 27, 'tool registrati (27)', `${tools.length}`);
ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'tutti i tool sono readOnlyHint');
const names = new Set(tools.map((t) => t.name));
for (const n of ['as400_sql_query', 'as400_source_read', 'as400_ifs_read', 'as400_spool_read', 'as400_dds_describe']) ok(names.has(n), `tool ${n}`);

const info = await client.callTool({ name: 'as400_system_info', arguments: {} });
ok(!info.isError && /V\dR\d/.test(textOf(info as never)), 'system_info (versione)');

const bad = await client.callTool({ name: 'as400_sql_query', arguments: { query: 'DELETE FROM QTEMP.X' } });
ok(bad.isError === true, 'sql_query rifiuta DELETE');

const tpls = (await client.listResourceTemplates()).resourceTemplates;
ok(tpls.length === 4, 'template di risorse', tpls.map((t) => t.uriTemplate).join(' '));
const res = (await client.listResources()).resources;
ok(res.some((r) => r.uri === 'as400://sistema'), 'risorsa statica as400://sistema');

const sys = await client.readResource({ uri: 'as400://sistema' });
ok(/connessione/.test(String((sys.contents[0] as { text?: string }).text)), 'lettura as400://sistema');

const src = await client.readResource({ uri: 'as400://source/TSTPGMR/QRPGLESRC/ABCRTOBJWO' });
const srcText = String((src.contents[0] as { text?: string }).text);
ok(/^ {5}H /.test(srcText), 'risorsa sorgente conserva le colonne iniziali', JSON.stringify(srcText.slice(0, 30)));

const fil = await client.readResource({ uri: 'as400://file/TST90DAT/ABCSA01F' });
ok(/chiave_dds/.test(String((fil.contents[0] as { text?: string }).text)), 'risorsa file');

const ifs = await client.readResource({ uri: 'as400://ifs/home/QPGMR/gdlog4j.properties' });
ok(/log4j/.test(String((ifs.contents[0] as { text?: string }).text)), 'risorsa IFS (percorso con /)');

const sp = await client.readResource({ uri: 'as400://spool/QGPL/QPRINT/ES52/6' });
ok(/Pagina/.test(String((sp.contents[0] as { text?: string }).text)), 'risorsa spool');

let errored = false;
try { await client.readResource({ uri: 'as400://source/TSTPGMR/QRPGLESRC/NONESISTE' }); } catch { errored = true; }
ok(errored, 'risorsa inesistente → errore');

const comp = await client.complete({
  ref: { type: 'ref/resource', uri: 'as400://source/{lib}/{file}/{member}' },
  argument: { name: 'lib', value: 'TSTP' },
});
ok(comp.completion.values.includes('TSTPGMR'), 'completamento libreria', comp.completion.values.join(','));
const comp2 = await client.complete({
  ref: { type: 'ref/resource', uri: 'as400://source/{lib}/{file}/{member}' },
  argument: { name: 'file', value: 'QRPG' },
  context: { arguments: { lib: 'TSTPGMR' } },
});
ok(comp2.completion.values.includes('QRPGLESRC'), 'completamento file sorgente', comp2.completion.values.join(','));

const prompts = (await client.listPrompts()).prompts;
ok(prompts.length === 7, 'prompt registrati', prompts.map((p) => p.name).join(','));
const gp = await client.getPrompt({ name: 'spiega_programma', arguments: { libreria: 'TSTPGMR', file: 'QRPGLESRC', membro: 'ABCRTOBJWO' } });
const pt = (gp.messages[0].content as { text: string }).text;
ok(/as400_source_read/.test(pt) && /TSTPGMR\/QRPGLESRC\(ABCRTOBJWO\)/.test(pt), 'prompt spiega_programma');
const gp3 = await client.getPrompt({ name: 'interroga_dati', arguments: { libreria: 'TST90DAT', domanda: 'Quanti file logici ci sono?' } });
const p3 = (gp3.messages[0].content as { text: string }).text;
ok(/Quanti file logici ci sono\?/.test(p3) && /as400_sql_query/.test(p3), 'prompt interroga_dati');
const gp2 = await client.getPrompt({ name: 'documenta_libreria', arguments: { libreria: 'TSTPGMR' } });
ok(/as400_object_list/.test((gp2.messages[0].content as { text: string }).text), 'prompt documenta_libreria');

await client.close();
console.log(failed === 0 ? '\nTutti i controlli superati' : `\n${failed} controlli falliti`);
process.exit(failed === 0 ? 0 : 1);
