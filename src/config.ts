import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const VERSION: string = require('../package.json').version;

export interface Config {
  geminiApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  defaultProvider?: 'gemini' | 'openai' | undefined;
  geminiModel: string;
  openaiModel: string;
  outputDir?: string | undefined;
  projectDir?: string | undefined;
  requestTimeoutMs: number;
}

// stdout is reserved for the MCP JSON-RPC channel, so all diagnostics go to stderr.
export function log(...args: unknown[]): void {
  console.error('[image-gen-mcp]', ...args);
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_OPENAI_MODEL = 'gpt-image-1.5';
const DEFAULT_TIMEOUT_MS = 180_000;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const geminiApiKey = env.GEMINI_API_KEY?.trim() || undefined;
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || undefined;

  let defaultProvider: Config['defaultProvider'];
  const requested = env.IMAGE_GEN_MCP_DEFAULT_PROVIDER?.trim().toLowerCase();
  if (requested === 'gemini' || requested === 'openai') {
    defaultProvider = requested;
  } else {
    if (requested) {
      log(`warning: invalid IMAGE_GEN_MCP_DEFAULT_PROVIDER "${requested}", expected "gemini" or "openai"; falling back to key-based default`);
    }
    defaultProvider = geminiApiKey ? 'gemini' : openaiApiKey ? 'openai' : undefined;
  }

  const timeoutRaw = Number(env.IMAGE_GEN_MCP_TIMEOUT_MS);
  const requestTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS;

  return {
    geminiApiKey,
    openaiApiKey,
    defaultProvider,
    geminiModel: env.IMAGE_GEN_MCP_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    openaiModel: env.IMAGE_GEN_MCP_OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    outputDir: env.IMAGE_GEN_MCP_OUTPUT_DIR?.trim() || undefined,
    projectDir: env.CLAUDE_PROJECT_DIR?.trim() || undefined,
    requestTimeoutMs,
  };
}
