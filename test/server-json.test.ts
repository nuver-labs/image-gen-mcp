import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// server.json is the MCP registry manifest. Nothing in the build reads it, so
// without these checks a mistake in it only surfaces as a 422 from the registry
// during a release, which is the worst possible moment to find out.
const root = path.join(import.meta.dirname, '..', '..');
const server = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8')) as {
  name: string;
  title: string;
  description: string;
  version: string;
  repository: { url: string; source: string };
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables: Array<{ name: string; description: string }>;
  }>;
};
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName: string;
};

describe('server.json registry constraints', () => {
  // The registry rejects anything longer with a 422. Learned the hard way.
  it('keeps description within the 100 character limit', () => {
    assert.ok(server.description.length >= 1, 'description must not be empty');
    assert.ok(
      server.description.length <= 100,
      `description is ${server.description.length} chars, limit is 100: "${server.description}"`,
    );
  });

  it('keeps title within the 100 character limit', () => {
    assert.ok(server.title.length >= 1 && server.title.length <= 100);
  });

  it('uses the DNS-authenticated namespace, not the io.github fallback', () => {
    assert.match(server.name, /^com\.nuverlabs\//);
  });
});

describe('server.json agrees with package.json', () => {
  // The registry cross-checks that server.json's name matches the mcpName field
  // inside the published npm package. Drift between these two fails the publish.
  it('name matches the package mcpName', () => {
    assert.equal(server.name, pkg.mcpName);
  });

  it('package identifier matches the published npm name', () => {
    assert.equal(server.packages[0]?.identifier, pkg.name);
  });

  // The release workflow stamps both version fields from package.json, so a
  // mismatch here only means the repo is untidy. Still worth catching, since a
  // manual mcp-publisher run uses whatever is committed.
  it('both version fields match package.json', () => {
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0]?.version, pkg.version);
  });
});

describe('server.json package block', () => {
  it('declares a single stdio npm package', () => {
    assert.equal(server.packages.length, 1);
    assert.equal(server.packages[0]?.registryType, 'npm');
    assert.equal(server.packages[0]?.transport.type, 'stdio');
  });

  it('documents every environment variable the server reads', () => {
    const declared = new Set(server.packages[0]?.environmentVariables.map((e) => e.name));
    for (const required of [
      'GEMINI_API_KEY',
      'OPENAI_API_KEY',
      'IMAGE_GEN_MCP_DEFAULT_PROVIDER',
      'IMAGE_GEN_MCP_GEMINI_MODEL',
      'IMAGE_GEN_MCP_OPENAI_MODEL',
      'IMAGE_GEN_MCP_OUTPUT_DIR',
      'IMAGE_GEN_MCP_ALLOWED_DIRS',
      'IMAGE_GEN_MCP_TIMEOUT_MS',
      'IMAGE_GEN_MCP_LOG_FILE',
    ]) {
      assert.ok(declared.has(required), `server.json does not document ${required}`);
    }
  });

  it('gives every environment variable a description', () => {
    for (const env of server.packages[0]?.environmentVariables ?? []) {
      assert.ok(env.description.length > 0, `${env.name} has no description`);
    }
  });
});
