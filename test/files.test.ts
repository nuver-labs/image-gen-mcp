import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Config } from '../src/config.js';
import {
  FileError,
  assertWithinAllowedDirs,
  correctExtensionForMime,
  detectMime,
  formatBytes,
  readImageSize,
  resolveOutputTargets,
  slugify,
  uniquePath,
} from '../src/files.js';

// Minimal config for the path resolution helpers. Individual tests override
// whichever field they are exercising.
function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    geminiModel: 'gemini-3.1-flash-image',
    openaiModel: 'gpt-image-2',
    requestTimeoutMs: 180_000,
    ...overrides,
  };
}

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(slugify('A Flat Paper Airplane'), 'a-flat-paper-airplane');
  });

  it('collapses runs of non-alphanumerics and trims the edges', () => {
    assert.equal(slugify('  hello???  world!!  '), 'hello-world');
  });

  it('caps the slug at 50 characters without a trailing hyphen', () => {
    const slug = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40));
    assert.ok(slug.length <= 50);
    assert.ok(!slug.endsWith('-'));
  });

  it('falls back to "image" when nothing survives', () => {
    assert.equal(slugify('!!!'), 'image');
    assert.equal(slugify(''), 'image');
  });

  it('does not leave a bare hyphen for non-latin prompts', () => {
    assert.equal(slugify('日本語のみ'), 'image');
  });
});

describe('formatBytes', () => {
  it('uses bytes, KB, and MB at the right thresholds', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });
});

// Header fixtures, hand built so the parsers are tested against real byte layouts
// rather than against whatever a library would produce.
function pngFixture(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegFixture(width: number, height: number): Buffer {
  // SOI, then a SOF0 segment carrying height before width.
  const buf = Buffer.alloc(11);
  buf.writeUInt16BE(0xffd8, 0);
  buf.writeUInt8(0xff, 2);
  buf.writeUInt8(0xc0, 3);
  buf.writeUInt16BE(17, 4);
  buf.writeUInt8(8, 6);
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function webpVp8lFixture(): Buffer {
  // VP8L packs 14-bit width-1 and height-1 across four bytes. These constants
  // decode to 256x128, worked out from the bit layout in readImageSize.
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(17, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0x2f, 20);
  buf.writeUInt8(255, 21);
  buf.writeUInt8(0xc0, 22);
  buf.writeUInt8(31, 23);
  buf.writeUInt8(0, 24);
  return buf;
}

function webpVp8Fixture(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

describe('readImageSize', () => {
  it('reads PNG IHDR dimensions', () => {
    assert.deepEqual(readImageSize(pngFixture(1536, 1024)), { width: 1536, height: 1024 });
  });

  it('reads JPEG SOF dimensions in the right order', () => {
    assert.deepEqual(readImageSize(jpegFixture(1024, 1536)), { width: 1024, height: 1536 });
  });

  it('reads WebP VP8L dimensions', () => {
    assert.deepEqual(readImageSize(webpVp8lFixture()), { width: 256, height: 128 });
  });

  it('reads WebP VP8 dimensions', () => {
    assert.deepEqual(readImageSize(webpVp8Fixture(640, 480)), { width: 640, height: 480 });
  });

  it('returns undefined instead of throwing on garbage or truncated input', () => {
    assert.equal(readImageSize(Buffer.alloc(0)), undefined);
    assert.equal(readImageSize(Buffer.from('not an image at all')), undefined);
    assert.equal(readImageSize(pngFixture(10, 10).subarray(0, 12)), undefined);
  });
});

describe('detectMime', () => {
  it('identifies formats from magic bytes, ignoring a misleading extension', () => {
    assert.equal(detectMime(pngFixture(1, 1), '/tmp/a.jpg'), 'image/png');
    assert.equal(detectMime(jpegFixture(1, 1), '/tmp/a.png'), 'image/jpeg');
    assert.equal(detectMime(webpVp8lFixture(), '/tmp/a.png'), 'image/webp');
  });

  it('rejects gif with an actionable message', () => {
    const gif = Buffer.from('GIF89a and then some bytes');
    assert.throws(() => detectMime(gif, '/tmp/a.gif'), (err: unknown) => {
      assert.ok(err instanceof FileError);
      assert.match(err.message, /image\/gif/);
      assert.match(err.message, /png, jpeg, webp/);
      return true;
    });
  });

  it('falls back to the extension when the bytes are unrecognized', () => {
    assert.equal(detectMime(Buffer.from('unknown bytes'), '/tmp/a.webp'), 'image/webp');
  });

  it('throws when neither the bytes nor the extension identify a format', () => {
    assert.throws(() => detectMime(Buffer.from('unknown bytes'), '/tmp/a.bin'), FileError);
  });
});

describe('uniquePath', () => {
  it('returns the candidate when nothing has claimed it', () => {
    const p = path.join(os.tmpdir(), 'image-gen-mcp-unique-nonexistent.png');
    assert.equal(uniquePath(p, new Set()), p);
  });

  it('suffixes past names already taken in this call', () => {
    const p = path.join(os.tmpdir(), 'image-gen-mcp-unique-nonexistent.png');
    const taken = new Set([p, path.join(os.tmpdir(), 'image-gen-mcp-unique-nonexistent-2.png')]);
    assert.equal(uniquePath(p, taken), path.join(os.tmpdir(), 'image-gen-mcp-unique-nonexistent-3.png'));
  });
});

describe('correctExtensionForMime', () => {
  it('leaves a path alone when the extension already matches', () => {
    const result = correctExtensionForMime('/tmp/a.png', 'image/png', new Set());
    assert.equal(result.path, '/tmp/a.png');
    assert.equal(result.note, undefined);
  });

  it('rewrites the extension and explains why when the provider returned another format', () => {
    const result = correctExtensionForMime('/tmp/a.png', 'image/jpeg', new Set());
    assert.equal(result.path, '/tmp/a.jpg');
    assert.match(result.note ?? '', /image\/jpeg/);
  });

  it('treats .jpg and .jpeg as the same format', () => {
    const result = correctExtensionForMime('/tmp/a.jpeg', 'image/jpeg', new Set());
    assert.equal(result.path, '/tmp/a.jpeg');
  });
});

describe('resolveOutputTargets', () => {
  let root: string;

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-mcp-out-')));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('honors an explicit file path and its extension', () => {
    const target = path.join(root, 'nested', 'cover.webp');
    const result = resolveOutputTargets({ outputPath: target, prompt: 'a cover', n: 1, config: testConfig() });
    assert.deepEqual(result.paths, [target]);
    assert.equal(result.format, 'webp');
  });

  it('derives a slugified name when given a directory', () => {
    const result = resolveOutputTargets({
      outputPath: path.join(root, 'dir-target'),
      prompt: 'A Flat Paper Airplane',
      n: 1,
      config: testConfig(),
    });
    assert.deepEqual(result.paths, [path.join(root, 'dir-target', 'a-flat-paper-airplane.png')]);
  });

  it('numbers the files when n is greater than one', () => {
    const result = resolveOutputTargets({
      outputPath: path.join(root, 'multi'),
      prompt: 'icon',
      n: 3,
      config: testConfig(),
    });
    assert.deepEqual(result.paths.map((p) => path.basename(p)), ['icon-1.png', 'icon-2.png', 'icon-3.png']);
  });

  it('replaces an unsupported extension with .png and says so', () => {
    const result = resolveOutputTargets({
      outputPath: path.join(root, 'weird.tiff'),
      prompt: 'x',
      n: 1,
      config: testConfig(),
    });
    assert.equal(result.format, 'png');
    assert.ok(result.notes.some((n) => n.includes('.tiff')));
  });

  it('falls back to IMAGE_GEN_MCP_OUTPUT_DIR ahead of CLAUDE_PROJECT_DIR', () => {
    const outputDir = path.join(root, 'from-output-dir');
    const result = resolveOutputTargets({
      prompt: 'fallback test',
      n: 1,
      config: testConfig({ outputDir, projectDir: path.join(root, 'from-project-dir') }),
    });
    assert.equal(path.dirname(result.paths[0] as string), outputDir);
    assert.ok(result.notes.some((n) => n.includes('IMAGE_GEN_MCP_OUTPUT_DIR')));
  });

  it('falls back to CLAUDE_PROJECT_DIR when no output dir is configured', () => {
    const projectDir = path.join(root, 'from-project-dir-only');
    const result = resolveOutputTargets({ prompt: 'fallback test', n: 1, config: testConfig({ projectDir }) });
    assert.equal(path.dirname(result.paths[0] as string), projectDir);
    assert.ok(result.notes.some((n) => n.includes('CLAUDE_PROJECT_DIR')));
  });

  it('prefers the source directory over both fallbacks for edits', () => {
    const preferredDir = path.join(root, 'beside-the-source');
    const result = resolveOutputTargets({
      prompt: 'edit',
      n: 1,
      config: testConfig({ outputDir: path.join(root, 'ignored') }),
      preferredDir,
    });
    assert.equal(path.dirname(result.paths[0] as string), preferredDir);
  });

  it('resolves a relative output path against the fallback directory', () => {
    const outputDir = path.join(root, 'relative-base');
    const result = resolveOutputTargets({
      outputPath: 'sub/cover.png',
      prompt: 'x',
      n: 1,
      config: testConfig({ outputDir }),
    });
    assert.equal(result.paths[0], path.join(outputDir, 'sub', 'cover.png'));
    assert.ok(result.notes.some((n) => n.includes('Relative output_path')));
  });

  it('never reuses a forbidden source path', () => {
    const forbidden = path.join(root, 'no-clobber', 'logo.png');
    const result = resolveOutputTargets({
      outputPath: forbidden,
      prompt: 'x',
      n: 1,
      config: testConfig(),
      forbidden: [forbidden],
    });
    assert.notEqual(result.paths[0], forbidden);
    assert.equal(path.basename(result.paths[0] as string), 'logo-2.png');
  });

  it('refuses an output outside the allowed roots without creating the directory', () => {
    const allowed = path.join(root, 'allowed-root');
    fs.mkdirSync(allowed, { recursive: true });
    const outside = path.join(root, 'outside-root');
    assert.throws(
      () =>
        resolveOutputTargets({
          outputPath: path.join(outside, 'x.png'),
          prompt: 'x',
          n: 1,
          config: testConfig({ allowedDirs: [allowed] }),
        }),
      FileError,
    );
    assert.equal(fs.existsSync(outside), false, 'a refused call must not create directories');
  });
});

describe('assertWithinAllowedDirs', () => {
  let root: string;
  let allowed: string;

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-mcp-allow-')));
    allowed = path.join(root, 'allow');
    fs.mkdirSync(allowed, { recursive: true });
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when containment is off', () => {
    assert.doesNotThrow(() => assertWithinAllowedDirs('/etc/passwd', undefined, 'output'));
  });

  it('refuses everything when the configuration named no usable directory', () => {
    assert.throws(() => assertWithinAllowedDirs(path.join(allowed, 'x.png'), [], 'output'), FileError);
  });

  it('accepts a path inside a root, and the root itself', () => {
    assert.doesNotThrow(() => assertWithinAllowedDirs(path.join(allowed, 'x.png'), [allowed], 'output'));
    assert.doesNotThrow(() => assertWithinAllowedDirs(allowed, [allowed], 'output'));
  });

  it('accepts a path that does not exist yet, several levels deep', () => {
    const deep = path.join(allowed, 'a', 'b', 'c', 'not-created-yet.png');
    assert.doesNotThrow(() => assertWithinAllowedDirs(deep, [allowed], 'output'));
  });

  it('rejects a .. traversal that escapes the root', () => {
    const escape = path.join(allowed, '..', 'escaped.png');
    assert.throws(() => assertWithinAllowedDirs(escape, [allowed], 'output'), FileError);
  });

  // The bug behind CVE-2025-53110: a startsWith prefix match accepts a sibling
  // directory whose name merely begins with the allowed root's name.
  it('rejects a sibling directory that shares a name prefix with the root', () => {
    const sibling = path.join(root, 'allow-secret');
    fs.mkdirSync(sibling, { recursive: true });
    assert.throws(() => assertWithinAllowedDirs(path.join(sibling, 'x.png'), [allowed], 'source'), FileError);
  });

  // The bug behind CVE-2025-53109: validating the literal path rather than the
  // symlink's real target.
  it('rejects a symlink inside the root that points outside it', () => {
    const secretDir = path.join(root, 'secret');
    fs.mkdirSync(secretDir, { recursive: true });
    const secretFile = path.join(secretDir, 'passport.png');
    fs.writeFileSync(secretFile, pngFixture(1, 1));
    const link = path.join(allowed, 'innocent.png');
    fs.symlinkSync(secretFile, link);
    assert.throws(() => assertWithinAllowedDirs(link, [allowed], 'source'), FileError);
  });

  it('rejects a file under a symlinked directory that points outside the root', () => {
    const secretDir = path.join(root, 'secret-dir');
    fs.mkdirSync(secretDir, { recursive: true });
    const linkDir = path.join(allowed, 'linked');
    fs.symlinkSync(secretDir, linkDir);
    assert.throws(() => assertWithinAllowedDirs(path.join(linkDir, 'x.png'), [allowed], 'output'), FileError);
  });

  it('accepts a path in any one of several roots', () => {
    const second = path.join(root, 'second-root');
    fs.mkdirSync(second, { recursive: true });
    assert.doesNotThrow(() => assertWithinAllowedDirs(path.join(second, 'x.png'), [allowed, second], 'output'));
  });

  it('names the rejected path and the allowed roots in the error', () => {
    try {
      assertWithinAllowedDirs('/etc/passwd', [allowed], 'source');
      assert.fail('expected a FileError');
    } catch (err) {
      assert.ok(err instanceof FileError);
      assert.match(err.message, /\/etc\/passwd/);
      assert.match(err.message, /IMAGE_GEN_MCP_ALLOWED_DIRS/);
      assert.ok(err.message.includes(allowed));
    }
  });
});
