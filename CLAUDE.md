# CLAUDE.md

Project instructions for Claude when working in the image-gen-mcp repo.

## What this is

A standalone stdio MCP server that generates and edits images with Gemini and
OpenAI using the user's own API keys. It is published to npm as `image-gen-mcp`
and to the MCP registry as `com.nuverlabs/image-gen`, under the Nuver Labs
GitHub org. This repo is the single owner of that server: code, docs, and
conventions live here, not in the projects that consume it.

Users install it with `npx -y image-gen-mcp`. Never reintroduce absolute local
paths into the README or tool messages.

## Hard rules

- NEVER use em dashes or en dashes anywhere: code comments, docs, commit messages, tool descriptions, README. Use periods, commas, colons, parentheses, or plain hyphens.
- stdout belongs to the MCP JSON-RPC protocol. No `console.log` in `src/` (`smoke.ts` is the only exception, it is a standalone CLI). All diagnostics go through `log()` in `src/config.ts` (stderr). `index.ts` writes to stdout only for `--version` and `--help`, which exit before the transport connects.
- Never log, echo, or commit API key values. `list_capabilities` reports booleans only. Keys reach SDK constructors and nothing else.
- Expected failures return `{ isError: true, content: [text] }` with an actionable message; do not throw them across the MCP boundary. Use `ProviderError` (`src/providers/types.ts`) and `FileError` (`src/files.ts`).
- The three tool names and their input schemas are a published contract. Renaming a tool or removing a field needs a major version.

## Commands

- `pnpm build`: compile (tsc, ESM NodeNext; relative imports need `.js` extensions), then chmod the bin
- `pnpm typecheck`: tsc `--noEmit`
- `pnpm test`: node:test unit suite, no API keys needed
- `pnpm inspect`: build, then list tools over real MCP stdio
- `node dist/smoke.js --provider gemini|openai [--edit path] [--out dir] [--model id]`: live provider test, costs real API cents

## Architecture

- `src/index.ts`: bootstrap (`--version`/`--help` short circuit, stdio transport, signal handling)
- `src/server.ts`: McpServer plus the 3 tools (`generate_image`, `edit_image`, `list_capabilities`), tool annotations, progress ticker, error mapping
- `src/config.ts`: env parsing (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `IMAGE_GEN_MCP_*` overrides), `VERSION` resolved by walking up to the nearest `package.json` named `image-gen-mcp`, shared `expandHome`, `resolveAllowedDirs`, stderr `log()`
- `src/files.ts`: output path resolution (explicit > `IMAGE_GEN_MCP_OUTPUT_DIR` > `CLAUDE_PROJECT_DIR` > cwd), `assertWithinAllowedDirs` containment, slugified collision-safe names, mime sniffing, extension correction (Gemini returns JPEG by default), `readImageSize` (header parse for PNG/JPEG/WebP dimensions), `logImageEvent`
- `src/providers/`: `ImageProvider` interface returning `ProviderResult` (carries normalized `TokenUsage` and optional `notes`); `openai.ts` (images.generate/edit, toFile multipart, maps `res.usage`; gpt-image-2 gets exact aspect-ratio sizes, never receives `input_fidelity`, and transparent-background calls auto-switch to gpt-image-1.5 with a result note); `gemini.ts` (generateContent, inlineData parts, single-retry wrapper, accumulates `res.usageMetadata` across the n-loop)
- `test/`: node:test suites compiled by `tsconfig.test.json` into `.test-build/`, which is gitignored and excluded from the published tarball

## Path containment

`IMAGE_GEN_MCP_ALLOWED_DIRS` is opt-in. Unset means no containment, which is the
default and what makes the tool useful. An empty resolved list (every configured
entry was bad) means refuse everything, so a typo cannot silently disable the
restriction the operator asked for.

Two rules when touching this code, both of which have real CVEs behind them:

1. Compare with `path.relative`, never `startsWith`. A prefix match accepts
   `/data/photos-private` for the root `/data/photos` (CVE-2025-53110).
2. Resolve through `realpath`, including for paths that do not exist yet, by
   walking up to the nearest existing ancestor. Skipping the check on ENOENT is
   what made CVE-2025-53109 exploitable.

Both call sites matter, but `edit_image`'s `source_paths` matters more: those
bytes get uploaded to a provider, so an uncontained source path is an
exfiltration channel, not just a read.

## Image logging

Every successful generate/edit logs one structured JSON record (provider, model, requested size, elapsed, truncated prompt + char count, token usage when reported, and a per-image list with path, bytes, human size, mime, actual pixel dimensions). It always goes to stderr via `log('image', ...)` and, unless disabled, is appended to the JSONL ledger at `IMAGE_GEN_MCP_LOG_FILE` (default `~/.image-gen-mcp/images.jsonl`; `none`/`off` disables the file). Ledger writes are guarded: a failure warns once and never breaks the tool call. Never add prompt or key material beyond the existing truncated prompt.

## Releasing

Driven by the `version` field in `package.json`. Bump it, merge to `main`, and
`.github/workflows/release.yaml` publishes to npm with OIDC trusted publishing
(provenance attestation, no npm token), publishes to the MCP registry, tags the
commit, and creates the GitHub release. The PR carrying the bump is the release
proposal.

`server.json` versions are stamped from `package.json` during release, so a
version bump only ever touches `package.json`.

## Verification before claiming done

1. `pnpm typecheck` and `pnpm test` pass
2. `pnpm build` exits 0
3. `pnpm inspect` shows exactly 3 tools, each with annotations
4. Keyless `node dist/index.js` prints only the stderr ready line, nothing on stdout
5. `grep -rn "console.log" src/` hits only `smoke.ts`
6. `npm pack --dry-run` ships only `dist`, `README.md`, `LICENSE`, `package.json`
7. If provider behavior changed: one cheap live smoke per touched provider (`quality low` or the lite model) and Read the output image to confirm it is a real image. Smoke prints token `Usage` and per-image dimensions, confirm both look right
8. If logging changed: after a real generate, confirm one `image {...}` JSON line on stderr and a matching appended line in `~/.image-gen-mcp/images.jsonl`; `IMAGE_GEN_MCP_LOG_FILE=none` suppresses only the file
9. If path handling changed: the containment tests in `test/files.test.ts` must still cover the `..` traversal, the sibling name-prefix case, and both symlink escapes

## Known re-check items

- Model defaults (`gemini-3.1-flash-image`, `gpt-image-2`) verified live 2026-07-17; revisit when providers ship new image models. A public repo with stale model defaults reads worse than no repo, so this needs a periodic pass.
- gpt-image-2 does not support transparent backgrounds or `input_fidelity`; the transparency auto-switch to gpt-image-1.5 is a repo convention, keep it when touching the OpenAI provider.
- Gemini `generateContent` image docs are marked legacy; migrating to the Interactions API is planned future work, as are mask/inpainting support.
