import { normalizedQuery } from '../pool.js';
import { getConfig } from '../config.js';
import { json, tool, pick } from './common.js';
import type { ToolResult } from './common.js';

/** Informazioni di sistema e di connessione (utile per diagnostica). */
export const systemInfo = tool<Record<string, never>>('as400_system_info', async (): Promise<ToolResult> => {
  const cfg = getConfig();
  const base = await normalizedQuery(
    `SELECT SESSION_USER AS UTENTE, CURRENT_SERVER AS SERVER, CURRENT_TIMESTAMP AS ORA
       FROM SYSIBM.SYSDUMMY1`,
  );
  let env: Record<string, unknown> | null = null;
  try {
    const rows = await normalizedQuery(`SELECT * FROM SYSIBMADM.ENV_SYS_INFO`);
    if (rows.length > 0) {
      env = {
        host: pick(rows[0], 'HOST_NAME') ?? null,
        sistema_operativo: pick(rows[0], 'OS_NAME') ?? null,
        versione: `V${pick(rows[0], 'OS_VERSION') ?? '?'}R${pick(rows[0], 'OS_RELEASE') ?? '?'}`,
        cpu: pick(rows[0], 'TOTAL_CPUS') ?? null,
        memoria_mb: pick(rows[0], 'TOTAL_MEMORY') ?? null,
      };
    }
  } catch { /* vista non disponibile: non fatale */ }
  const limiti = {
    sql_max_righe: cfg.sqlMaxRows,
    source_max_righe: cfg.sourceMaxLines,
    ifs_max_righe: cfg.ifsMaxLines,
    spool_max_file: cfg.spoolMaxFiles,
    librerie_consentite: cfg.allowedLibs ?? '*TUTTE',
    prefissi_ifs_consentiti: cfg.ifsAllowedPrefixes ?? '*TUTTI',
  };
  return json({ connessione: base[0] ?? {}, sistema: env, limiti_attivi: limiti });
});
