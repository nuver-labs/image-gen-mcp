import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { VERSION, log } from './config.js';
import {
  FileError,
  correctExtensionForMime,
  detectMime,
  formatBytes,
  logImageEvent,
  readImageSize,
  resolveOutputTargets,
  uniquePath,
} from './files.js';
import type { ImageLogEntry } from './files.js';
import { buildProviders, resolveProvider } from './providers/index.js';
import type { GeneratedImage, ProviderResult, SourceImage, TokenUsage } from './providers/types.js';
import { ProviderError } from './providers/types.js';

const sharedInput = {
  output_path: z
    .string()
    .optional()
    .describe(
      'Absolute path strongly recommended. Either a full file path (.png/.jpg/.webp) or a directory (a slugified filename is derived from the prompt). If omitted: $IMAGE_GEN_MCP_OUTPUT_DIR, then $CLAUDE_PROJECT_DIR, then the server cwd.',
    ),
  provider: z
    .enum(['gemini', 'openai'])
    .optional()
    .describe('Override the default provider. Call list_capabilities to see what is configured.'),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model. Gemini: gemini-3.1-flash-image (default), gemini-3.1-flash-lite-image, gemini-3-pro-image, gemini-2.5-flash-image. OpenAI: gpt-image-1.5 (default), gpt-image-1, gpt-image-1-mini.',
    ),
  aspect_ratio: z
    .enum(['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'])
    .optional()
    .describe(
      'Gemini supports all values natively. OpenAI approximates: landscape -> 1536x1024, portrait -> 1024x1536, 1:1 -> 1024x1024.',
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe('Number of images, 1-4 (default 1). Gemini generates sequentially, so n>1 is slower there.'),
  quality: z
    .enum(['low', 'medium', 'high', 'auto'])
    .optional()
    .describe('OpenAI only, ignored by Gemini. Use low for cheap drafts.'),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .optional()
    .describe('OpenAI only, ignored by Gemini. transparent yields alpha PNG/WebP, ideal for logos and icons.'),
  image_size: z
    .enum(['1K', '2K', '4K'])
    .optional()
    .describe('Gemini 3.x models only (ignored by OpenAI; gemini-2.5-flash-image is fixed at 1024px). Default 1K.'),
  return_image: z
    .boolean()
    .optional()
    .describe(
      'Default false. When true, also returns the FIRST image as an inline MCP image block so you can see it without a Read. Large images can exceed the MCP output token limit; for 2K/4K prefer Read on the saved path.',
    ),
};

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Array<TextContent | ImageContent>; isError?: boolean };

function errorResult(err: unknown): ToolResult {
  if (err instanceof ProviderError || err instanceof FileError) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
  log('unexpected error:', err instanceof Error ? (err.stack ?? err.message) : err);
  return {
    isError: true,
    content: [
      { type: 'text', text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` },
    ],
  };
}

interface ProgressExtra {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

function startTicker(extra: ProgressExtra, initialMessage: string) {
  const token = extra._meta?.progressToken;
  let progress = 0;
  const send = (message: string) => {
    if (token === undefined) return;
    progress += 1;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message },
      })
      .catch(() => {});
  };
  send(initialMessage);
  const started = Date.now();
  const interval =
    token === undefined
      ? undefined
      : setInterval(
          () => send(`Still generating, ${Math.round((Date.now() - started) / 1000)}s elapsed`),
          10_000,
        );
  return {
    tick: send,
    stop: () => {
      if (interval) clearInterval(interval);
    },
  };
}

interface SavedImage {
  path: string;
  bytes: number;
  mimeType: string;
  width?: number | undefined;
  height?: number | undefined;
}

function writeImages(
  images: GeneratedImage[],
  plannedPaths: string[],
  extraNotes: string[],
): SavedImage[] {
  const taken = new Set(plannedPaths);
  const saved: SavedImage[] = [];
  images.forEach((img, idx) => {
    let target = plannedPaths[idx];
    if (!target) {
      // A provider returned more images than requested; derive extra names from the first.
      const first = plannedPaths[0] ?? path.join(process.cwd(), 'image.png');
      const ext = path.extname(first);
      target = uniquePath(first.slice(0, first.length - ext.length) + `-${idx + 1}${ext}`, taken);
    }
    const corrected = correctExtensionForMime(target, img.mimeType, taken);
    if (corrected.note) extraNotes.push(corrected.note);
    fs.writeFileSync(corrected.path, img.data);
    taken.add(corrected.path);
    const dimensions = readImageSize(img.data);
    saved.push({
      path: corrected.path,
      bytes: img.data.length,
      mimeType: img.mimeType,
      width: dimensions?.width,
      height: dimensions?.height,
    });
  });
  return saved;
}

const PROMPT_LOG_LIMIT = 500;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

// Emits one structured record (stderr always, JSONL ledger when configured) per successful call.
function logImages(
  event: ImageLogEntry['event'],
  config: Config,
  providerName: string,
  result: ProviderResult,
  saved: SavedImage[],
  prompt: string,
  requested: number,
  elapsedSeconds: number,
  sources?: number,
): void {
  const entry: ImageLogEntry = {
    ts: new Date().toISOString(),
    event,
    provider: providerName,
    model: result.model,
    requestedSize: result.sizeDescription,
    requested,
    produced: saved.length,
    elapsedSeconds,
    promptChars: prompt.length,
    prompt: truncate(prompt, PROMPT_LOG_LIMIT),
    ...(sources !== undefined && { sources }),
    ...(result.usage && { usage: result.usage }),
    ...(result.text && { providerText: truncate(result.text, PROMPT_LOG_LIMIT) }),
    images: saved.map((s) => ({
      path: s.path,
      bytes: s.bytes,
      size: formatBytes(s.bytes),
      mimeType: s.mimeType,
      width: s.width,
      height: s.height,
    })),
  };
  logImageEvent(entry, config.logFile);
}

function tokenLines(usage: TokenUsage | undefined): string[] {
  if (!usage) return [];
  const parts = [
    usage.inputTokens !== undefined ? `input ${usage.inputTokens}` : null,
    usage.outputTokens !== undefined ? `output ${usage.outputTokens}` : null,
    usage.totalTokens !== undefined ? `total ${usage.totalTokens}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? [`Tokens: ${parts.join(', ')}.`] : [];
}

function successResult(
  action: 'Generated' | 'Edited',
  providerName: string,
  result: ProviderResult,
  saved: SavedImage[],
  notes: string[],
  elapsedSeconds: string,
  returnImage: boolean,
): ToolResult {
  const lines = [
    `${action} ${saved.length} image${saved.length === 1 ? '' : 's'} with ${providerName} (model ${result.model}, ${result.sizeDescription}) in ${elapsedSeconds}s.`,
    'Saved:',
    ...saved.map((s) => {
      const dim = s.width && s.height ? `${s.width}x${s.height}, ` : '';
      return `- ${s.path} (${dim}${formatBytes(s.bytes)})`;
    }),
    ...tokenLines(result.usage),
    ...notes.map((n) => `Note: ${n}`),
    ...(result.text ? [`Provider note: ${result.text}`] : []),
  ];
  const content: Array<TextContent | ImageContent> = [{ type: 'text', text: lines.join('\n') }];
  const first = result.images[0];
  if (returnImage && first) {
    content.push({ type: 'image', data: first.data.toString('base64'), mimeType: first.mimeType });
  }
  return { content };
}

export function createServer(config: Config): McpServer {
  const server = new McpServer({ name: 'image-gen-mcp', version: VERSION });
  const providers = buildProviders(config);

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description:
        'Generate one or more images from a text prompt using Gemini or OpenAI image models and save them to disk. Returns the absolute saved file path(s) plus provider/model metadata. Strongly prefer passing an absolute output_path inside the current project so the file lands where you can use it. Each image costs real API credits.',
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(32000)
          .describe('What to generate. Be specific: subject, style, composition, colors, any text to render.'),
        ...sharedInput,
      },
    },
    async (input, extra) => {
      const ticker = startTicker(extra as unknown as ProgressExtra, 'Preparing generation...');
      try {
        const provider = resolveProvider(providers, config, input.provider);
        const model = input.model ?? provider.defaultModel;
        const n = input.n ?? 1;
        const targets = resolveOutputTargets({
          outputPath: input.output_path,
          prompt: input.prompt,
          n,
          config,
        });
        ticker.tick(`Calling ${provider.name} (${model})...`);
        const started = Date.now();
        const result = await provider.generate({
          prompt: input.prompt,
          n,
          model,
          aspectRatio: input.aspect_ratio,
          imageSize: input.image_size,
          quality: input.quality,
          background: input.background,
          outputFormat: targets.format,
          onProgress: (m) => ticker.tick(m),
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const notes = [...targets.notes];
        const saved = writeImages(result.images, targets.paths, notes);
        logImages('generate_image', config, provider.name, result, saved, input.prompt, n, Number(elapsed));
        return successResult(
          'Generated',
          provider.name,
          result,
          saved,
          notes,
          elapsed,
          input.return_image ?? false,
        );
      } catch (err) {
        return errorResult(err);
      } finally {
        ticker.stop();
      }
    },
  );

  server.registerTool(
    'edit_image',
    {
      title: 'Edit image',
      description:
        'Edit or combine existing image file(s) using a text instruction: modify elements, restyle, add or remove content, or merge references. Reads the source image(s) from disk, saves the result as a NEW file (never overwrites sources), and returns the absolute saved path(s).',
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(32000)
          .describe('The edit instruction, e.g. "make the background transparent" or "restyle as a flat vector logo".'),
        source_paths: z
          .array(z.string().min(1))
          .min(1)
          .max(16)
          .describe(
            'Absolute paths to existing input images (.png/.jpg/.jpeg/.webp). The first is the primary edit target; extras act as references. OpenAI accepts up to 16; Gemini works best with 1-3.',
          ),
        input_fidelity: z
          .enum(['low', 'high'])
          .optional()
          .describe('OpenAI only. high preserves faces, logos, and fine details from the input more faithfully.'),
        ...sharedInput,
      },
    },
    async (input, extra) => {
      const ticker = startTicker(extra as unknown as ProgressExtra, 'Preparing edit...');
      try {
        const provider = resolveProvider(providers, config, input.provider);
        const model = input.model ?? provider.defaultModel;
        const n = input.n ?? 1;
        const sources: SourceImage[] = input.source_paths.map((p) => {
          const abs = path.resolve(p);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            throw new FileError(
              `Input image not found: ${p}. source_paths must be absolute paths to existing .png/.jpg/.jpeg/.webp files.`,
            );
          }
          const data = fs.readFileSync(abs);
          return { path: abs, data, mimeType: detectMime(data, abs) };
        });
        const firstSource = sources[0] as SourceImage;
        const targets = resolveOutputTargets({
          outputPath: input.output_path,
          prompt: input.prompt,
          n,
          config,
          forbidden: sources.map((s) => s.path),
          preferredDir: path.dirname(firstSource.path),
        });
        ticker.tick(`Calling ${provider.name} (${model})...`);
        const started = Date.now();
        const result = await provider.edit({
          prompt: input.prompt,
          sources,
          n,
          model,
          aspectRatio: input.aspect_ratio,
          imageSize: input.image_size,
          quality: input.quality,
          background: input.background,
          inputFidelity: input.input_fidelity,
          outputFormat: targets.format,
          onProgress: (m) => ticker.tick(m),
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const notes = [...targets.notes];
        const saved = writeImages(result.images, targets.paths, notes);
        logImages(
          'edit_image',
          config,
          provider.name,
          result,
          saved,
          input.prompt,
          n,
          Number(elapsed),
          sources.length,
        );
        return successResult(
          'Edited',
          provider.name,
          result,
          saved,
          notes,
          elapsed,
          input.return_image ?? false,
        );
      } catch (err) {
        return errorResult(err);
      } finally {
        ticker.stop();
      }
    },
  );

  server.registerTool(
    'list_capabilities',
    {
      title: 'List image provider capabilities',
      description:
        'Report which image providers (gemini, openai) are configured in this server, the default provider and models, known model options, and the output directory fallback. Call this first if unsure what is available or why a call failed.',
    },
    async () => {
      const caps = {
        defaultProvider: config.defaultProvider ?? null,
        providers: {
          gemini: {
            configured: providers.gemini.isConfigured(),
            defaultModel: config.geminiModel,
            knownModels: providers.gemini.knownModels,
            notes:
              'aspect_ratio + image_size supported on 3.x models; n>1 is sequential' +
              (providers.gemini.isConfigured() ? '' : '; set GEMINI_API_KEY to enable'),
          },
          openai: {
            configured: providers.openai.isConfigured(),
            defaultModel: config.openaiModel,
            knownModels: providers.openai.knownModels,
            notes:
              'quality, background transparent, input_fidelity supported' +
              (providers.openai.isConfigured() ? '' : '; set OPENAI_API_KEY to enable'),
          },
        },
        outputFallback: {
          IMAGE_GEN_MCP_OUTPUT_DIR: config.outputDir ?? '(unset)',
          CLAUDE_PROJECT_DIR: config.projectDir ?? '(unset)',
          cwd: process.cwd(),
        },
        requestTimeoutMs: config.requestTimeoutMs,
        version: VERSION,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(caps, null, 2) }] };
    },
  );

  return server;
}
