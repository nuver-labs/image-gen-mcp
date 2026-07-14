import type { Config } from '../config.js';
import { GeminiProvider } from './gemini.js';
import { OpenAIProvider } from './openai.js';
import type { ImageProvider, ProviderName } from './types.js';
import { ProviderError } from './types.js';

export interface Providers {
  gemini: GeminiProvider;
  openai: OpenAIProvider;
}

export function buildProviders(config: Config): Providers {
  return {
    gemini: new GeminiProvider(config),
    openai: new OpenAIProvider(config),
  };
}

const ENV_BY_PROVIDER: Record<ProviderName, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function resolveProvider(
  providers: Providers,
  config: Config,
  override?: ProviderName,
): ImageProvider {
  const name = override ?? config.defaultProvider;
  if (!name) {
    throw new ProviderError(
      'No image provider is configured. Set GEMINI_API_KEY and/or OPENAI_API_KEY in the MCP server environment and restart the session.',
      'not_configured',
    );
  }
  const provider = providers[name];
  if (!provider.isConfigured()) {
    const configured = (Object.keys(providers) as ProviderName[]).filter((p) =>
      providers[p].isConfigured(),
    );
    throw new ProviderError(
      `Provider '${name}' is not configured: ${ENV_BY_PROVIDER[name]} is not set in this MCP server's environment. ` +
        `Configured providers: ${configured.length > 0 ? configured.join(', ') : 'none'}. ` +
        `Re-register with: claude mcp add image-gen -s user -e ${ENV_BY_PROVIDER[name]}=<key> -- node <abs-path>/dist/index.js`,
      'not_configured',
    );
  }
  return provider;
}
