import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { VERSION, expandHome, loadConfig, resolveAllowedDirs } from '../src/config.js';

describe('VERSION', () => {
  // readVersion matches on the package name while walking up, so renaming the
  // package without updating PACKAGE_NAME silently yields '0.0.0-unknown'. A
  // semver-shaped assertion would not catch that, since the fallback is also
  // semver shaped. Compare against the real package.json instead.
  it('matches the version in package.json', () => {
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
    assert.notEqual(VERSION, '0.0.0-unknown');
  });
});

describe('expandHome', () => {
  it('expands a bare tilde and a tilde prefix', () => {
    assert.equal(expandHome('~'), os.homedir());
    assert.equal(expandHome('~/pictures'), path.join(os.homedir(), 'pictures'));
  });

  it('leaves absolute, relative, and mid-string tildes alone', () => {
    assert.equal(expandHome('/tmp/x'), '/tmp/x');
    assert.equal(expandHome('./x'), './x');
    assert.equal(expandHome('/tmp/~x'), '/tmp/~x');
  });
});

describe('loadConfig provider defaulting', () => {
  it('defaults to gemini when only its key is set', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'g' });
    assert.equal(config.defaultProvider, 'gemini');
  });

  it('defaults to openai when only its key is set', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'o' });
    assert.equal(config.defaultProvider, 'openai');
  });

  it('prefers gemini when both keys are set', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' });
    assert.equal(config.defaultProvider, 'gemini');
  });

  it('has no default provider when no key is set', () => {
    assert.equal(loadConfig({}).defaultProvider, undefined);
  });

  it('honors an explicit override', () => {
    const config = loadConfig({
      GEMINI_API_KEY: 'g',
      OPENAI_API_KEY: 'o',
      IMAGE_GEN_MCP_DEFAULT_PROVIDER: 'openai',
    });
    assert.equal(config.defaultProvider, 'openai');
  });

  it('falls back to the key-based default when the override is not a known provider', () => {
    const config = loadConfig({ GEMINI_API_KEY: 'g', IMAGE_GEN_MCP_DEFAULT_PROVIDER: 'stability' });
    assert.equal(config.defaultProvider, 'gemini');
  });

  it('treats a whitespace-only key as unset', () => {
    assert.equal(loadConfig({ GEMINI_API_KEY: '   ' }).geminiApiKey, undefined);
  });
});

describe('loadConfig timeout', () => {
  it('defaults to 180 seconds', () => {
    assert.equal(loadConfig({}).requestTimeoutMs, 180_000);
  });

  it('accepts a positive override and ignores junk or non-positive values', () => {
    assert.equal(loadConfig({ IMAGE_GEN_MCP_TIMEOUT_MS: '5000' }).requestTimeoutMs, 5000);
    assert.equal(loadConfig({ IMAGE_GEN_MCP_TIMEOUT_MS: 'soon' }).requestTimeoutMs, 180_000);
    assert.equal(loadConfig({ IMAGE_GEN_MCP_TIMEOUT_MS: '-1' }).requestTimeoutMs, 180_000);
  });
});

describe('loadConfig log file', () => {
  const defaultLogFile = path.join(os.homedir(), '.image-gen-mcp', 'images.jsonl');

  it('defaults to the ledger under the home directory', () => {
    assert.equal(loadConfig({}).logFile, defaultLogFile);
  });

  it('disables the file for every documented off value', () => {
    for (const value of ['none', 'off', '0', 'false', 'NONE', 'Off', '']) {
      assert.equal(loadConfig({ IMAGE_GEN_MCP_LOG_FILE: value }).logFile, undefined, `value: ${value}`);
    }
  });

  it('expands a tilde and resolves a relative path to absolute', () => {
    assert.equal(
      loadConfig({ IMAGE_GEN_MCP_LOG_FILE: '~/logs/images.jsonl' }).logFile,
      path.join(os.homedir(), 'logs', 'images.jsonl'),
    );
    assert.ok(path.isAbsolute(loadConfig({ IMAGE_GEN_MCP_LOG_FILE: 'images.jsonl' }).logFile as string));
  });
});

describe('resolveAllowedDirs', () => {
  let root: string;
  let first: string;
  let second: string;

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-mcp-dirs-')));
    first = path.join(root, 'first');
    second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is undefined when unset or empty, which means no containment', () => {
    assert.equal(resolveAllowedDirs(undefined), undefined);
    assert.equal(resolveAllowedDirs(''), undefined);
    assert.equal(resolveAllowedDirs('  ,  ,'), undefined);
  });

  it('parses a comma separated list and ignores surrounding whitespace', () => {
    assert.deepEqual(resolveAllowedDirs(` ${first} , ${second} `), [first, second]);
  });

  it('deduplicates roots that resolve to the same directory', () => {
    assert.deepEqual(resolveAllowedDirs(`${first},${first}${path.sep}.`), [first]);
  });

  it('drops entries that do not exist while keeping the good ones', () => {
    assert.deepEqual(resolveAllowedDirs(`${first},${path.join(root, 'missing')}`), [first]);
  });

  it('drops an entry that is a file rather than a directory', () => {
    const file = path.join(root, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    assert.deepEqual(resolveAllowedDirs(`${first},${file}`), [first]);
  });

  // Fail closed. Returning undefined here would silently disable the restriction
  // the operator asked for, turning a typo into an unrestricted server.
  it('returns an empty list when every entry is unusable, refusing all access', () => {
    assert.deepEqual(resolveAllowedDirs(path.join(root, 'nope')), []);
  });

  it('resolves entries through realpath so symlinked roots compare correctly', () => {
    const link = path.join(root, 'link-to-first');
    fs.symlinkSync(first, link);
    assert.deepEqual(resolveAllowedDirs(link), [first]);
  });

  it('is wired into loadConfig', () => {
    assert.deepEqual(loadConfig({ IMAGE_GEN_MCP_ALLOWED_DIRS: first }).allowedDirs, [first]);
    assert.equal(loadConfig({}).allowedDirs, undefined);
  });
});
