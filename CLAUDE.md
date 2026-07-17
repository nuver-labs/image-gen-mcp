# CLAUDE.md

Project instructions for Claude when working in the image-gen-mcp repo.

## What this is

A standalone stdio MCP server that generates and edits images with Gemini and OpenAI using the user's own API keys. It is registered in Claude Code at user scope as `image-gen`, so every project on this machine can call its tools. This repo is the single owner of that server: code, docs, and conventions live here, not in the projects that consume it.

## Hard rules

- NEVER use em dashes or en dashes anywhere: code comments, docs, commit messages, tool descriptions, README. Use periods, commas, colons, parentheses, or plain hyphens.
- stdout belongs to the MCP JSON-RPC protocol. No `console.log` in `src/` (`smoke.ts` is the only exception, it is a standalone CLI). All diagnostics go through `log()` in `src/config.ts` (stderr).
- Never log, echo, or commit API key values. `list_capabilities` reports booleans only. Keys reach SDK constructors and nothing else.
- Expected failures return `{ isError: true, content: [text] }` with an actionable message; do not throw them across the MCP boundary. Use `ProviderError` (`src/providers/types.ts`) and `FileError` (`src/files.ts`).

## Commands

- `pnpm build`: compile (tsc, ESM NodeNext; relative imports need `.js` extensions)
- `pnpm inspect`: build, then list tools over real MCP stdio
- `node dist/smoke.js --provider gemini|openai [--edit path] [--out dir] [--model id]`: live provider test, costs real API cents
- Registration lives in `~/.claude.json` (user scope), command documented in README. Rebuilding `dist/` is enough for changes to apply; a new Claude Code session picks up the rebuilt server.

## Architecture

- `src/index.ts`: bootstrap (stdio transport, signal handling)
- `src/server.ts`: McpServer plus the 3 tools (`generate_image`, `edit_image`, `list_capabilities`), progress ticker, error mapping
- `src/config.ts`: env parsing (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `IMAGE_GEN_MCP_*` overrides including `IMAGE_GEN_MCP_LOG_FILE`), stderr `log()`
- `src/files.ts`: output path resolution (explicit > `IMAGE_GEN_MCP_OUTPUT_DIR` > `CLAUDE_PROJECT_DIR` > cwd), slugified collision-safe names, mime sniffing, extension correction (Gemini returns JPEG by default), `readImageSize` (header parse for PNG/JPEG/WebP dimensions), `logImageEvent` (per-image record to stderr plus the JSONL ledger)
- `src/providers/`: `ImageProvider` interface returning `ProviderResult` (carries normalized `TokenUsage` and optional `notes`); `openai.ts` (images.generate/edit, toFile multipart, maps `res.usage`; gpt-image-2 gets exact aspect-ratio sizes, never receives `input_fidelity`, and transparent-background calls auto-switch to gpt-image-1.5 with a result note); `gemini.ts` (generateContent, inlineData parts, single-retry wrapper, accumulates `res.usageMetadata` across the n-loop)

## Image logging

Every successful generate/edit logs one structured JSON record (provider, model, requested size, elapsed, truncated prompt + char count, token usage when reported, and a per-image list with path, bytes, human size, mime, actual pixel dimensions). It always goes to stderr via `log('image', ...)` and, unless disabled, is appended to the JSONL ledger at `IMAGE_GEN_MCP_LOG_FILE` (default `~/.image-gen-mcp/images.jsonl`; `none`/`off` disables the file). Ledger writes are guarded: a failure warns once and never breaks the tool call. Never add prompt or key material beyond the existing truncated prompt.

## Verification before claiming done

1. `pnpm build` exits 0
2. `pnpm inspect` shows exactly 3 tools
3. Keyless `node dist/index.js` prints only the stderr ready line, nothing on stdout
4. If provider behavior changed: one cheap live smoke per touched provider (`quality low` or the lite model) and Read the output image to confirm it is a real image. Smoke prints token `Usage` and per-image dimensions, confirm both look right
5. `grep -rn "console.log" src/` hits only `smoke.ts`
6. If logging changed: after a real generate, confirm one `image {...}` JSON line on stderr and a matching appended line in `~/.image-gen-mcp/images.jsonl` (or the configured `IMAGE_GEN_MCP_LOG_FILE`); `IMAGE_GEN_MCP_LOG_FILE=none` suppresses only the file

## Known re-check items

- Model defaults (`gemini-3.1-flash-image`, `gpt-image-2`) verified live 2026-07-17; revisit when providers ship new image models. gpt-image-2 does not support transparent backgrounds or `input_fidelity`; the transparency auto-switch to gpt-image-1.5 is a repo convention, keep it when touching the OpenAI provider.
- Gemini `generateContent` image docs are marked legacy; migrating to the Interactions API is planned future work, as are mask/inpainting support and npm publish.
