import { normalizedQuery, describeError } from '../src/pool.js';

/** Diagnostica rapida: solo connessione base. */
async function main(): Promise<void> {
  try {
    const t0 = Date.now();
    const r = await normalizedQuery(
      `SELECT SESSION_USER AS UTENTE, CURRENT_TIMESTAMP AS ORA FROM SYSIBM.SYSDUMMY1`,
    );
    console.log(JSON.stringify(r[0]));
    console.log('ok in', Date.now() - t0, 'ms');
    process.exit(0);
  } catch (err) {
    console.error('ERR:', describeError(err));
    process.exit(1);
  }
}

main();
