import { normalizedQuery, describeError } from '../src/pool.js';
import { getConfig } from '../src/config.js';

/** Test di connessione veloce (senza scansioni pesanti del catalogo). */
async function main(): Promise<void> {
  const cfg = getConfig();
  console.log(`Connessione a ${cfg.host} come ${cfg.user} ...`);
  try {
    const t0 = Date.now();
    const base = await normalizedQuery(
      `SELECT SESSION_USER AS UTENTE, CURRENT_SERVER AS SERVER, CURRENT_TIMESTAMP AS ORA
         FROM SYSIBM.SYSDUMMY1`,
    );
    console.log(`Connessione OK in ${Date.now() - t0} ms:`, JSON.stringify(base[0]));

    // autorità sui cataloghi: prova una query ristretta a una libreria di sistema
    const t1 = Date.now();
    const qsys = await normalizedQuery(
      `SELECT COUNT(*) AS N FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = 'QSYS' AND FILE_TYPE = 'S'`,
    );
    console.log(`Catalogo QSYS2 accessibile (${Date.now() - t1} ms), file sorgente in QSYS: ${JSON.stringify(qsys[0])}`);

    console.log('\nNota: per elencare i sorgenti usa il tool as400_source_list indicando la libreria');
    console.log('(le scansioni su tutto il catalogo sono molto lente su questo sistema).');
  } catch (err) {
    console.error('ERRORE:', describeError(err));
    process.exit(1);
  }
  // la JVM mantiene vivo l'event loop: uscita esplicita
  process.exit(0);
}

main();
