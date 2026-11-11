import { z } from 'zod';
import { normalizedQuery } from '../pool.js';
import { getConfig, ifsPath } from '../config.js';
import { text, json, tool, capText, pick, numberLines } from './common.js';
import type { ToolResult } from './common.js';

const inputList = {
  percorso: z.string().describe('Percorso assoluto di una directory IFS (es. /home)'),
};

/** Elenca il contenuto di primo livello di una directory IFS via QSYS2.IFS_OBJECT_STATISTICS. */
export const ifsList = tool<
  z.infer<z.ZodObject<typeof inputList>>
>(async (args): Promise<ToolResult> => {
  const p = ifsPath(args.percorso);
  // forma posizionale (percorso, subtree=NO): valida su questa release
  const rows = await normalizedQuery(
    `SELECT * FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(CAST(? AS VARCHAR(32709)), 'NO'))`,
    [p],
  );
  const self = p.replace(/\/+$/, '');
  const items = rows
    .filter((r) => String(pick(r, 'PATH_NAME') ?? '').replace(/\/+$/, '') !== self)
    .map((r) => {
    const path = String(pick(r, 'PATH_NAME') ?? '');
    return {
      percorso: path,
      nome: path.split('/').pop() ?? path,
      tipo: String(pick(r, 'OBJECT_TYPE') ?? ''),
      dimensione: pick(r, 'DATA_SIZE') ?? null,
      proprietario: pick(r, 'OBJECT_OWNER') ?? null,
      ccsid: pick(r, 'CCSID') ?? null,
      modificato: pick(r, 'OBJECT_CHANGE_TIMESTAMP', 'CREATE_TIMESTAMP') ?? null,
    };
  });
  items.sort((a, b) => a.nome.localeCompare(b.nome));
  if (items.length === 0) {
    return json({ percorso: p, oggetti: 0, nota: 'directory vuota, inesistente o senza autorità' });
  }
  return json({ percorso: p, oggetti: items.length, elenco: items });
});

const inputRead = {
  percorso: z.string().describe('Percorso assoluto del file di testo IFS'),
  numeriRiga: z.boolean().optional().describe('Prefissa ogni riga con il numero progressivo (default true)'),
  daRiga: z.number().int().min(1).optional().describe('Riga di partenza (1-based), per leggere in blocchi'),
};

/** Legge un file di testo IFS via QSYS2.IFS_READ. */
export const ifsRead = tool<
  z.infer<z.ZodObject<typeof inputRead>>
>(async (args): Promise<ToolResult> => {
  const cfg = getConfig();
  const p = ifsPath(args.percorso);
  const rows = await normalizedQuery(
    `SELECT * FROM TABLE(QSYS2.IFS_READ(CAST(? AS VARCHAR(32709))))`,
    [p],
  );
  const lines = rows.map((r) => String(pick(r, 'LINE') ?? ''));
  if (lines.length === 0) {
    return json({
      percorso: p, righe: 0,
      nota: 'nessun contenuto: file inesistente, vuoto, binario o autorità insufficiente',
    });
  }
  const start = args.daRiga !== undefined ? args.daRiga - 1 : 0;
  const end = start + cfg.ifsMaxLines;
  let sliced = lines.slice(start, end);
  const truncated = start + sliced.length < lines.length;
  const body = args.numeriRiga === false ? sliced.join('\n') : numberLines(sliced, start + 1);
  const meta: Record<string, unknown> = {
    percorso: p, righe_totali: lines.length, prima_riga: sliced.length ? start + 1 : 0,
  };
  if (truncated) {
    meta.nota = `troncato a ${cfg.ifsMaxLines} righe (IFS_MAX_LINES); usa daRiga per leggere il resto`;
  }
  return text(`${JSON.stringify(meta)}\n${capText(body, cfg.ifsMaxChars, 'file IFS')}`);
});
