import type { OutputFormat } from '../files.js';

export type ProviderName = 'gemini' | 'openai';

export type AspectRatio = '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '9:16' | '16:9' | '21:9';
export type ImageSize = '1K' | '2K' | '4K';
export type Quality = 'low' | 'medium' | 'high' | 'auto';
export type Background = 'transparent' | 'opaque' | 'auto';
export type InputFidelity = 'low' | 'high';

export interface SourceImage {
  path: string;
  data: Buffer;
  mimeType: string;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

export interface GenerateArgs {
  prompt: string;
  /** 1-4, validated by the tool schema. */
  n: number;
  /** Already resolved (per-call override, env override, or provider default). */
  model: string;
  aspectRatio?: AspectRatio | undefined;
  /** Gemini 3.x models only; silently ignored elsewhere. */
  imageSize?: ImageSize | undefined;
  /** OpenAI only. */
  quality?: Quality | undefined;
  /** OpenAI only. */
  background?: Background | undefined;
  outputFormat: OutputFormat;
  /** Called between long steps (e.g. the Gemini n-loop) to feed progress notifications. */
  onProgress?: ((message: string) => void) | undefined;
}

export interface EditArgs extends GenerateArgs {
  sources: SourceImage[];
  /** OpenAI only. */
  inputFidelity?: InputFidelity | undefined;
}

/** Normalized token usage across providers; missing fields mean the provider did not report them. */
export interface TokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  /** Provider-specific breakdown (token detail objects), logged verbatim. */
  details?: Record<string, unknown> | undefined;
}

export interface ProviderResult {
  images: GeneratedImage[];
  /** revised_prompt (OpenAI) or text parts (Gemini), when present. */
  text?: string | undefined;
  model: string;
  /** Human-readable, e.g. "1536x1024" or "16:9 @ 1K". */
  sizeDescription: string;
  /** Token usage reported by the provider, when available. */
  usage?: TokenUsage | undefined;
  /** Provider-side adjustments worth surfacing to the caller (e.g. model auto-switch). */
  notes?: string[] | undefined;
}

export interface ImageProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;
  readonly knownModels: string[];
  isConfigured(): boolean;
  generate(args: GenerateArgs): Promise<ProviderResult>;
  edit(args: EditArgs): Promise<ProviderResult>;
}

export type ProviderErrorKind = 'not_configured' | 'refused' | 'rate_limited' | 'api_error';

/** Expected failures whose message is safe to surface to the calling agent as-is. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
