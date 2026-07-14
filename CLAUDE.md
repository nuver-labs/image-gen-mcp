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
- `src/config.ts`: env parsing (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `IMAGE_GEN_MCP_*` overrides), stderr `log()`
- `src/files.ts`: output path resolution (explicit > `IMAGE_GEN_MCP_OUTPUT_DIR` > `CLAUDE_PROJECT_DIR` > cwd), slugified collision-safe names, mime sniffing, extension correction (Gemini returns JPEG by default)
- `src/providers/`: `ImageProvider` interface; `openai.ts` (images.generate/edit, toFile multipart); `gemini.ts` (generateContent, inlineData parts, single-retry wrapper)

## Verification before claiming done

1. `pnpm build` exits 0
2. `pnpm inspect` shows exactly 3 tools
3. Keyless `node dist/index.js` prints only the stderr ready line, nothing on stdout
4. If provider behavior changed: one cheap live smoke per touched provider (`quality low` or the lite model) and Read the output image to confirm it is a real image
5. `grep -rn "console.log" src/` hits only `smoke.ts`

## Known re-check items

- Model defaults (`gemini-3.1-flash-image`, `gpt-image-1.5`) verified live 2026-07-14; revisit when providers ship new image models (gpt-image-2 was announced but absent from the official Images API model list at that date).
- Gemini `generateContent` image docs are marked legacy; migrating to the Interactions API is planned future work, as are mask/inpainting support and npm publish.
