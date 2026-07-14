// Live smoke test that exercises the provider layer directly, bypassing MCP.
// stdout is fine here: this is a standalone CLI, not the MCP server process.
//
//   node dist/smoke.js --provider gemini
//   node dist/smoke.js --provider openai --prompt "a red circle"
//   node dist/smoke.js --provider gemini --edit ./smoke-output/some-image.png
//   node dist/smoke.js --provider openai --out /tmp/smoke --model gpt-image-1-mini

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { correctExtensionForMime, detectMime, formatBytes, resolveOutputTargets } from './files.js';
import { buildProviders, resolveProvider } from './providers/index.js';
import type { ProviderResult } from './providers/types.js';

const DEFAULT_PROMPT = 'a minimal flat icon of a paper airplane, single color on a white background';
const EDIT_PROMPT = 'add a thin blue border around the image';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    prompt: { type: 'string', default: DEFAULT_PROMPT },
    edit: { type: 'string' },
    out: { type: 'string', default: './smoke-output' },
    model: { type: 'string' },
  },
});

const providerName = values.provider;
if (providerName !== 'gemini' && providerName !== 'openai') {
  console.error(
    'Usage: node dist/smoke.js --provider gemini|openai [--prompt "..."] [--edit /path/to/image.png] [--out dir] [--model id]',
  );
  process.exit(1);
}

try {
  const config = loadConfig(process.env);
  const providers = buildProviders(config);
  const provider = resolveProvider(providers, config, providerName);
  const model = values.model ?? provider.defaultModel;
  const started = Date.now();

  let result: ProviderResult;
  if (values.edit) {
    const abs = path.resolve(values.edit);
    if (!fs.existsSync(abs)) {
      console.error(`SMOKE FAILED: input image not found: ${abs}`);
      process.exit(1);
    }
    const data = fs.readFileSync(abs);
    console.log(`Editing ${abs} with ${provider.name} (${model})...`);
    result = await provider.edit({
      prompt: EDIT_PROMPT,
      sources: [{ path: abs, data, mimeType: detectMime(data, abs) }],
      n: 1,
      model,
      outputFormat: 'png',
      quality: providerName === 'openai' ? 'low' : undefined,
    });
  } else {
    console.log(`Generating with ${provider.name} (${model}): "${values.prompt}"`);
    result = await provider.generate({
      prompt: values.prompt as string,
      n: 1,
      model,
      outputFormat: 'png',
      quality: providerName === 'openai' ? 'low' : undefined,
    });
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const targets = resolveOutputTargets({
    outputPath: values.out,
    prompt: `smoke-${values.edit ? 'edit' : 'gen'}-${providerName}`,
    n: result.images.length,
    config,
  });
  const taken = new Set(targets.paths);
  result.images.forEach((img, idx) => {
    const planned = targets.paths[idx] as string;
    const corrected = correctExtensionForMime(planned, img.mimeType, taken);
    fs.writeFileSync(corrected.path, img.data);
    taken.add(corrected.path);
    console.log(`Saved ${corrected.path} (${formatBytes(img.data.length)})`);
  });
  if (result.text) console.log(`Provider note: ${result.text}`);
  console.log(`OK: ${result.images.length} image(s) with ${provider.name} (${result.model}) in ${elapsed}s`);
} catch (err) {
  console.error('SMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
}
