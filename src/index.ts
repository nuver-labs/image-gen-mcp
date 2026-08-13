#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION, loadConfig, log } from './config.js';
import { createServer } from './server.js';

// --version and --help are the only things ever written to stdout, and only when
// the process exits immediately without speaking MCP. Once the transport is
// connected below, stdout belongs entirely to the JSON-RPC channel.
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    [
      `image-gen-mcp ${VERSION}`,
      '',
      'A stdio MCP server that generates and edits images with Gemini and OpenAI.',
      'It speaks the Model Context Protocol and is meant to be launched by an MCP',
      'client, not run by hand.',
      '',
      'Usage:',
      '  claude mcp add image-gen --scope user \\',
      '    --env GEMINI_API_KEY=<key> -- npx -y @nuver-labs/image-gen-mcp',
      '',
      'Environment:',
      '  GEMINI_API_KEY, OPENAI_API_KEY        at least one is required',
      '  IMAGE_GEN_MCP_DEFAULT_PROVIDER        gemini | openai',
      '  IMAGE_GEN_MCP_GEMINI_MODEL            default Gemini model',
      '  IMAGE_GEN_MCP_OPENAI_MODEL            default OpenAI model',
      '  IMAGE_GEN_MCP_OUTPUT_DIR              fallback output directory',
      '  IMAGE_GEN_MCP_ALLOWED_DIRS            restrict file reads and writes',
      '  IMAGE_GEN_MCP_TIMEOUT_MS              per-request provider timeout',
      '  IMAGE_GEN_MCP_LOG_FILE                JSONL ledger path, or none',
      '',
      'Docs: https://github.com/nuver-labs/image-gen-mcp',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

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
