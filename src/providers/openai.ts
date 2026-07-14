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
} from './types.js';
import { ProviderError } from './types.js';

type OpenAISize = '1024x1024' | '1536x1024' | '1024x1536';

const SIZE_BY_ASPECT: Record<AspectRatio, OpenAISize> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '4:3': '1536x1024',
  '16:9': '1536x1024',
  '21:9': '1536x1024',
  '2:3': '1024x1536',
  '3:4': '1024x1536',
  '9:16': '1024x1536',
};

export class OpenAIProvider implements ImageProvider {
  readonly name = 'openai' as const;
  readonly knownModels = ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'];
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

  private baseParams(args: GenerateArgs) {
    return {
      model: args.model,
      prompt: args.prompt,
      n: args.n,
      ...(args.aspectRatio && { size: SIZE_BY_ASPECT[args.aspectRatio] }),
      ...(args.quality && { quality: args.quality }),
      ...(args.background && { background: args.background }),
      // gpt-image models return png by default; only send an override.
      ...(args.outputFormat !== 'png' && { output_format: args.outputFormat }),
    };
  }

  async generate(args: GenerateArgs): Promise<ProviderResult> {
    const client = this.getClient();
    args.onProgress?.(`requesting ${args.n} image(s) from ${args.model}`);
    try {
      const res = await client.images.generate(this.baseParams(args));
      return this.parse(res, args);
    } catch (err) {
      throw mapError(err, args.model);
    }
  }

  async edit(args: EditArgs): Promise<ProviderResult> {
    const client = this.getClient();
    args.onProgress?.(`editing with ${args.model}`);
    try {
      const files = await Promise.all(
        args.sources.map((s) =>
          toFile(Readable.from(s.data), path.basename(s.path), { type: s.mimeType }),
        ),
      );
      const res = await client.images.edit({
        ...this.baseParams(args),
        image: files.length === 1 ? files[0]! : files,
        ...(args.inputFidelity && { input_fidelity: args.inputFidelity }),
      });
      return this.parse(res, args);
    } catch (err) {
      throw mapError(err, args.model);
    }
  }

  private parse(res: OpenAI.Images.ImagesResponse, args: GenerateArgs): ProviderResult {
    const data = res.data ?? [];
    const meta = res as { output_format?: string; size?: string };
    const images = data
      .filter((d) => d.b64_json)
      .map((d) => ({
        data: Buffer.from(d.b64_json as string, 'base64'),
        mimeType: `image/${meta.output_format ?? args.outputFormat}`,
      }));
    if (images.length === 0) {
      throw new ProviderError(`openai (${args.model}) returned no image data.`, 'api_error');
    }
    const sizeDescription =
      meta.size ?? (args.aspectRatio ? SIZE_BY_ASPECT[args.aspectRatio] : 'default size');
    return {
      images,
      text: data[0]?.revised_prompt ?? undefined,
      model: args.model,
      sizeDescription,
    };
  }
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
