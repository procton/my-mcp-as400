#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { getLocale, t } from './i18n.js';
import { closePool } from './pool.js';
import { registerTools } from './toolspecs.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

function log(msg: string): void {
  // su stdio la stdout è riservata al protocollo MCP: log solo su stderr
  console.error(`my-mcp-as400: ${msg}`);
}

async function main(): Promise<void> {
  const locale = getLocale(); // fallisce subito, con un messaggio chiaro, se LOCALE non è valido
  const cfg = getConfig();
  log(t({
    it: 'configurazione caricata (host {host}, utente {user}, read-only, lingua {locale})',
    en: 'configuration loaded (host {host}, user {user}, read-only, locale {locale})',
  }, { host: cfg.host, user: cfg.user, locale }));

  const server = new McpServer({ name: 'my-mcp-as400', version: '0.1.0' });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(t({ it: 'pronto (stdio)', en: 'ready (stdio)' }));
}

main().catch((err: unknown) => {
  let label = 'fatal error';
  try {
    label = t({ it: 'errore fatale', en: 'fatal error' });
  } catch { /* LOCALE non valido: resta l'etichetta neutra */ }
  console.error(`my-mcp-as400: ${label}:`, err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closePool().finally(() => process.exit(0));
  });
}
