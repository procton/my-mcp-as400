/* Lettura del contenuto di un file di spool via bridge Java (Toolbox JT400).
 * node-jt400 inizializza la JVM con il jt400.jar nel classpath: importando il modulo 'java'
 * nella stessa processo si accede alle classi com.ibm.as400.access.
 *
 * Il contenuto è convertito in testo ASCII dal server (Host Print Transform, oggetto WSCST,
 * default QWPDEFAULT): funziona per SCS, AFPDS (estrae il testo) e LINE. Gli USERASCII sono già ASCII
 * e si leggono grezzi. Per usare la JVM già inizializzata, getPool() deve essere stato chiamato. */
import { getConfig } from './config.js';
import { describeError, getPool } from './pool.js';
import { decodeBytes, normalizeSpoolText } from './charset.js';
import { t } from './i18n.js';

interface JavaApi {
  import: (cls: string) => any;
  newArray: (type: string, values: unknown[]) => unknown;
  callStaticMethodSync: (cls: string, method: string, ...args: unknown[]) => any;
}

let javaApi: JavaApi | null = null;

async function getJava(): Promise<JavaApi> {
  if (javaApi) return javaApi;
  getPool(); // assicura il classpath JT400
  const mod = await import('java');
  javaApi = ((mod as unknown as { default?: unknown }).default ?? mod) as JavaApi;
  return javaApi;
}

/** 'YYYY-MM-DD HH:MM:SS.ffffff' → { data: 'CYYMMDD', ora: 'HHMMSS' } */
export function parseTimestamp(ts: string): { data: string; ora: string } {
  const [d, t] = ts.replace('T', ' ').split(' ');
  const [y, m, dd] = d.split('-');
  const [hh, mi, ss] = (t ?? '00:00:00').split(':');
  const secolo = Number(y) >= 2000 ? '1' : '0';
  return {
    data: secolo + y.slice(2) + m + dd,
    ora: (hh ?? '00') + (mi ?? '00') + (ss ?? '00').slice(0, 2),
  };
}

export interface SpoolKey {
  nome: string;
  numero: number;
  jobName: string;
  jobUser: string;
  jobNumber: string;
  jobSysName: string;
  createTimestamp: string;
  /** tipo dispositivo (*SCS, *AFPDS, *USERASCII, ...) */
  tipo: string;
}

export interface SpoolContent {
  text: string;
  /** il flusso aveva altri dati oltre il limite di byte */
  truncated: boolean;
}

/** Legge il contenuto di un file di spool come testo (maxBytes = limite di byte letti dal flusso). */
export async function readSpooledFile(key: SpoolKey, maxBytes: number): Promise<SpoolContent> {
  const java = await getJava();
  const cfg = getConfig();
  const { data, ora } = parseTimestamp(key.createTimestamp);

  const AS400 = java.import('com.ibm.as400.access.AS400');
  const SpooledFile = java.import('com.ibm.as400.access.SpooledFile');
  const PrintObject = java.import('com.ibm.as400.access.PrintObject');
  const PrintParameterList = java.import('com.ibm.as400.access.PrintParameterList');
  const system = new AS400(cfg.host, cfg.user, cfg.password);
  try {
    const sf = new SpooledFile(
      system, key.nome, key.numero, key.jobName, key.jobUser, key.jobNumber, key.jobSysName, data, ora,
    );
    const raw = /USERASCII/i.test(key.tipo);
    let is: any;
    if (raw) {
      is = await sf.getInputStream();
    } else {
      const ppl = new PrintParameterList();
      await ppl.setParameter(await PrintObject.ATTR_WORKSTATION_CUST_OBJECT, cfg.spoolWscst);
      await ppl.setParameter(await PrintObject.ATTR_MFGTYPE, '*WSCST');
      is = await sf.getTransformedInputStream(ppl);
    }
    const buf = java.newArray('byte', new Array(65536).fill(0));
    // accumulo lato Java: un solo trasferimento alla fine, non un accesso per byte attraverso il bridge
    const ByteArrayOutputStream = java.import('java.io.ByteArrayOutputStream');
    const bos = new ByteArrayOutputStream();
    let total = 0;
    let truncated = false;
    for (;;) {
      const n: number = await is.read(buf);
      if (n < 0) break;
      if (n === 0) continue;
      await bos.write(buf, 0, n);
      total += n;
      if (total >= maxBytes) { truncated = true; break; }
    }
    try { await is.close(); } catch { /* ignora */ }
    // il bridge converte il byte[] restituito in un array JS (valori con segno)
    const arr = (await bos.toByteArray()) as number[];
    const bytes = Buffer.from(Uint8Array.from(arr, (b) => b & 0xff));
    const text = raw ? decodeBytes(bytes, 'latin1') : decodeBytes(bytes, cfg.spoolCharset);
    return { text: normalizeSpoolText(text), truncated };
  } catch (err) {
    const msg = describeError(err);
    if (/WSCST|workstation customi|CPF/i.test(msg)) {
      throw new Error(t({
        it: 'Conversione dello spool non riuscita ({msg}). Verifica SPOOL_WSCST={wscst}',
        en: 'Spool conversion failed ({msg}). Check SPOOL_WSCST={wscst}',
      }, { msg: msg.split('\n')[0], wscst: cfg.spoolWscst }));
    }
    throw new Error(msg);
  } finally {
    try {
      await system.disconnectAllServices();
    } catch { /* ignora */ }
  }
}
