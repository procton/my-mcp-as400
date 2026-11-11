import { getPool, normalizedQuery, describeError } from '../src/pool.js';
import { getConfig } from '../src/config.js';

/** Membri via MemberList (Toolbox) + lettura membro via alias QTEMP. */
async function main(): Promise<void> {
  const cfg = getConfig();
  const pool = getPool();
  const java = (await import('java')).default as any;
  let membri: Array<{ nome: string; tipo: unknown; record: unknown }> = [];
  try {
    const AS400 = java.import('com.ibm.as400.access.AS400');
    const MemberList = java.import('com.ibm.as400.access.MemberList');
    const MemberDesc = java.import('com.ibm.as400.access.MemberDescription');
    const IDX = {
      nome: await MemberDesc.MEMBER_NAME,
      tipo: await MemberDesc.SOURCE_TYPE,
      testo: await MemberDesc.MEMBER_TEXT_DESCRIPTION,
      data: await MemberDesc.LAST_SOURCE_CHANGE_DATE,
      record: await MemberDesc.CURRENT_NUMBER_OF_RECORDS,
    };
    console.log('indici costanti:', JSON.stringify(IDX));
    const system = new AS400(cfg.host, cfg.user, cfg.password);
    const list = new MemberList(system, 'QSYS', 'QANMMIB');
    await list.load();
    const descs = await list.getMemberDescriptions();
    const n = await descs.length;
    console.log('membri QANMMIB (QSYS):', n);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const d = await descs[i];
      membri.push({
        nome: String(await d.getValue(IDX.nome)),
        tipo: await d.getValue(IDX.tipo),
        record: await d.getValue(IDX.record),
      });
    }
    for (const m of membri) console.log('   ', m.nome, '| tipo:', m.tipo, '| record:', m.record);
  } catch (err) {
    console.error('MemberList FAIL completo:', String((err as { message?: string })?.message ?? err).slice(0, 600));
  }

  if (membri.length > 0) {
    try {
      const membro = membri[0].nome;
      console.log('\nlettura membro via alias:', membro);
      await normalizedQuery(`CREATE OR REPLACE ALIAS QTEMP.MCPTST FOR QSYS.QANMMIB('${membro}')`);
      const rows = await normalizedQuery(`SELECT SRCSEQ, SRCDTA FROM QTEMP.MCPTST ORDER BY SRCSEQ`);
      console.log('righe sorgente:', rows.length);
      for (const r of rows.slice(0, 4)) console.log('   ', JSON.stringify(r).slice(0, 120));
      await normalizedQuery(`DROP ALIAS QTEMP.MCPTST`);
    } catch (err) {
      console.error('alias FAIL:', describeError(err).split('\n')[0]);
    }
  }
  process.exit(0);
}

main();
