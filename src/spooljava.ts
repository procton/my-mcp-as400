/* Lettura del contenuto di un file di spool via bridge Java (Toolbox JT400).
 * node-jt400 inizializza la JVM con il jt400.jar nel classpath: importando
 * il modulo 'java' nella stessa accediamo alle classi com.ibm.as400.access.
 * La chiave completa (nome, numero, job, sistema, CYYMMDD, HHMMSS) serve per
 * i file di spool il cui job possessore è terminato. */
import { getConfig } from './config.js';
import { describeError } from './pool.js';

interface JavaApi {
  import: (cls: string) => any;
  newArray: (type: string, values: unknown[]) => unknown;
  callStaticMethodSync: (cls: string, method: string, ...args: unknown[]) => any;
}

let javaApi: JavaApi | null = null;

async function getJava(): Promise<JavaApi> {
  if (javaApi) return javaApi;
  const mod = await import('java');
  javaApi = ((mod as unknown as { default?: unknown }).default ?? mod) as JavaApi;
  return javaApi;
}

/** 'YYYY-MM-DD HH:MM:SS.ffffff' → { data: 'CYYMMDD', ora: 'HHMMSS' } */
function parseTimestamp(ts: string): { data: string; ora: string } {
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
}

/** Legge il contenuto di un file di spool (testo pulito dai controlli SCS). */
export async function readSpooledFile(key: SpoolKey, maxBytes: number): Promise<string> {
  const java = await getJava();
  const cfg = getConfig();
  const { data, ora } = parseTimestamp(key.createTimestamp);

  const AS400 = java.import('com.ibm.as400.access.AS400');
  const SpooledFile = java.import('com.ibm.as400.access.SpooledFile');
  const CharConverter = java.import('com.ibm.as400.access.CharConverter');
  const system = new AS400(cfg.host, cfg.user, cfg.password);
  try {
    const sf = new SpooledFile(
      system,
      key.nome,
      key.numero,
      key.jobName,
      key.jobUser,
      key.jobNumber,
      key.jobSysName,
      data,
      ora,
    );
    const conv = new CharConverter(cfg.spoolCharset);
    const buf = java.newArray('byte', new Array(65536).fill(0));
    const is = await sf.getInputStream();
    let acc = '';
    let n = await is.read(buf);
    while (n >= 0 && acc.length < maxBytes) {
      // filtra i byte di controllo SCS (EBCDIC 0x00-0x3F) PRIMA della conversione:
      // conserva solo testo EBCDIC (0x40-0xFF), tab (0x05), CR (0x0D) e LF (0x25)
      const chunk = await java.callStaticMethodSync('java.util.Arrays', 'copyOf', buf, n);
      const clean: number[] = [];
      for (let i = 0; i < n; i++) {
        const b = chunk[i] & 0xff;
        if (b >= 0x40 || b === 0x05 || b === 0x0d || b === 0x25) clean.push(b);
      }
      if (clean.length > 0) {
        const jbytes = java.newArray('byte', clean.map((b) => (b > 127 ? b - 256 : b)));
        acc += String(await conv.byteArrayToString(jbytes));
      }
      n = await is.read(buf);
    }
    return acc;
  } catch (err) {
    throw new Error(describeError(err));
  } finally {
    try {
      await system.disconnectAllServices();
    } catch { /* ignora */ }
  }
}
