/* Test end-to-end: avvia dist/index.js come server MCP stdio e lo interroga con un client MCP, una volta per lingua
 * (LOCALE=EN e LOCALE=IT). Richiede la connessione all'IBM i (.env). Uso: npm run build && npm run test:e2e
 * Si può limitare a una lingua con E2E_LOCALE=EN oppure E2E_LOCALE=IT. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setLocale, paramName, type Locale } from '../src/i18n.js';

let failed = 0;
const ok = (cond: boolean, name: string, extra = ''): void => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
};
const textOf = (r: { content?: Array<{ type: string; text?: string }> }): string =>
  (r.content ?? []).map((c) => c.text ?? '').join('\n');
const resText = (r: { contents: Array<unknown> }): string => String((r.contents[0] as { text?: string }).text);

/** Chiavi JSON (a qualunque profondità) che sembrano italiane: in EN non devono comparire. */
const ITALIAN_KEY = /^(righe|riga|nome|tipo|campi|campo|elenco|libreria|membro|dimensione|creato|modificato|pagine|utente|proprietario|descrizione|stato|coda|sorgente|chiavi?|vista|trovat[ei]|totali|nota|oggetti|oggetto|connessione|sistema|contenuto|risultati|lunghezza|decimali|formati|percorso|ultimo_uso|chiave_dds)$/i;
function italianKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => italianKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ITALIAN_KEY.test(k)) acc.push(k);
      // le righe di dati dell'utente (sql_query) non vengono tradotte
      if (k !== 'dati' && k !== 'data') italianKeys(v, acc);
    }
  }
  return acc;
}
const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

async function suite(locale: Locale): Promise<void> {
  console.log(`\n=== LOCALE=${locale} ===`);
  setLocale(locale);
  const EN = locale === 'EN';
  const n = (internal: string): string => paramName(internal);
  const L = (it: string, en: string): string => (EN ? en : it);

  // directory di lavoro diversa da quella del progetto, come quando un client lo avvia da un altro progetto
  const transport = new StdioClientTransport({
    command: 'node', args: [path.resolve('dist/index.js')], cwd: os.tmpdir(), stderr: 'ignore', env: { LOCALE: locale },
  });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);

  /* --- tool: elenco, schema nella lingua scelta --- */
  const tools = (await client.listTools()).tools;
  ok(tools.length === 27, 'tool registrati (27)', `${tools.length}`);
  ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'tutti i tool sono readOnlyHint');
  const names = new Set(tools.map((t) => t.name));
  for (const x of ['as400_sql_query', 'as400_source_read', 'as400_ifs_read', 'as400_spool_read', 'as400_dds_describe']) ok(names.has(x), `tool ${x}`);
  const sr = tools.find((t) => t.name === 'as400_source_read')!;
  const props = Object.keys((sr.inputSchema as { properties: Record<string, unknown> }).properties);
  ok(props.includes(n('libreria')) && props.includes(n('daRiga')) && !props.includes(EN ? 'libreria' : 'library'), 'schema con i nomi dei parametri della lingua', props.join(','));
  ok(new RegExp(EN ? 'fromLine/toLine' : 'daRiga/aRiga').test(sr.description ?? ''), 'descrizione cita i nomi dei parametri della lingua');

  /* --- chiamate: risultati e chiavi --- */
  const info = await client.callTool({ name: 'as400_system_info', arguments: {} });
  const infoJson = tryJson(textOf(info as never)) as Record<string, unknown> | undefined;
  ok(!info.isError && /V\dR\d/.test(textOf(info as never)), 'system_info (versione)');
  ok(!!infoJson && (EN ? 'connection' in infoJson && 'active_limits' in infoJson : 'connessione' in infoJson && 'limiti_attivi' in infoJson), 'system_info: chiavi nella lingua');
  if (EN) ok(italianKeys(infoJson).length === 0, 'system_info: nessuna chiave italiana', italianKeys(infoJson).join(','));

  const bad = await client.callTool({ name: 'as400_sql_query', arguments: { query: 'DELETE FROM QTEMP.X' } });
  ok(bad.isError === true && new RegExp(L('Ammesse solo istruzioni SELECT o WITH', 'Only SELECT or WITH statements are allowed')).test(textOf(bad as never)), 'sql_query rifiuta DELETE, messaggio nella lingua', textOf(bad as never).slice(0, 70));

  const q = await client.callTool({ name: 'as400_sql_query', arguments: { query: 'SELECT 1 AS UNO FROM SYSIBM.SYSDUMMY1' } });
  const qj = tryJson(textOf(q as never)) as { rows?: number; righe?: number; dati?: unknown; data?: Array<Record<string, unknown>> } | undefined;
  ok(!q.isError && (EN ? qj?.rows === 1 && Array.isArray(qj?.data) : qj?.righe === 1 && Array.isArray(qj?.dati)), 'sql_query: conteggio e dati con le chiavi della lingua');

  // valori enumerati e nomi dei parametri nella lingua
  const tl = await client.callTool({
    name: 'as400_table_list',
    arguments: { [n('libreria')]: 'TST90DAT', [n('tipo')]: EN ? 'physical' : 'fisici', [n('filtro')]: 'ABCSA%', [n('limite')]: 3 },
  });
  const tlj = tryJson(textOf(tl as never)) as Record<string, unknown> | undefined;
  ok(!tl.isError && !!tlj && (EN ? 'library' in tlj && 'list' in tlj : 'libreria' in tlj && 'elenco' in tlj), 'table_list: parametri, enum e chiavi nella lingua', textOf(tl as never).slice(0, 60).replace(/\s+/g, ' '));
  if (EN) ok(italianKeys(tlj).length === 0, 'table_list: nessuna chiave italiana', italianKeys(tlj).join(','));
  ok(/(source file|file sorgente|physical file|file fisico|SQL table|tabella SQL)/.test(textOf(tl as never)), 'table_list: valori (tipo) nella lingua');

  const fd = await client.callTool({ name: 'as400_file_desc', arguments: { [n('libreria')]: 'TST90DAT', file: 'ABCSA01F' } });
  const fdText = textOf(fd as never);
  ok(!fd.isError && (EN ? /"dds_key"/.test(fdText) && /"FIELD"/.test(fdText) : /"chiave_dds"/.test(fdText) && /"CAMPO"/.test(fdText)), 'file_desc: chiavi e alias SQL maiuscoli nella lingua');
  if (EN) ok(italianKeys(tryJson(fdText)).length === 0, 'file_desc: nessuna chiave italiana', italianKeys(tryJson(fdText)).join(','));

  const sread = await client.callTool({
    name: 'as400_source_read',
    arguments: { [n('libreria')]: 'TSTPGMR', file: 'QRPGLESRC', [n('membro')]: 'ABCRTOBJWO', [n('daRiga')]: 1, [n('aRiga')]: 3 },
  });
  const sreadText = textOf(sread as never);
  ok(!sread.isError && (EN ? /"total_lines"/.test(sreadText) : /"righe_totali"/.test(sreadText)), 'source_read: riga di metadati con chiavi nella lingua');
  ok(/^ {5}H /m.test(sreadText.split('\n').slice(1).join('\n').replace(/^\s*\d+\| /gm, '')), 'source_read conserva le colonne iniziali');

  const miss = await client.callTool({ name: 'as400_source_read', arguments: { [n('libreria')]: 'TSTPGMR', file: 'QRPGLESRC', [n('membro')]: 'NONESISTE' } });
  ok(miss.isError === true && new RegExp(L('non trovato', 'not found')).test(textOf(miss as never)), 'membro inesistente: errore nella lingua', textOf(miss as never).slice(0, 60));

  const sp = await client.callTool({
    name: 'as400_spool_read',
    arguments: { [n('libreria')]: 'QGPL', outq: 'QPRINT', file: 'ES52', [n('numero')]: 6, [n('daPagina')]: 3, [n('aPagina')]: 3 },
  });
  const spText = textOf(sp as never);
  ok(!sp.isError && /Pagina/.test(spText) && (EN ? /"pages_returned"/.test(spText) : /"pagine_restituite"/.test(spText)), 'spool_read: pagine e chiavi nella lingua');

  /* --- risorse --- */
  const tpls = (await client.listResourceTemplates()).resourceTemplates;
  ok(tpls.length === 4, 'template di risorse', tpls.map((t) => t.uriTemplate).join(' '));
  const res = (await client.listResources()).resources;
  const sysUri = EN ? 'as400://system' : 'as400://sistema';
  ok(res.some((r) => r.uri === sysUri) && !res.some((r) => r.uri === (EN ? 'as400://sistema' : 'as400://system')), `risorsa statica ${sysUri}`);
  const sys = await client.readResource({ uri: sysUri });
  ok(new RegExp(EN ? '"connection"' : '"connessione"').test(resText(sys)), 'lettura della risorsa di sistema');
  const src = await client.readResource({ uri: 'as400://source/TSTPGMR/QRPGLESRC/ABCRTOBJWO' });
  ok(/^ {5}H /.test(resText(src)), 'risorsa sorgente conserva le colonne iniziali');
  const fil = await client.readResource({ uri: 'as400://file/TST90DAT/ABCSA01F' });
  ok(new RegExp(EN ? 'dds_key' : 'chiave_dds').test(resText(fil)), 'risorsa file (chiavi nella lingua)');
  const ifs = await client.readResource({ uri: 'as400://ifs/home/QPGMR/gdlog4j.properties' });
  ok(/log4j/.test(resText(ifs)), 'risorsa IFS (percorso con /)');
  const spr = await client.readResource({ uri: 'as400://spool/QGPL/QPRINT/ES52/6' });
  ok(/Pagina/.test(resText(spr)), 'risorsa spool (estrae il contenuto con la chiave della lingua)');
  let errored = false;
  try { await client.readResource({ uri: 'as400://source/TSTPGMR/QRPGLESRC/NONESISTE' }); } catch { errored = true; }
  ok(errored, 'risorsa inesistente → errore');

  /* --- completamenti --- */
  const comp = await client.complete({ ref: { type: 'ref/resource', uri: 'as400://source/{lib}/{file}/{member}' }, argument: { name: 'lib', value: 'TSTP' } });
  ok(comp.completion.values.includes('TSTPGMR'), 'completamento libreria', comp.completion.values.join(','));
  const comp2 = await client.complete({
    ref: { type: 'ref/resource', uri: 'as400://source/{lib}/{file}/{member}' }, argument: { name: 'file', value: 'QRPG' }, context: { arguments: { lib: 'TSTPGMR' } },
  });
  ok(comp2.completion.values.includes('QRPGLESRC'), 'completamento file sorgente', comp2.completion.values.join(','));
  const promptName = EN ? 'explain_program' : 'spiega_programma';
  const comp3 = await client.complete({
    ref: { type: 'ref/prompt', name: promptName }, argument: { name: n('file'), value: 'QRPG' }, context: { arguments: { [n('libreria')]: 'TSTPGMR' } },
  });
  ok(comp3.completion.values.includes('QRPGLESRC'), 'completamento argomento di prompt (nomi della lingua)', comp3.completion.values.join(','));

  /* --- prompt --- */
  const prompts = (await client.listPrompts()).prompts;
  const expected = EN
    ? ['explain_program', 'document_library', 'analyze_file', 'find_usages', 'analyze_spool', 'query_data', 'explain_print_file']
    : ['spiega_programma', 'documenta_libreria', 'analizza_file', 'dove_e_usato', 'analizza_spool', 'interroga_dati', 'spiega_stampa'];
  ok(prompts.length === 7 && expected.every((p) => prompts.some((x) => x.name === p)), 'prompt registrati', prompts.map((p) => p.name).join(','));
  const gp = await client.getPrompt({ name: promptName, arguments: { [n('libreria')]: 'TSTPGMR', file: 'QRPGLESRC', [n('membro')]: 'ABCRTOBJWO' } });
  const pt = (gp.messages[0].content as { text: string }).text;
  ok(/as400_source_read/.test(pt) && /TSTPGMR\/QRPGLESRC\(ABCRTOBJWO\)/.test(pt) && new RegExp(EN ? 'Explain the program' : 'Spiega il programma').test(pt), 'prompt spiega programma nella lingua');
  const qn = EN ? 'query_data' : 'interroga_dati';
  const gp3 = await client.getPrompt({ name: qn, arguments: { [n('libreria')]: 'TST90DAT', [n('domanda')]: 'Quanti file logici ci sono?' } });
  const p3 = (gp3.messages[0].content as { text: string }).text;
  ok(/Quanti file logici ci sono\?/.test(p3) && /as400_sql_query/.test(p3) && new RegExp(EN ? 'Answer in English' : 'Rispondi in italiano').test(p3), 'prompt interroga dati nella lingua');

  await client.close();
}

/** Un LOCALE non valido deve far fallire l'avvio con un messaggio chiaro. */
function invalidLocale(): void {
  console.log('\n=== LOCALE non valido ===');
  const r = spawnSync('node', [path.resolve('dist/index.js')], { cwd: os.tmpdir(), env: { ...process.env, LOCALE: 'FR' }, encoding: 'utf8', timeout: 20000 });
  ok(r.status !== 0 && /Invalid LOCALE 'FR'/.test(r.stderr) && /Valore LOCALE non valido/.test(r.stderr), 'LOCALE=FR: avvio rifiutato con messaggio bilingue', r.stderr.split('\n')[0].slice(0, 80));
}

const only = process.env.E2E_LOCALE?.toUpperCase();
for (const loc of ['EN', 'IT'] as const) if (!only || only === loc) await suite(loc);
if (!only) invalidLocale();
console.log(failed === 0 ? '\nTutti i controlli superati' : `\n${failed} controlli falliti`);
process.exit(failed === 0 ? 0 : 1);
