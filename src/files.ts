import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';

export type OutputFormat = 'png' | 'jpeg' | 'webp';

// Errors whose message is safe and useful to show to the calling agent as-is.
export class FileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileError';
  }
}

const EXT_BY_FORMAT: Record<OutputFormat, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };
const FORMAT_BY_EXT: Record<string, OutputFormat> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
};
const MIME_BY_FORMAT: Record<OutputFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const FORMAT_BY_MIME: Record<string, OutputFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
};

export function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'image';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mimeForFormat(format: OutputFormat): string {
  return MIME_BY_FORMAT[format];
}

export function detectMime(buffer: Buffer, sourcePath: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'GIF8') {
    throw new FileError(`Unsupported input image type for ${sourcePath} (detected image/gif). Supported: png, jpeg, webp.`);
  }
  const byExt = FORMAT_BY_EXT[path.extname(sourcePath).toLowerCase()];
  if (byExt) return MIME_BY_FORMAT[byExt];
  throw new FileError(`Unsupported input image type for ${sourcePath}. Supported: png, jpeg, webp.`);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function fallbackDir(config: Config, preferredDir?: string): { dir: string; source: string } {
  if (preferredDir) return { dir: preferredDir, source: 'the source image directory' };
  if (config.outputDir) return { dir: expandHome(config.outputDir), source: 'IMAGE_GEN_MCP_OUTPUT_DIR' };
  if (config.projectDir) return { dir: config.projectDir, source: 'CLAUDE_PROJECT_DIR' };
  return { dir: process.cwd(), source: 'the server working directory' };
}

export function uniquePath(candidate: string, taken: ReadonlySet<string>): string {
  if (!fs.existsSync(candidate) && !taken.has(candidate)) return candidate;
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext);
  for (let i = 2; ; i++) {
    const next = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(next) && !taken.has(next)) return next;
  }
}

export interface ResolvedOutputs {
  paths: string[];
  format: OutputFormat;
  notes: string[];
}

export interface ResolveOutputArgs {
  outputPath?: string | undefined;
  prompt: string;
  n: number;
  config: Config;
  /** Absolute paths that must never be overwritten (edit sources). */
  forbidden?: string[] | undefined;
  /** Overrides the front of the fallback chain (edit_image: first source's directory). */
  preferredDir?: string | undefined;
}

export function resolveOutputTargets(args: ResolveOutputArgs): ResolvedOutputs {
  const notes: string[] = [];
  const taken = new Set((args.forbidden ?? []).map((p) => path.resolve(p)));

  let dir: string;
  let stem: string;
  let format: OutputFormat = 'png';

  const raw = args.outputPath?.trim();
  if (raw) {
    let p = expandHome(raw);
    if (!path.isAbsolute(p)) {
      const fb = fallbackDir(args.config, args.preferredDir);
      p = path.resolve(fb.dir, p);
      notes.push(`Relative output_path resolved against ${fb.source}: ${p}`);
    }
    const ext = path.extname(p);
    const isDir = (fs.existsSync(p) && fs.statSync(p).isDirectory()) || raw.endsWith('/') || ext === '';
    if (isDir) {
      dir = p;
      stem = slugify(args.prompt);
    } else {
      dir = path.dirname(p);
      stem = path.basename(p, ext);
      const requested = FORMAT_BY_EXT[ext.toLowerCase()];
      if (requested) {
        format = requested;
      } else {
        notes.push(`Unsupported output extension "${ext}" replaced with .png`);
      }
    }
  } else {
    const fb = fallbackDir(args.config, args.preferredDir);
    dir = fb.dir;
    stem = slugify(args.prompt);
    notes.push(`No output_path given; saving to ${fb.source} (${dir})`);
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new FileError(`Could not create output directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ext = EXT_BY_FORMAT[format];
  const paths: string[] = [];
  for (let i = 1; i <= args.n; i++) {
    const name = args.n === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    const chosen = uniquePath(path.join(dir, name), taken);
    taken.add(chosen);
    paths.push(chosen);
  }
  return { paths, format, notes };
}

export function correctExtensionForMime(
  filePath: string,
  mimeType: string,
  taken: ReadonlySet<string>,
): { path: string; note?: string } {
  const actual = FORMAT_BY_MIME[mimeType.toLowerCase()];
  if (!actual) return { path: filePath };
  const currentExt = path.extname(filePath).toLowerCase();
  if (FORMAT_BY_EXT[currentExt] === actual) return { path: filePath };
  const swapped = filePath.slice(0, filePath.length - currentExt.length) + EXT_BY_FORMAT[actual];
  const unique = uniquePath(swapped, taken);
  return { path: unique, note: `Provider returned ${mimeType}; saved as ${path.basename(unique)}` };
}
