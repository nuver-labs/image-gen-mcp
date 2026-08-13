import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must match the name field in package.json, or readVersion finds nothing. */
const PACKAGE_NAME = '@nuver-labs/image-gen-mcp';

// Walks up from this module to the package root instead of assuming a fixed
// depth. The published tarball puts this file in dist/, but tests and any other
// build layout put it somewhere else, and a hardcoded '../package.json' silently
// breaks there. The name check stops the walk from picking up a consumer's
// package.json if this package ever ends up nested.
function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
    } catch {
      // No package.json here, or it is unreadable. Keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '0.0.0-unknown';
    dir = parent;
  }
}

export const VERSION: string = readVersion();

export interface Config {
  geminiApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
  defaultProvider?: 'gemini' | 'openai' | undefined;
  geminiModel: string;
  openaiModel: string;
  outputDir?: string | undefined;
  projectDir?: string | undefined;
  /**
   * Realpath-resolved roots that file reads and writes are confined to.
   * Undefined means no containment, which is the default: the server writes
   * wherever the calling agent asks, the same reach the agent already has.
   */
  allowedDirs?: string[] | undefined;
  requestTimeoutMs: number;
  /** Absolute path of the JSONL image ledger, or undefined when file logging is disabled. */
  logFile?: string | undefined;
}

// stdout is reserved for the MCP JSON-RPC channel, so all diagnostics go to stderr.
export function log(...args: unknown[]): void {
  console.error('[image-gen-mcp]', ...args);
}

/** Expands a leading ~ to the home directory. Leaves every other path untouched. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_OPENAI_MODEL = 'gpt-image-2';
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
    allowedDirs: resolveAllowedDirs(env.IMAGE_GEN_MCP_ALLOWED_DIRS),
    requestTimeoutMs,
    logFile: resolveLogFile(env.IMAGE_GEN_MCP_LOG_FILE),
  };
}

// Comma-separated roots that confine every file read and write. Opt-in: unset or
// empty means no containment. Roots are resolved through realpath at startup so
// the containment check later compares real paths on both sides, which is what
// makes a symlink pointing out of a root fail instead of silently passing.
// A root that does not exist is dropped with a warning rather than silently
// ignored, since a typo would otherwise look like a working restriction.
export function resolveAllowedDirs(raw: string | undefined): string[] | undefined {
  const entries = raw
    ?.split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (!entries || entries.length === 0) return undefined;

  const roots: string[] = [];
  for (const entry of entries) {
    const resolved = path.resolve(expandHome(entry));
    try {
      const real = fs.realpathSync(resolved);
      if (!fs.statSync(real).isDirectory()) {
        log(`warning: IMAGE_GEN_MCP_ALLOWED_DIRS entry "${entry}" is not a directory, ignoring it`);
        continue;
      }
      if (!roots.includes(real)) roots.push(real);
    } catch {
      log(`warning: IMAGE_GEN_MCP_ALLOWED_DIRS entry "${entry}" does not exist, ignoring it`);
    }
  }

  if (roots.length === 0) {
    // Every entry was bad. Returning undefined here would silently disable the
    // restriction the operator asked for, so keep an unsatisfiable list instead:
    // every path fails containment until the configuration is fixed.
    log('warning: IMAGE_GEN_MCP_ALLOWED_DIRS matched no usable directory; all file access will be refused');
    return [];
  }
  return roots;
}

const DEFAULT_LOG_FILE = path.join(os.homedir(), '.image-gen-mcp', 'images.jsonl');

// The JSONL ledger is on by default. IMAGE_GEN_MCP_LOG_FILE overrides the path, and
// "none"/"off"/"0"/"false"/empty disables file logging (stderr logging always stays on).
function resolveLogFile(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined) return DEFAULT_LOG_FILE;
  if (value === '' || ['none', 'off', '0', 'false'].includes(value.toLowerCase())) return undefined;
  return path.resolve(expandHome(value));
}
