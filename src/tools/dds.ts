import { z } from 'zod';
import { normalizedQuery } from '../pool.js';
import { objName } from '../config.js';
import { parseDds, type DdsKeyword } from '../ddsparse.js';
import { json, tool, pick } from './common.js';
import { readMemberLines } from './source.js';
import type { ToolResult } from './common.js';
import { t, paramName } from '../i18n.js';

const input = {
  libreria: z.string(),
  oggetto: z.string().optional(),
  file: z.string().optional(),
  membro: z.string().optional(),
};

const kw = (k: DdsKeyword): string => (k.argomenti !== undefined ? `${k.nome}(${k.argomenti})` : k.nome);

/** Cerca il membro sorgente di un file compilato: prima i riferimenti dell'oggetto, poi lo stesso nome in un file sorgente. */
async function resolveSource(lib: string, name: string): Promise<{
  srcLib: string; srcFile: string; srcMbr: string; attr: string; text: unknown; created: unknown; note: string[];
}> {
  const note: string[] = [];
  const o = await normalizedQuery(`SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*FILE', ?))`, [lib, name]);
  if (o.length === 0) throw new Error(t({ it: 'File non trovato: {lib}/{name}', en: 'File not found: {lib}/{name}' }, { lib, name }));
  const attr = String(pick(o[0], 'OBJATTRIBUTE') ?? '');
  const base = { attr, text: pick(o[0], 'OBJTEXT') ?? null, created: pick(o[0], 'OBJCREATED') ?? null };
  const sFile = pick(o[0], 'SOURCE_FILE') as string | null;
  const sLib = (pick(o[0], 'SOURCE_LIBRARY') as string | null) || lib;
  const sMbr = (pick(o[0], 'SOURCE_MEMBER') as string | null) || name;

  const exists = async (l: string, f: string, m: string): Promise<boolean> => {
    const r = await normalizedQuery(
      `SELECT 1 AS X FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? AND SYSTEM_TABLE_MEMBER = ? FETCH FIRST 1 ROWS ONLY`,
      [l, f, m],
    );
    return r.length > 0;
  };

  if (sFile) {
    const l = objName(sLib, 'libreria');
    if (await exists(l, sFile, sMbr)) return { srcLib: l, srcFile: sFile, srcMbr: sMbr, ...base, note };
    note.push(t({
      it: "il sorgente indicato dall'oggetto ({src}) non esiste su questo sistema",
      en: 'the source named by the object ({src}) does not exist on this system',
    }, { src: `${sLib}/${sFile}(${sMbr})` }));
  } else {
    note.push(t({ it: "l'oggetto non riporta il sorgente di origine", en: 'the object does not report its source of origin' }));
  }
  // fallback: membro con lo stesso nome in un file sorgente della libreria dell'oggetto
  const cand = await normalizedQuery(
    `SELECT RTRIM(p.SYSTEM_TABLE_NAME) AS F
       FROM QSYS2.SYSPARTITIONSTAT p
       JOIN QSYS2.SYSTABLES t ON t.SYSTEM_TABLE_SCHEMA = p.SYSTEM_TABLE_SCHEMA AND t.SYSTEM_TABLE_NAME = p.SYSTEM_TABLE_NAME
      WHERE p.SYSTEM_TABLE_SCHEMA = ? AND t.FILE_TYPE = 'S' AND p.SYSTEM_TABLE_MEMBER = ?`,
    [lib, name],
  );
  if (cand.length === 1) {
    const f = String(pick(cand[0], 'F'));
    note.push(t({
      it: 'sorgente dedotto per nome: {src} — verifica che corrisponda alla versione compilata',
      en: 'source inferred by name: {src} — check that it matches the compiled version',
    }, { src: `${lib}/${f}(${name})` }));
    return { srcLib: lib, srcFile: f, srcMbr: name, ...base, note };
  }
  if (cand.length > 1) {
    throw new Error(t({
      it: "{first}; trovati più membri {name} in {lib}: {list} — indica '{file}' e '{membro}'",
      en: "{first}; several members {name} found in {lib}: {list} — specify '{file}' and '{membro}'",
    }, { first: note[0], name, lib, list: cand.map((c) => pick(c, 'F')).join(', '), file: paramName('file'), membro: paramName('membro') }));
  }
  throw new Error(t({
    it: "{first}; nessun membro {name} trovato in {lib}. Indica '{libreria}' del sorgente, '{file}' e '{membro}'.",
    en: "{first}; no member {name} found in {lib}. Specify the source '{libreria}', '{file}' and '{membro}'.",
  }, { first: note[0], name, lib, libreria: paramName('libreria'), file: paramName('file'), membro: paramName('membro') }));
}

/** Descrive struttura (formati, campi, chiavi, parole chiave) di un file PF/LF/DSPF/PRTF dal suo sorgente DDS. */
export const ddsDescribe = tool<
  z.infer<z.ZodObject<typeof input>>
>('as400_dds_describe', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  let srcLib = lib;
  let srcFile: string;
  let srcMbr: string;
  const meta: Record<string, unknown> = {};
  const notes: string[] = [];

  if (args.oggetto) {
    const r = await resolveSource(lib, objName(args.oggetto, 'oggetto'));
    ({ srcLib, srcFile, srcMbr } = r);
    meta.oggetto = `${lib}/${args.oggetto.toUpperCase()}`;
    meta.tipo_file = r.attr || null;
    meta.descrizione = r.text;
    notes.push(...r.note);
    // il sorgente è cambiato dopo la compilazione?
    const st = await normalizedQuery(
      `SELECT LAST_SOURCE_UPDATE_TIMESTAMP AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ? AND SYSTEM_TABLE_NAME = ? AND SYSTEM_TABLE_MEMBER = ?`,
      [srcLib, srcFile, srcMbr],
    );
    const srcChanged = String(pick(st[0] ?? {}, 'T') ?? '');
    meta.sorgente_modificato = srcChanged || null;
    meta.oggetto_creato = r.created;
    if (srcChanged && r.created && srcChanged > String(r.created)) {
      notes.push(t({
        it: "il sorgente è stato modificato DOPO la creazione dell'oggetto: la descrizione potrebbe non coincidere con il file compilato",
        en: 'the source was modified AFTER the object was created: the description may not match the compiled file',
      }));
    }
  } else {
    if (!args.file || !args.membro) throw new Error(t({
      it: "Indica '{oggetto}' oppure '{file}' e '{membro}'",
      en: "Provide '{oggetto}' or '{file}' and '{membro}'",
    }, { oggetto: paramName('oggetto'), file: paramName('file'), membro: paramName('membro') }));
    srcFile = objName(args.file, 'file');
    srcMbr = objName(args.membro, 'membro');
  }

  const lines = await readMemberLines(srcLib, srcFile, srcMbr);
  const dds = parseDds(lines);
  meta.sorgente = `${srcLib}/${srcFile}(${srcMbr})`;
  meta.righe_sorgente = lines.length;

  const out = {
    ...meta,
    parole_chiave_file: dds.parole_chiave_file.map(kw),
    formati: dds.formati.map((f) => ({
      nome: f.nome,
      riga_sorgente: f.riga_sorgente || undefined,
      condizioni: f.condizioni,
      parole_chiave: f.parole_chiave.map(kw),
      campi: f.campi.map((c) => ({
        ...c,
        parole_chiave: c.parole_chiave.length ? c.parole_chiave.map(kw) : undefined,
      })),
      costanti: f.costanti.length
        ? f.costanti.map((c) => ({ riga: c.riga, posizione: c.posizione, testo: c.testo, condizioni: c.condizioni, parole_chiave: c.parole_chiave.length ? c.parole_chiave.map(kw) : undefined }))
        : undefined,
    })),
    chiavi: dds.chiavi.length ? dds.chiavi.map((k) => ({ campo: k.campo, ordine: k.ordine })) : undefined,
    select_omit: dds.select_omit.length ? dds.select_omit.map((s) => ({ modo: s.modo, campo: s.campo, condizione: s.parole_chiave.map(kw) })) : undefined,
    join: dds.join.length ? dds.join : undefined,
    nota: notes.length ? notes.join('; ') : undefined,
  };
  return json(out);
});
