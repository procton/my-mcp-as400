/* Caricamento del .env. Modulo a sé, importato da config.ts e i18n.ts, così le variabili sono disponibili
 * prima che qualunque altro modulo le legga (l'ordine di valutazione degli import non conta).
 *
 * Il .env si cerca prima nella cartella del progetto (accanto a src/ o dist/), poi nella directory corrente.
 * dotenv/config userebbe solo la directory corrente, che per un server avviato da un client MCP è il progetto
 * aperto dall'utente e non quello del server. Le variabili già presenti nell'ambiente non vengono sovrascritte. */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(serverDir, '.env'), quiet: true });
loadEnv({ quiet: true });
