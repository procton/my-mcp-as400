import { normalizedQuery, describeError } from '../src/pool.js';

/** Varianti sintassi CREATE ALIAS per membro. */
async function main(): Promise<void> {
  const varianti: string[] = [
    `CREATE OR REPLACE ALIAS QTEMP.MCP1 FOR QSYS.QANMMIB("IBMNV6SA")`,
    `CREATE ALIAS QTEMP.MCP2 FOR QSYS.QANMMIB(IBMNV6SA)`,
    `CREATE OR REPLACE ALIAS QTEMP.MCP3 FOR "QSYS"."QANMMIB"("IBMNV6SA")`,
    `CREATE OR REPLACE ALIAS QTEMP.MCP4 FOR QSYS.QANMMIB (IBMNV6SA)`,
  ];
  for (const sql of varianti) {
    try {
      await normalizedQuery(sql);
      const alias = sql.match(/QTEMP\.(MCP\d)/)?.[1];
      const rows = await normalizedQuery(`SELECT COUNT(*) AS N FROM QTEMP.${alias}`);
      console.log(`OK  ${sql.slice(0, 60)}... → ${JSON.stringify(rows[0])}`);
      try { await normalizedQuery(`DROP ALIAS QTEMP.${alias}`); } catch { /* */ }
      process.exit(0);
    } catch (err) {
      console.log(`FAIL ${sql.slice(0, 60)}... → ${describeError(err).split('\n')[0].slice(0, 110)}`);
    }
  }
  process.exit(1);
}

main();
