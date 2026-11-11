import { z } from 'zod';
import { normalizedQuery } from '../pool.js';
import { getConfig, objName } from '../config.js';
import { json, tool, pick } from './common.js';
import type { ToolResult } from './common.js';
import { nameCond } from './catalog.js';
import { t, paramName } from '../i18n.js';

/** Elenco di tipi oggetto IBM i (es. "*PGM *SRVPGM"): ogni voce validata. */
function typeList(value: string | undefined): string {
  const raw = (value ?? '*ALL').trim().toUpperCase();
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 20) throw new Error(t({ it: 'Elenco tipi oggetto non valido', en: 'Invalid object type list' }));
  for (const p of parts) if (!/^\*[A-Z0-9]{2,8}$/.test(p)) throw new Error(t({
      it: "Tipo oggetto non valido: '{p}' (es. *PGM, *SRVPGM, *CMD, *DTAARA)",
      en: "Invalid object type: '{p}' (e.g. *PGM, *SRVPGM, *CMD, *DTAARA)",
    }, { p }));
  return parts.join(' ');
}

const inputList = {
  libreria: z.string(),
  tipo: z.string().optional(),
  filtro: z.string().optional(),
  testo: z.string().optional(),
  attributo: z.string().optional(),
  limite: z.number().int().min(1).optional(),
};

export const objectList = tool<z.infer<z.ZodObject<typeof inputList>>>('as400_object_list', async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const lib = objName(args.libreria, 'libreria');
  const tipi = typeList(args.tipo);
  const lim = Math.min(Math.max(args.limite ?? 200, 1), cfg.sqlMaxRows);
  const nc = nameCond('OBJNAME', args.filtro);
  // un prefisso (ABC%) è passato come nome generico (ABC*): l'API filtra prima di elencare, evitando
  // il timeout su librerie con migliaia di oggetti
  const prefix = args.filtro?.trim().toUpperCase().match(/^([A-Z0-9_$#@]+)%$/)?.[1];
  const params: unknown[] = [lib, tipi, prefix ? `${prefix}*` : '*ALL', nc.param];
  let extra = '';
  if (args.testo) {
    extra += ' AND UPPER(OBJTEXT) LIKE ?';
    params.push(`%${args.testo.trim().toUpperCase()}%`);
  }
  if (args.attributo) {
    extra += ' AND UPPER(OBJATTRIBUTE) = ?';
    params.push(args.attributo.trim().toUpperCase());
  }
  const rows = await normalizedQuery(
    `SELECT OBJNAME, OBJTYPE, OBJATTRIBUTE, OBJTEXT, OBJOWNER, OBJSIZE, OBJCREATED, CHANGE_TIMESTAMP, LAST_USED_TIMESTAMP,
            SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER
       FROM TABLE(QSYS2.OBJECT_STATISTICS(?, ?, ?))
      WHERE ${nc.sql}${extra}
      ORDER BY OBJTYPE, OBJNAME
      FETCH FIRST ${lim} ROWS ONLY`,
    params,
  );
  const elenco = rows.map((r) => {
    const sf = pick(r, 'SOURCE_FILE');
    return {
      nome: pick(r, 'OBJNAME'),
      tipo: pick(r, 'OBJTYPE'),
      attributo: pick(r, 'OBJATTRIBUTE') || undefined,
      descrizione: pick(r, 'OBJTEXT') ?? null,
      proprietario: pick(r, 'OBJOWNER'),
      dimensione: pick(r, 'OBJSIZE'),
      creato: pick(r, 'OBJCREATED'),
      modificato: pick(r, 'CHANGE_TIMESTAMP'),
      ultimo_uso: pick(r, 'LAST_USED_TIMESTAMP') ?? undefined,
      sorgente: sf ? `${pick(r, 'SOURCE_LIBRARY')}/${sf}(${pick(r, 'SOURCE_MEMBER')})` : undefined,
    };
  });
  const out: Record<string, unknown> = { libreria: lib, tipi, oggetti: elenco.length, elenco };
  if (elenco.length >= lim) out.nota = t({
    it: "raggiunto il limite di {n}: restringi con {filtro}/{tipo}/{testo} o aumenta '{limite}'",
    en: "reached the limit of {n}: narrow with {filtro}/{tipo}/{testo} or raise '{limite}'",
  }, { n: lim, filtro: paramName('filtro'), tipo: paramName('tipo'), testo: paramName('testo'), limite: paramName('limite') });
  return json(out);
});

const inputDescribe = {
  libreria: z.string(),
  oggetto: z.string(),
  tipo: z.string(),
};

export const objectDescribe = tool<z.infer<z.ZodObject<typeof inputDescribe>>>('as400_object_describe', async (args): Promise<ToolResult> => {
  const lib = objName(args.libreria, 'libreria');
  const name = objName(args.oggetto, 'oggetto');
  const tipo = typeList(args.tipo);
  if (tipo.includes(' ') || tipo === '*ALL') throw new Error(t({ it: 'Indica un solo tipo oggetto specifico', en: 'Specify exactly one object type' }));

  const rows = await normalizedQuery(`SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS(?, ?, ?))`, [lib, tipo, name]);
  if (rows.length === 0) throw new Error(t({ it: 'Oggetto non trovato: {lib}/{name} {tipo}', en: 'Object not found: {lib}/{name} {tipo}' }, { lib, name, tipo }));
  const o = rows[0];
  const base: Record<string, unknown> = {
    oggetto: `${lib}/${name}`, tipo,
    attributo: pick(o, 'OBJATTRIBUTE') || null,
    descrizione: pick(o, 'OBJTEXT') ?? null,
    proprietario: pick(o, 'OBJOWNER'),
    dimensione: pick(o, 'OBJSIZE'),
    creato: pick(o, 'OBJCREATED'),
    modificato: pick(o, 'CHANGE_TIMESTAMP'),
    ultimo_uso: pick(o, 'LAST_USED_TIMESTAMP') ?? null,
    giorni_uso: pick(o, 'DAYS_USED_COUNT') ?? null,
    sorgente: pick(o, 'SOURCE_FILE')
      ? { libreria: pick(o, 'SOURCE_LIBRARY'), file: pick(o, 'SOURCE_FILE'), membro: pick(o, 'SOURCE_MEMBER'), data: pick(o, 'SOURCE_TIMESTAMP') ?? null }
      : null,
    creato_su_release: pick(o, 'CREATED_SYSTEM_VERSION') ?? null,
  };

  const safe = async <T>(f: () => Promise<T>): Promise<T | { errore: string }> => {
    try { return await f(); } catch (e) { return { errore: String((e as Error).message).split('\n')[0].slice(0, 160) }; }
  };

  if (tipo === '*PGM' || tipo === '*SRVPGM') {
    base.programma = await safe(async () => {
      const r = await normalizedQuery(
        `SELECT PROGRAM_TYPE, PROGRAM_ATTRIBUTE, ACTIVATION_GROUP, USE_ADOPTED_AUTHORITY, OBSERVABLE, MODULES, TEXT_DESCRIPTION,
                SOURCE_FILE_LIBRARY, SOURCE_FILE, SOURCE_FILE_MEMBER, SOURCE_FILE_CHANGE_TIMESTAMP, RELEASE_CREATED_ON
           FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ? AND PROGRAM_NAME = ?`,
        [lib, name],
      );
      return r[0] ?? null;
    });
    base.moduli_collegati = await safe(async () => {
      const r = await normalizedQuery(
        `SELECT BOUND_MODULE_LIBRARY AS LIB, BOUND_MODULE AS MODULO, MODULE_ATTRIBUTE AS ATTR,
                SOURCE_FILE_LIBRARY AS SRC_LIB, SOURCE_FILE AS SRC_FILE, SOURCE_FILE_MEMBER AS SRC_MBR
           FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ? AND PROGRAM_NAME = ? FETCH FIRST 100 ROWS ONLY`,
        [lib, name],
      );
      return r;
    });
    if (!base.sorgente && Array.isArray(base.moduli_collegati)) {
      const m = (base.moduli_collegati as Array<Record<string, unknown>>).find((x) => x.SRC_FILE);
      if (m) base.sorgente_dai_moduli = `${m.SRC_LIB}/${m.SRC_FILE}(${m.SRC_MBR})`;
    }
    base.service_program_collegati = await safe(async () => {
      const r = await normalizedQuery(
        `SELECT BOUND_SERVICE_PROGRAM_LIBRARY AS LIB, BOUND_SERVICE_PROGRAM AS SRVPGM
           FROM QSYS2.BOUND_SRVPGM_INFO WHERE PROGRAM_LIBRARY = ? AND PROGRAM_NAME = ? FETCH FIRST 100 ROWS ONLY`,
        [lib, name],
      );
      return r;
    });
  } else if (tipo === '*DTAARA') {
    base.data_area = await safe(async () => {
      const r = await normalizedQuery(
        `SELECT DATA_AREA_TYPE, LENGTH, DECIMAL_POSITIONS, DATA_AREA_VALUE FROM QSYS2.DATA_AREA_INFO WHERE DATA_AREA_LIBRARY = ? AND DATA_AREA_NAME = ?`,
        [lib, name],
      );
      return r[0] ?? null;
    });
  } else if (tipo === '*FILE') {
    base.suggerimento = t({
      it: 'Per campi, chiavi e logici usa as400_file_desc, as400_index_list e as400_where_used.',
      en: 'For fields, keys and logicals use as400_file_desc, as400_index_list and as400_where_used.',
    });
  }
  return json(base);
});
