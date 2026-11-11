/* Parser dei sorgenti DDS a colonne fisse (PF, LF, DSPF, PRTF).
 *
 * Colonne (1-based): 6 'A' | 7 '*' commento | 8-16 condizioni (3 gruppi da 3: [AND/OR/N][indicatore])
 * | 17 tipo nome (R formato, K chiave, J join, S select, O omit) | 19-28 nome | 29 'R' riferimento
 * | 30-34 lunghezza | 35 tipo dati | 36-37 decimali | 38 uso (B/I/O/H/P/M) | 39-41 riga | 42-44 posizione
 * | 45-80 funzioni (parole chiave); '+' / '-' finale = continuazione. */

export interface DdsKeyword {
  nome: string;
  argomenti?: string;
}

export interface DdsField {
  nome: string;
  lunghezza?: number;
  tipo?: string;
  decimali?: number;
  uso?: string;
  riga?: number;
  posizione?: number;
  da_riferimento?: boolean;
  condizioni?: string[];
  testo?: string;
  intestazione?: string;
  parole_chiave: DdsKeyword[];
}

export interface DdsConstant {
  riga?: number;
  posizione?: number;
  testo: string;
  condizioni?: string[];
  parole_chiave: DdsKeyword[];
}

export interface DdsFormat {
  nome: string;
  riga_sorgente: number;
  condizioni?: string[];
  parole_chiave: DdsKeyword[];
  campi: DdsField[];
  costanti: DdsConstant[];
}

export interface DdsKey {
  campo: string;
  ordine: 'ASC' | 'DESC';
  parole_chiave: DdsKeyword[];
}

export interface DdsSelect {
  modo: 'select' | 'omit';
  campo: string;
  parole_chiave: DdsKeyword[];
}

export interface DdsFile {
  parole_chiave_file: DdsKeyword[];
  formati: DdsFormat[];
  chiavi: DdsKey[];
  select_omit: DdsSelect[];
  join: string[];
}

const TYPE_NAMES: Record<string, string> = {
  A: 'carattere', S: 'zoned', P: 'packed', B: 'binario', F: 'virgola mobile', H: 'esadecimale',
  L: 'data', T: 'ora', Z: 'timestamp', '5': 'DBCS-aperto', J: 'DBCS-solo', E: 'DBCS-misto', O: 'DBCS-aperto', G: 'grafico',
};

const USAGE_NAMES: Record<string, string> = {
  B: 'input/output', I: 'input', O: 'output', H: 'nascosto', P: 'programma-sistema', M: 'messaggio',
};

/** Estrae le parole chiave (NOME o NOME(argomenti)) da un testo, rispettando apici e parentesi annidate. */
export function parseKeywords(text: string): DdsKeyword[] {
  const out: DdsKeyword[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    // costante tra apici (campo-costante): l'intero literal è una "parola chiave"
    if (text[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out.push({ nome: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && !/[\s(]/.test(text[j])) j++;
    const nome = text.slice(i, j);
    if (j < n && text[j] === '(') {
      let depth = 0;
      let k = j;
      let inQ = false;
      for (; k < n; k++) {
        const ch = text[k];
        if (ch === "'") inQ = !inQ;
        else if (!inQ && ch === '(') depth++;
        else if (!inQ && ch === ')') { depth--; if (depth === 0) break; }
      }
      out.push({ nome: nome.toUpperCase(), argomenti: text.slice(j + 1, k).trim() });
      i = k + 1;
    } else {
      if (nome) out.push({ nome: nome.toUpperCase() });
      i = j;
    }
  }
  return out;
}

function unquote(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const parts = [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return parts.length ? parts.join(' ').trim() : s.trim();
}

/** Unisce le righe di funzione con i marcatori di continuazione '+' (mantiene gli spazi) e '-' (li elimina). */
class KwBuffer {
  private text = '';
  private pending: '+' | '-' | null = null;
  add(raw: string): void {
    // il marcatore di continuazione è nella colonna 80, ultima delle 36 colonne di funzione
    const marker = raw.length >= 36 ? raw[35] : '';
    const cont = marker === '+' || marker === '-';
    // con '+' i blanks finali della riga continuata e iniziali della successiva sono significativi; con '-' quelli iniziali sono ignorati
    let seg = cont ? raw.slice(0, 35) : raw.replace(/\s+$/, '');
    if (this.pending === '-') seg = seg.replace(/^\s+/, '');
    if (cont) {
      this.text += seg;
      this.pending = marker as '+' | '-';
    } else {
      this.text += seg + ' ';
      this.pending = null;
    }
  }
  value(): string {
    return this.text.trim();
  }
}

function conditions(line: string): string[] | undefined {
  const out: string[] = [];
  for (let g = 0; g < 3; g++) {
    const grp = line.slice(7 + g * 3, 10 + g * 3);
    if (grp.trim()) out.push(grp.replace(/\s/g, ''));
  }
  return out.length ? out : undefined;
}

const num = (s: string): number | undefined => (s.trim() && /^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

type Ctx =
  | { k: 'file'; kw: KwBuffer }
  | { k: 'format'; fmt: DdsFormat; kw: KwBuffer }
  | { k: 'field'; fmt: DdsFormat; f: DdsField; kw: KwBuffer }
  | { k: 'const'; fmt: DdsFormat; c: DdsConstant; kw: KwBuffer }
  | { k: 'key'; key: DdsKey; kw: KwBuffer }
  | { k: 'sel'; sel: DdsSelect; kw: KwBuffer };

export function parseDds(lines: string[]): DdsFile {
  const file: DdsFile = { parole_chiave_file: [], formati: [], chiavi: [], select_omit: [], join: [] };
  let ctx: Ctx = { k: 'file', kw: new KwBuffer() };
  const fileKw = ctx.kw;
  let curFmt: DdsFormat | null = null;

  const flush = (): void => {
    const c = ctx;
    const kws = parseKeywords(c.kw.value());
    switch (c.k) {
      case 'file': break; // gestito a fine parsing
      case 'format': c.fmt.parole_chiave = kws; break;
      case 'field':
        c.f.parole_chiave = kws.filter((x) => !['TEXT', 'COLHDG'].includes(x.nome));
        c.f.testo = unquote(kws.find((x) => x.nome === 'TEXT')?.argomenti);
        c.f.intestazione = unquote(kws.find((x) => x.nome === 'COLHDG')?.argomenti);
        if (!c.f.testo) delete c.f.testo;
        if (!c.f.intestazione) delete c.f.intestazione;
        break;
      case 'const':
        c.c.testo = kws.filter((x) => x.nome.startsWith("'")).map((x) => x.nome.slice(1, -1).replace(/''/g, "'")).join(' ');
        c.c.parole_chiave = kws.filter((x) => !x.nome.startsWith("'"));
        break;
      case 'key': c.key.parole_chiave = kws; if (kws.some((x) => x.nome === 'DESCEND')) c.key.ordine = 'DESC'; break;
      case 'sel': c.sel.parole_chiave = kws; break;
    }
  };

  for (const raw of lines) {
    if (raw.length < 6 || raw[5].toUpperCase() !== 'A') continue;
    if (raw[6] === '*') continue;
    const line = raw.padEnd(80, ' ');
    const form = line[16];
    const name = line.slice(18, 28).trim();
    const kwText = line.slice(44, 80);
    const lenS = line.slice(29, 34);
    const typ = line[34].trim().toUpperCase();
    const dec = line.slice(35, 37);
    const usage = line[37].trim().toUpperCase();
    const ln = num(line.slice(38, 41));
    const ps = num(line.slice(41, 44));
    const cond = conditions(line);

    if (form === 'R') {
      flush();
      curFmt = { nome: name, riga_sorgente: lines.indexOf(raw) + 1, condizioni: cond, parole_chiave: [], campi: [], costanti: [] };
      if (!cond) delete curFmt.condizioni;
      file.formati.push(curFmt);
      ctx = { k: 'format', fmt: curFmt, kw: new KwBuffer() };
      ctx.kw.add(kwText);
      continue;
    }
    if (form === 'K') {
      flush();
      const key: DdsKey = { campo: name, ordine: 'ASC', parole_chiave: [] };
      file.chiavi.push(key);
      ctx = { k: 'key', key, kw: new KwBuffer() };
      ctx.kw.add(kwText);
      continue;
    }
    if (form === 'S' || form === 'O') {
      flush();
      const sel: DdsSelect = { modo: form === 'S' ? 'select' : 'omit', campo: name, parole_chiave: [] };
      file.select_omit.push(sel);
      ctx = { k: 'sel', sel, kw: new KwBuffer() };
      ctx.kw.add(kwText);
      continue;
    }
    if (form === 'J') {
      flush();
      file.join.push(kwText.trim());
      ctx = { k: 'file', kw: fileKw };
      continue;
    }

    if (name) {
      // nuovo campo (se ancora non c'è un formato, i campi appartengono a un formato implicito)
      flush();
      if (!curFmt) {
        curFmt = { nome: '(implicito)', riga_sorgente: 0, parole_chiave: [], campi: [], costanti: [] };
        file.formati.push(curFmt);
      }
      const f: DdsField = { nome: name, parole_chiave: [] };
      const len = num(lenS);
      if (len !== undefined) f.lunghezza = len;
      if (typ || len !== undefined) f.tipo = TYPE_NAMES[typ || (dec.trim() ? 'S' : 'A')] ?? typ;
      const d = num(dec);
      if (d !== undefined) f.decimali = d;
      if (usage) f.uso = USAGE_NAMES[usage] ?? usage;
      if (ln !== undefined) f.riga = ln;
      if (ps !== undefined) f.posizione = ps;
      if (line[28].toUpperCase() === 'R') f.da_riferimento = true;
      if (cond) f.condizioni = cond;
      curFmt.campi.push(f);
      ctx = { k: 'field', fmt: curFmt, f, kw: new KwBuffer() };
      ctx.kw.add(kwText);
      continue;
    }

    // riga senza nome: costante posizionata oppure continuazione di parole chiave
    const startsConst = kwText.trim().startsWith("'") && (ln !== undefined || ps !== undefined);
    if (startsConst && curFmt) {
      flush();
      const c: DdsConstant = { testo: '', parole_chiave: [] };
      if (ln !== undefined) c.riga = ln;
      if (ps !== undefined) c.posizione = ps;
      if (cond) c.condizioni = cond;
      curFmt.costanti.push(c);
      ctx = { k: 'const', fmt: curFmt, c, kw: new KwBuffer() };
      ctx.kw.add(kwText);
      continue;
    }
    if (kwText.trim()) ctx.kw.add(kwText);
  }
  flush();
  file.parole_chiave_file = parseKeywords(fileKw.value());
  return file;
}
