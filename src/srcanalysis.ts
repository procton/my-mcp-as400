/* Analisi statica euristica dei sorgenti IBM i (RPG, CL, DDS): estrae i riferimenti ad altri oggetti.
 * Non è un parser: legge il testo con regole posizionali (formato fisso) e regex (formato libero/CL).
 * Le righe sono quelle di SRCDTA con le colonne originali (col. 6 = tipo di specifica RPG). */
import { t as tr } from './i18n.js';

export type RefKind = 'file' | 'programma' | 'procedura' | 'copy' | 'dataarea' | 'tabella_sql' | 'comando' | 'formato_record' | 'chiave';

export interface Ref {
  tipo: RefKind;
  nome: string;
  dettaglio?: string;
  righe: number[];
}

export type Family = 'rpg' | 'cl' | 'dds' | 'sconosciuto';

export function familyOf(sourceType: string | null | undefined): Family {
  const t = (sourceType ?? '').trim().toUpperCase();
  if (/^(RPG|RPGLE|SQLRPG|SQLRPGLE|RPG38|RPT|RPT38|SQLRPG38|RPGLE38)$/.test(t)) return 'rpg';
  if (/^(CL|CLP|CLLE|CLP38|CLLE38|BND)$/.test(t) && t !== 'BND') return 'cl';
  if (/^(PF|LF|DSPF|PRTF|PF38|LF38|DSPF38|PRTF38|PF-DTA|PF-SRC|ICFF|MNUDDS)$/.test(t)) return 'dds';
  return 'sconosciuto';
}

class Collector {
  private map = new Map<string, Ref>();
  add(tipo: RefKind, nome: string, riga: number, dettaglio?: string): void {
    const n = nome.trim().replace(/^['"]|['"]$/g, '').toUpperCase();
    if (!n) return;
    const key = `${tipo}|${n}|${dettaglio ?? ''}`;
    const r = this.map.get(key);
    if (r) {
      if (r.righe.length < 8 && !r.righe.includes(riga)) r.righe.push(riga);
    } else {
      this.map.set(key, { tipo, nome: n, dettaglio, righe: [riga] });
    }
  }
  result(): Ref[] {
    return [...this.map.values()];
  }
}

const ID = '[A-Za-z0-9_#@$]+';

export function extractRefs(family: Family, lines: string[]): Ref[] {
  const c = new Collector();
  if (family === 'rpg') rpg(lines, c);
  else if (family === 'cl') cl(lines, c);
  else if (family === 'dds') dds(lines, c);
  else {
    // tipo ignoto: prova prima l'RPG, che è innocuo su altri testi
    rpg(lines, c);
  }
  return c.result();
}

/* ---------------- RPG ---------------- */

const SQL_NOT_TABLE = new Set(['SELECT', 'TABLE', 'VALUES', 'LATERAL', 'UNNEST', 'DUAL', 'SESSION', 'FINAL', 'OLD', 'NEW', 'CURRENT', 'ONLY', 'WHERE', 'SET']);

function rpg(lines: string[], c: Collector): void {
  let sql: { start: number; text: string } | null = null;
  const flushSql = (): void => {
    if (!sql) return;
    const text = sql.text;
    for (const m of text.matchAll(/\bCALL\s+([A-Za-z0-9_#@$"]+(?:[./][A-Za-z0-9_#@$"]+)?)/gi)) c.add('programma', m[1], sql.start, 'SQL CALL');
    for (const m of text.matchAll(new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+("?${ID}"?(?:[./]"?${ID}"?)?)`, 'gi'))) {
      const nm = m[2].replace(/"/g, '');
      if (SQL_NOT_TABLE.has(nm.toUpperCase()) || nm.startsWith(':')) continue;
      c.add('tabella_sql', nm, sql.start, m[1].toUpperCase());
    }
    sql = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const no = i + 1;
    const spec = raw.length > 5 ? raw[5].toUpperCase() : '';
    const col7 = raw[6] ?? '';
    const isComment = col7 === '*' && /[HFDCIOP]/i.test(spec) || /^\s*\/\//.test(raw);
    if (isComment) continue;

    // SQL incorporato (può estendersi su più righe fino al ';')
    const sqlStart = raw.search(/EXEC\s+SQL/i);
    if (sql || sqlStart >= 0) {
      const piece = (sql ? raw : raw.slice(sqlStart)).replace(/\/\/.*$/, '').replace(/^\s*\+/, ' ');
      if (!sql) sql = { start: no, text: '' };
      sql.text += ' ' + piece;
      if (piece.includes(';')) flushSql();
      continue;
    }

    // /COPY e /INCLUDE
    const cp = raw.match(/^\s*\/(?:COPY|INCLUDE)\s+(.+?)\s*$/i);
    if (cp) {
      c.add('copy', cp[1].replace(/\s+/g, ''), no);
      continue;
    }

    // F-spec a formato fisso
    if (spec === 'F' && col7 !== '*' && /^.{5}F.{10}/.test(raw)) {
      const name = raw.slice(6, 16).trim();
      if (name && !/^(DCL-|\/)/i.test(name)) {
        const usage = (raw[16] ?? '').trim();
        const device = raw.slice(35, 42).trim();
        const usageName = ({ I: 'input', U: 'update', O: 'output', C: 'combined' } as Record<string, string>)[usage.toUpperCase()];
        c.add('file', name, no, [usageName, device.toLowerCase()].filter(Boolean).join(' ') || undefined);
      }
    }

    // formato libero
    const dcl = raw.match(new RegExp(`^\\s*DCL-F\\s+(${ID})(.*)$`, 'i'));
    if (dcl) {
      const rest = dcl[2];
      const dev = rest.match(/\b(DISK|PRINTER|WORKSTN|SPECIAL|SEQ)\b/i)?.[1];
      const usage = rest.match(/\bUSAGE\(\s*([^)]+)\)/i)?.[1];
      const ext = rest.match(/EXTFILE\(\s*'?([^')\s]+)'?\s*\)/i)?.[1];
      c.add('file', ext && !ext.startsWith('*') ? ext : dcl[1], no, [usage?.replace(/\s+/g, '').toLowerCase(), dev?.toLowerCase()].filter(Boolean).join(' ') || undefined);
    }

    for (const m of raw.matchAll(/EXTPGM\(\s*'?([^')\s]+)'?\s*\)/gi)) c.add('programma', m[1], no, 'EXTPGM');
    for (const m of raw.matchAll(/EXTPROC\(\s*(?:\*CL\s*:\s*)?'?([^')\s]+)'?\s*\)/gi)) c.add('procedura', m[1], no, 'EXTPROC');
    for (const m of raw.matchAll(/EXTNAME\(\s*'?([A-Za-z0-9_#@$./]+)'?/gi)) c.add('file', m[1], no, 'EXTNAME');
    for (const m of raw.matchAll(/DTAARA\(\s*(?:\*VAR\s*:\s*)?'?([A-Za-z0-9_#@$./]+)'?\s*\)/gi)) c.add('dataarea', m[1], no);
    // CALL / CALLB a formato fisso
    if (/^.{5}C/.test(raw) || /^\s*CALLB?\s/i.test(raw)) {
      const cm = raw.match(/\bCALLB?\b\s+(?:\()?\s*('[^']+'|[A-Za-z0-9_#@$]+)/i);
      if (cm && !/^(CALLP)$/i.test(cm[1])) c.add('programma', cm[1], no, 'CALL');
    }
    const cp2 = raw.match(/\bCALLP\s+([A-Za-z0-9_#@$]+)/i);
    if (cp2) c.add('procedura', cp2[1], no, 'CALLP');
  }
  flushSql();
}

/* ---------------- CL ---------------- */

const CL_CONTROL = new Set([
  'PGM', 'ENDPGM', 'DCL', 'DCLF', 'IF', 'ELSE', 'DO', 'ENDDO', 'DOWHILE', 'DOUNTIL', 'DOFOR', 'MONMSG', 'CHGVAR', 'GOTO',
  'RETURN', 'SELECT', 'WHEN', 'OTHERWISE', 'ENDSELECT', 'CALLPRC', 'CALL', 'RCVF', 'SNDRCVF', 'SNDF', 'ITERATE', 'LEAVE',
  'DCLPRCOPT', 'SUBR', 'ENDSUBR', 'CALLSUBR', 'COPYRIGHT',
]);

function cl(lines: string[], c: Collector): void {
  // unisce le righe di continuazione ('+' o '-' finale)
  let acc = '';
  let start = 0;
  const logical: Array<{ no: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const cleaned = lines[i].replace(/\/\*.*?\*\//g, ' ').replace(/\/\*.*$/, ' ');
    const t = cleaned.trimEnd();
    if (!acc) start = i + 1;
    const cont = /[+-]$/.test(t);
    acc += (acc ? ' ' : '') + (cont ? t.slice(0, -1) : t).trim();
    if (!cont) {
      if (acc.trim()) logical.push({ no: start, text: acc });
      acc = '';
    }
  }
  if (acc.trim()) logical.push({ no: start, text: acc });

  for (const { no, text } of logical) {
    const t = text.replace(/^\s*[A-Za-z0-9_#@$]+:\s*/, ''); // etichetta
    const cmd = t.match(/^\s*(?:IF\s*\(.*?\)\s*|ELSE\s+)?([A-Za-z][A-Za-z0-9]{1,9})\b/)?.[1]?.toUpperCase();
    const body = t;
    for (const m of body.matchAll(/\bCALL\s+PGM\(\s*([^)\s]+)\s*\)/gi)) if (!m[1].startsWith('&')) c.add('programma', m[1], no, 'CALL');
    for (const m of body.matchAll(/\bCALL\s+(?!PGM\()([A-Za-z0-9_#@$]+(?:\/[A-Za-z0-9_#@$]+)?)/gi)) c.add('programma', m[1], no, 'CALL');
    for (const m of body.matchAll(/\bDCLF\s+FILE\(\s*([^)\s]+)\s*\)/gi)) c.add('file', m[1], no, 'DCLF');
    for (const m of body.matchAll(/\b(OVR(?:DBF|PRTF|DSPF))\b[^]*?\bTOFILE\(\s*([^)\s]+)\s*\)/gi)) c.add('file', m[2], no, m[1].toUpperCase());
    for (const m of body.matchAll(/\bFROMFILE\(\s*([^)\s]+)\s*\)/gi)) c.add('file', m[1], no, tr({ it: 'CPYF origine', en: 'CPYF source' }));
    if (/\bCPY(?:F|FRMIMPF|TOIMPF|FRMSTMF|TOSTMF)\b/i.test(body)) {
      for (const m of body.matchAll(/\bTOFILE\(\s*([^)\s]+)\s*\)/gi)) c.add('file', m[1], no, tr({ it: 'CPYF destinazione', en: 'CPYF target' }));
    }
    for (const m of body.matchAll(/\b(?:DLTF|CLRPFM|RGZPFM|CHKOBJ|DSPFD|DSPFFD|CRTDUPOBJ)\b[^]*?\b(?:FILE|OBJ)\(\s*([^)\s&]+)\s*\)/gi)) c.add('file', m[1], no, tr({ it: 'comando su file', en: 'command on file' }));
    for (const m of body.matchAll(/\bDTAARA\(\s*([^)\s&]+)\s*\)/gi)) c.add('dataarea', m[1], no);
    for (const m of body.matchAll(/\bSBMJOB\b[^]*?\bJOB\(\s*([^)\s]+)\s*\)/gi)) c.add('comando', 'SBMJOB', no, `job ${m[1].toUpperCase()}`);
    if (cmd && !CL_CONTROL.has(cmd) && !/^[A-Z]+\(/.test(cmd)) c.add('comando', cmd, no);
  }
}

/* ---------------- DDS ---------------- */

function dds(lines: string[], c: Collector): void {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const no = i + 1;
    if (raw.length < 6 || raw[5].toUpperCase() !== 'A') continue;
    if (raw[6] === '*') continue;
    const form = raw[16] ?? ' '; // col. 17: R (formato), K (chiave), S/O (select/omit)
    const name = raw.slice(18, 28).trim();
    if (form === 'R' && name) c.add('formato_record', name, no);
    if (form === 'K' && name) {
      const desc = raw.slice(28).match(/\bDESCEND\b/i) ? 'DESC' : undefined;
      c.add('chiave', name, no, desc);
    }
    const kw = raw.slice(44);
    for (const m of kw.matchAll(/\bPFILE\(\s*([^)\s]+)\s*\)/gi)) c.add('file', m[1], no, 'PFILE (base)');
    for (const m of kw.matchAll(/\bJFILE\(\s*([^)]+)\)/gi)) for (const f of m[1].trim().split(/\s+/)) c.add('file', f, no, 'JFILE');
    for (const m of kw.matchAll(/\bREF\(\s*([^)\s]+)\s*\)/gi)) c.add('file', m[1], no, 'REF');
    for (const m of kw.matchAll(/\bREFFLD\(\s*\S+\s+([^)\s*]+)\s*\)/gi)) c.add('file', m[1], no, 'REFFLD');
  }
}
