import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config.js';
import type {
  EditArgs,
  GenerateArgs,
  GeneratedImage,
  ImageProvider,
  ProviderResult,
} from './types.js';
import { ProviderError } from './types.js';

// Models with fixed output resolution reject the imageSize option.
const NO_IMAGE_SIZE_MODELS = ['gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];

type GeminiContents = string | Array<{ role: string; parts: Array<Record<string, unknown>> }>;

export class GeminiProvider implements ImageProvider {
  readonly name = 'gemini' as const;
  readonly knownModels = [
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image',
  ];
  private client: GoogleGenAI | undefined;

  constructor(private readonly config: Config) {}

  get defaultModel(): string {
    return this.config.geminiModel;
  }

  isConfigured(): boolean {
    return Boolean(this.config.geminiApiKey);
  }

  private getClient(): GoogleGenAI {
    this.client ??= new GoogleGenAI({
      apiKey: this.config.geminiApiKey,
      httpOptions: { timeout: this.config.requestTimeoutMs },
    });
    return this.client;
  }

  private buildConfig(args: GenerateArgs) {
    const imageSize =
      args.imageSize && !NO_IMAGE_SIZE_MODELS.some((m) => args.model.startsWith(m))
        ? args.imageSize
        : undefined;
    return {
      responseModalities: ['TEXT', 'IMAGE'],
      ...((args.aspectRatio || imageSize) && {
        imageConfig: {
          ...(args.aspectRatio && { aspectRatio: args.aspectRatio }),
          ...(imageSize && { imageSize }),
        },
      }),
    };
  }

  private async callOnce(
    contents: GeminiContents,
    args: GenerateArgs,
  ): Promise<{ images: GeneratedImage[]; texts: string[] }> {
    const ai = this.getClient();
    const res = await withRetry(() =>
      ai.models.generateContent({
        model: args.model,
        contents,
        config: this.buildConfig(args),
      }),
    );
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const images: GeneratedImage[] = [];
    const texts: string[] = [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        images.push({
          data: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType ?? 'image/png',
        });
      } else if (part.text) {
        texts.push(part.text);
      }
    }
    if (images.length === 0) {
      const finish = res.candidates?.[0]?.finishReason;
      const block = res.promptFeedback?.blockReason;
      const said = texts.join(' ').trim();
      throw new ProviderError(
        `gemini (${args.model}) returned no image` +
          `${finish ? ` (finishReason: ${finish})` : ''}` +
          `${block ? ` (blockReason: ${block})` : ''}.` +
          `${said ? ` Provider said: "${said}".` : ''}` +
          ' Rephrase the prompt and try again.',
        'refused',
      );
    }
    return { images, texts };
  }

  async generate(args: GenerateArgs): Promise<ProviderResult> {
    try {
      return await this.loop(args.prompt, args);
    } catch (err) {
      throw mapError(err, args.model);
    }
  }

  async edit(args: EditArgs): Promise<ProviderResult> {
    const contents: GeminiContents = [
      {
        role: 'user',
        parts: [
          { text: args.prompt },
          ...args.sources.map((s) => ({
            inlineData: { mimeType: s.mimeType, data: s.data.toString('base64') },
          })),
        ],
      },
    ];
    try {
      return await this.loop(contents, args);
    } catch (err) {
      throw mapError(err, args.model);
    }
  }

  // Gemini returns one image per call, so n images means n sequential calls.
  private async loop(contents: GeminiContents, args: GenerateArgs): Promise<ProviderResult> {
    const images: GeneratedImage[] = [];
    const texts: string[] = [];
    for (let i = 1; i <= args.n; i++) {
      const r = await this.callOnce(contents, args);
      images.push(...r.images);
      texts.push(...r.texts);
      if (args.n > 1) args.onProgress?.(`image ${i} of ${args.n} done`);
    }
    const sizeDescription = `${args.aspectRatio ?? 'default aspect'}${
      args.imageSize ? ` @ ${args.imageSize}` : ''
    }`;
    return {
      images,
      text: texts.join(' ').trim() || undefined,
      model: args.model,
      sizeDescription,
    };
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return fn();
  }
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === 429 || status === 500 || status === 503) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(msg);
}

function mapError(err: unknown, model: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status === 429) {
    return new ProviderError(
      `gemini (${model}) rate limited the request (429) even after retrying: ${msg}. Wait and retry, or pass provider: 'openai'.`,
      'rate_limited',
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderError(
      `gemini request failed (${status}): ${msg}. Check GEMINI_API_KEY in the MCP registration.`,
      'api_error',
    );
  }
  return new ProviderError(
    `gemini (${model}) request failed${status ? ` (${status})` : ''}: ${msg}`,
    'api_error',
  );
}
