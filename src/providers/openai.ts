import path from 'node:path';
import { Readable } from 'node:stream';
import OpenAI, { toFile } from 'openai';
import type { Config } from '../config.js';
import type {
  AspectRatio,
  EditArgs,
  GenerateArgs,
  ImageProvider,
  ProviderResult,
  TokenUsage,
} from './types.js';
import { ProviderError } from './types.js';

// Older gpt-image models only support these three sizes, so ratios are approximated.
const SIZE_BY_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '4:3': '1536x1024',
  '16:9': '1536x1024',
  '21:9': '1536x1024',
  '2:3': '1024x1536',
  '3:4': '1024x1536',
  '9:16': '1024x1536',
};

// gpt-image-2 accepts near-arbitrary sizes (edges multiples of 16, max edge 3840,
// ratio up to 3:1, 655,360-8,294,400 total pixels), so ratios are honored exactly.
const IMAGE2_SIZE_BY_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '4:3': '1536x1152',
  '16:9': '1792x1008',
  '21:9': '2352x1008',
  '2:3': '1024x1536',
  '3:4': '1152x1536',
  '9:16': '1008x1792',
};

function isImage2(model: string): boolean {
  return model.startsWith('gpt-image-2');
}

function sizeForAspect(model: string, aspectRatio: AspectRatio): string {
  return isImage2(model) ? IMAGE2_SIZE_BY_ASPECT[aspectRatio] : SIZE_BY_ASPECT[aspectRatio];
}

// gpt-image-2 rejects background transparent, so those calls fall back to this model.
const TRANSPARENT_CAPABLE_MODEL = 'gpt-image-1.5';

export class OpenAIProvider implements ImageProvider {
  readonly name = 'openai' as const;
  readonly knownModels = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'];
  private client: OpenAI | undefined;

  constructor(private readonly config: Config) {}

  get defaultModel(): string {
    return this.config.openaiModel;
  }

  isConfigured(): boolean {
    return Boolean(this.config.openaiApiKey);
  }

  private getClient(): OpenAI {
    this.client ??= new OpenAI({
      apiKey: this.config.openaiApiKey,
      timeout: this.config.requestTimeoutMs,
      maxRetries: 1,
    });
    return this.client;
  }

  // gpt-image-2 does not support transparent backgrounds; such calls run on
  // TRANSPARENT_CAPABLE_MODEL instead, with a note surfaced to the caller.
  private resolveModel(args: GenerateArgs): { model: string; notes: string[] } {
    if (args.background === 'transparent' && isImage2(args.model)) {
      return {
        model: TRANSPARENT_CAPABLE_MODEL,
        notes: [
          `${args.model} does not support transparent backgrounds; used ${TRANSPARENT_CAPABLE_MODEL} for this call.`,
        ],
      };
    }
    return { model: args.model, notes: [] };
  }

  private baseParams(args: GenerateArgs, model: string) {
    return {
      model,
      prompt: args.prompt,
      n: args.n,
      ...(args.aspectRatio && { size: sizeForAspect(model, args.aspectRatio) }),
      ...(args.quality && { quality: args.quality }),
      ...(args.background && { background: args.background }),
      // gpt-image models return png by default; only send an override.
      ...(args.outputFormat !== 'png' && { output_format: args.outputFormat }),
    };
  }

  async generate(args: GenerateArgs): Promise<ProviderResult> {
    const client = this.getClient();
    const { model, notes } = this.resolveModel(args);
    args.onProgress?.(`requesting ${args.n} image(s) from ${model}`);
    try {
      const res = await client.images.generate(this.baseParams(args, model));
      return this.parse(res, args, model, notes);
    } catch (err) {
      throw mapError(err, model);
    }
  }

  async edit(args: EditArgs): Promise<ProviderResult> {
    const client = this.getClient();
    const { model, notes } = this.resolveModel(args);
    if (args.inputFidelity && isImage2(model)) {
      notes.push(
        `${model} always processes inputs at high fidelity; input_fidelity was ignored.`,
      );
    }
    args.onProgress?.(`editing with ${model}`);
    try {
      const files = await Promise.all(
        args.sources.map((s) =>
          toFile(Readable.from(s.data), path.basename(s.path), { type: s.mimeType }),
        ),
      );
      const res = await client.images.edit({
        ...this.baseParams(args, model),
        image: files.length === 1 ? files[0]! : files,
        ...(args.inputFidelity && !isImage2(model) && { input_fidelity: args.inputFidelity }),
      });
      return this.parse(res, args, model, notes);
    } catch (err) {
      throw mapError(err, model);
    }
  }

  private parse(
    res: OpenAI.Images.ImagesResponse,
    args: GenerateArgs,
    model: string,
    notes: string[],
  ): ProviderResult {
    const data = res.data ?? [];
    const meta = res as { output_format?: string; size?: string };
    const images = data
      .filter((d) => d.b64_json)
      .map((d) => ({
        data: Buffer.from(d.b64_json as string, 'base64'),
        mimeType: `image/${meta.output_format ?? args.outputFormat}`,
      }));
    if (images.length === 0) {
      throw new ProviderError(`openai (${model}) returned no image data.`, 'api_error');
    }
    const sizeDescription =
      meta.size ?? (args.aspectRatio ? sizeForAspect(model, args.aspectRatio) : 'default size');
    return {
      images,
      text: data[0]?.revised_prompt ?? undefined,
      model,
      sizeDescription,
      usage: normalizeUsage(res.usage),
      ...(notes.length > 0 && { notes }),
    };
  }
}

function normalizeUsage(usage: OpenAI.Images.ImagesResponse.Usage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    details: {
      input_tokens_details: usage.input_tokens_details,
      ...(usage.output_tokens_details && { output_tokens_details: usage.output_tokens_details }),
    },
  };
}

function mapError(err: unknown, model: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const msg = err.message;
    if (status === 401 || status === 403) {
      return new ProviderError(
        `openai request failed (${status}): ${msg}. Check OPENAI_API_KEY in the MCP registration.`,
        'api_error',
      );
    }
    if (status === 429) {
      return new ProviderError(
        `openai (${model}) rate limited the request (429) even after retrying: ${msg}. Wait and retry, or pass provider: 'gemini'.`,
        'rate_limited',
      );
    }
    if (status === 400 && /moderation|content policy|safety system/i.test(msg)) {
      return new ProviderError(
        `openai (${model}) refused the request: ${msg}. Rephrase the prompt and try again.`,
        'refused',
      );
    }
    return new ProviderError(
      `openai (${model}) request failed (${status ?? 'network'}): ${msg}`,
      'api_error',
    );
  }
  return new ProviderError(
    `openai (${model}) request failed: ${err instanceof Error ? err.message : String(err)}`,
    'api_error',
  );
}
