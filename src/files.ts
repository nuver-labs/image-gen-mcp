import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { expandHome, log } from './config.js';
import type { TokenUsage } from './providers/types.js';

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

// Best-effort pixel dimensions parsed from the image header. Providers either omit dimensions
// (Gemini) or only report one of a few preset sizes (OpenAI), so we read them from the bytes.
// Returns undefined for anything unrecognized, truncated, or malformed.
export function readImageSize(buffer: Buffer): { width: number; height: number } | undefined {
  try {
    // PNG: signature then IHDR width/height as big-endian uint32.
    if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // JPEG: walk segment markers to the start-of-frame, which holds 16-bit height then width.
    if (buffer.length >= 4 && buffer.readUInt16BE(0) === 0xffd8) {
      let offset = 2;
      while (offset + 4 <= buffer.length) {
        if (buffer.readUInt8(offset) !== 0xff) {
          offset += 1;
          continue;
        }
        let marker = buffer.readUInt8(offset + 1);
        while (marker === 0xff && offset + 2 < buffer.length) {
          offset += 1;
          marker = buffer.readUInt8(offset + 1);
        }
        // Standalone markers (SOI, EOI, RSTn, TEM) carry no length payload.
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          offset += 2;
          continue;
        }
        // SOF markers (0xC0-0xCF) hold the dimensions, except DHT/JPG/DAC (0xC4/0xC8/0xCC).
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          if (offset + 9 > buffer.length) break;
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
      return undefined;
    }

    // WebP: RIFF container with a WEBP fourCC, then one of three frame formats.
    if (
      buffer.length >= 16 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const format = buffer.toString('ascii', 12, 16);
      if (format === 'VP8 ' && buffer.length >= 30) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
      if (format === 'VP8L' && buffer.length >= 25) {
        const b1 = buffer.readUInt8(21);
        const b2 = buffer.readUInt8(22);
        const b3 = buffer.readUInt8(23);
        const b4 = buffer.readUInt8(24);
        return {
          width: 1 + (((b2 & 0x3f) << 8) | b1),
          height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
        };
      }
      if (format === 'VP8X' && buffer.length >= 30) {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Resolves a path through realpath so the containment check compares real paths.
// The target often does not exist yet (an output file, or a directory about to be
// created), so walk up to the nearest existing ancestor, resolve that, and rejoin
// the remaining segments. Checking only the literal path would let a symlinked
// parent directory escape the root, and skipping the check when the path does not
// exist is the hole that made CVE-2025-53109 exploitable.
function realpathThroughAncestor(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Confines a path to the configured allowed roots. No-op when containment is off
 * (allowedDirs undefined). An empty array means the configuration named no usable
 * directory, and everything is refused rather than silently allowed.
 *
 * Containment is tested with path.relative, not startsWith: a prefix match would
 * accept "/data/photos-private" for the root "/data/photos", which is exactly the
 * separator bug behind CVE-2025-53110.
 */
export function assertWithinAllowedDirs(
  candidate: string,
  allowedDirs: string[] | undefined,
  kind: 'output' | 'source',
): void {
  if (allowedDirs === undefined) return;

  const resolved = realpathThroughAncestor(candidate);
  const contained = allowedDirs.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  });
  if (contained) return;

  const roots = allowedDirs.length > 0 ? allowedDirs.join(', ') : '(none usable)';
  const what = kind === 'output' ? 'Output path' : 'Source image';
  throw new FileError(
    `${what} ${candidate} is outside the directories this server is allowed to use. ` +
      `Allowed: ${roots}. Choose a path inside one of them, or change IMAGE_GEN_MCP_ALLOWED_DIRS in the server environment.`,
  );
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

  // Checked before mkdirSync so a refused call never leaves directories behind.
  assertWithinAllowedDirs(dir, args.config.allowedDirs, 'output');

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

export interface LoggedImage {
  path: string;
  bytes: number;
  /** Human-readable size, e.g. "120.6 KB". */
  size: string;
  mimeType: string;
  width?: number | undefined;
  height?: number | undefined;
}

/** One structured record per successful generate/edit call, emitted to stderr and the JSONL ledger. */
export interface ImageLogEntry {
  ts: string;
  event: 'generate_image' | 'edit_image';
  provider: string;
  model: string;
  /** Requested size description, e.g. "1536x1024" or "16:9 @ 1K". */
  requestedSize: string;
  /** Images requested (n). */
  requested: number;
  /** Images actually produced. */
  produced: number;
  elapsedSeconds: number;
  promptChars: number;
  /** Prompt, truncated for the log. */
  prompt: string;
  /** Source image count, edit_image only. */
  sources?: number | undefined;
  usage?: TokenUsage | undefined;
  /** revised_prompt (OpenAI) or text parts (Gemini), truncated. */
  providerText?: string | undefined;
  images: LoggedImage[];
}

let ledgerWarned = false;

// Always logs the record to stderr; also appends it to the JSONL ledger when a path is configured.
// A ledger write failure never breaks the tool call: it warns once, then stays quiet.
export function logImageEvent(entry: ImageLogEntry, logFile?: string): void {
  const line = JSON.stringify(entry);
  log('image', line);
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + '\n');
  } catch (err) {
    if (!ledgerWarned) {
      ledgerWarned = true;
      log(
        `warning: could not write image log to ${logFile}: ${err instanceof Error ? err.message : String(err)}.` +
          ' Further ledger write errors will be suppressed.',
      );
    }
  }
}
