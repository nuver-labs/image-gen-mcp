#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, log } from './config.js';
import { createServer } from './server.js';

const config = loadConfig(process.env);
const server = createServer(config);
await server.connect(new StdioServerTransport());

const configured = [
  config.geminiApiKey ? 'gemini' : null,
  config.openaiApiKey ? 'openai' : null,
].filter(Boolean);
log(`ready: providers=[${configured.join(',') || 'none'}] default=${config.defaultProvider ?? 'none'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
process.on('uncaughtException', (err) => {
  log('uncaught exception:', err);
  process.exit(1);
});
