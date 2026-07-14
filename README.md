# image-gen-mcp

A stdio MCP server that lets Claude Code (or any MCP client) generate and edit images with your own API keys. Ask Claude for a blog cover, a logo tweak, or a placeholder illustration, and the file lands directly in your project.

Backed by Google Gemini image models (Nano Banana family) and OpenAI GPT image models behind a single interface. Configure one provider or both.

## Requirements

- Node 22+
- pnpm (for building from source)
- A Gemini API key, an OpenAI API key, or both

## Build

```bash
pnpm install
pnpm build
```

## Register in Claude Code (user scope, available in every project)

```bash
claude mcp add image-gen -s user \
  -e GEMINI_API_KEY=your-gemini-key \
  -e OPENAI_API_KEY=your-openai-key \
  -- node /Users/vernu/Documents/work-files/personal-projects/image-gen-mcp/dist/index.js
```

Notes:

- The server name (`image-gen`) must come before the `-e` flags. A name placed directly after an `-e` pair is parsed as another env assignment.
- Omit the `-e` line for any provider you do not use.
- Adjust the `dist/index.js` path if this repo lives somewhere else on your machine.
- Start a NEW Claude Code session to pick up the server, then verify with `claude mcp list`.

## Use it from Claude Code

Once registered, just ask in any project:

- "Generate a 16:9 blog cover about SMS gateways and save it to assets/blog/sms-gateway-cover.png"
- "Take public/logo.png and give it a transparent background" (transparency needs `provider: openai`)
- "Create 3 variations of a flat paper airplane icon, square, into design/drafts/"

Claude calls `generate_image` or `edit_image` with an absolute `output_path` inside your project, the file lands on disk, and Claude can Read the saved path to look at the result and iterate. If a call fails, ask Claude to run `list_capabilities` to see what is configured.

### Project scope (.mcp.json)

```json
{
  "mcpServers": {
    "image-gen": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/vernu/Documents/work-files/personal-projects/image-gen-mcp/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your-gemini-key",
        "OPENAI_API_KEY": "your-openai-key"
      },
      "timeout": 600000
    }
  }
}
```

### Claude Desktop

Add the same `command`, `args`, and `env` object under `mcpServers.image-gen` in `~/Library/Application Support/Claude/claude_desktop_config.json` (there is no `timeout` field there).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | (unset) | Enables the Gemini provider |
| `OPENAI_API_KEY` | (unset) | Enables the OpenAI provider |
| `IMAGE_GEN_MCP_DEFAULT_PROVIDER` | key-based | `gemini` or `openai`. When unset: gemini if its key is set, else openai |
| `IMAGE_GEN_MCP_GEMINI_MODEL` | `gemini-3.1-flash-image` | Default Gemini model |
| `IMAGE_GEN_MCP_OPENAI_MODEL` | `gpt-image-1.5` | Default OpenAI model |
| `IMAGE_GEN_MCP_OUTPUT_DIR` | (unset) | Fallback output directory when the tool call has no `output_path` |
| `IMAGE_GEN_MCP_TIMEOUT_MS` | `180000` | Per-request timeout to the provider API |
| `IMAGE_GEN_MCP_LOG_FILE` | `~/.image-gen-mcp/images.jsonl` | JSONL ledger path for the per-image log. Set an absolute path to relocate it, or `none`/`off` to disable the file (stderr logging stays on) |

When no `output_path` is passed, files are saved to the first of: `IMAGE_GEN_MCP_OUTPUT_DIR`, `CLAUDE_PROJECT_DIR` (set automatically by Claude Code, points at the current project), the server working directory.

## Logging

Every successful `generate_image` and `edit_image` call records a structured JSON entry, two ways:

- **stderr** (always): one `[image-gen-mcp] image {...}` line, visible in `/mcp` output and Claude Code logs.
- **JSONL ledger** (on by default): the same JSON appended to `~/.image-gen-mcp/images.jsonl`, one line per call. Relocate it with `IMAGE_GEN_MCP_LOG_FILE=/abs/path.jsonl` or disable the file with `IMAGE_GEN_MCP_LOG_FILE=none`. Ledger write failures never break a generation; they warn once on stderr.

Each entry captures the provider, model, requested size, elapsed seconds, a truncated prompt (plus its full character count), token usage when the provider reports it, and a per-image list with the saved path, byte size, human-readable size, mime type, and actual pixel dimensions. Review recent activity with `tail -n 20 ~/.image-gen-mcp/images.jsonl` or query with `jq` (for example, total tokens today: `jq 'select(.usage) | .usage.totalTokens' ~/.image-gen-mcp/images.jsonl`). API keys are never logged.

## Tools

### generate_image

Generate one or more images from a text prompt and save them to disk. Returns the absolute saved path(s).

| Argument | Type | Notes |
|---|---|---|
| `prompt` | string, required | Subject, style, composition, colors, any text to render |
| `output_path` | string | Absolute file path (.png/.jpg/.webp) or directory; filename derived from the prompt when a directory |
| `provider` | `gemini` \| `openai` | Overrides the default provider |
| `model` | string | Overrides the model. Gemini: gemini-3.1-flash-image, gemini-3.1-flash-lite-image, gemini-3-pro-image, gemini-2.5-flash-image. OpenAI: gpt-image-1.5, gpt-image-1, gpt-image-1-mini |
| `aspect_ratio` | `1:1` `2:3` `3:2` `3:4` `4:3` `9:16` `16:9` `21:9` | Native on Gemini; OpenAI approximates (landscape 1536x1024, portrait 1024x1536) |
| `n` | 1-4 | Gemini generates sequentially, so n>1 is slower there |
| `quality` | `low` `medium` `high` `auto` | OpenAI only; `low` for cheap drafts |
| `background` | `transparent` `opaque` `auto` | OpenAI only; `transparent` is ideal for logos and icons |
| `image_size` | `1K` `2K` `4K` | Gemini 3.x only |
| `return_image` | boolean | Also return the first image inline so the model can see it (costs context tokens) |

### edit_image

Edit or combine existing images with a text instruction. Never overwrites source files.

Everything from `generate_image` plus:

| Argument | Type | Notes |
|---|---|---|
| `source_paths` | string[], required | 1-16 absolute paths (.png/.jpg/.jpeg/.webp). First is the edit target, extras act as references. Gemini works best with 1-3 |
| `input_fidelity` | `low` \| `high` | OpenAI only. `high` preserves faces, logos, and fine detail |

When `output_path` is omitted, the result is saved next to the first source image.

### list_capabilities

No arguments. Reports which providers are configured (booleans only, never key values), default provider and models, known model options, and the output directory fallback chain.

## Costs

Every `generate_image` and `edit_image` call hits a paid API and typically costs cents per image (varies by provider, model, quality, and size). Cheap options for drafts: OpenAI `quality: low` or `gpt-image-1-mini`; Gemini `gemini-3.1-flash-lite-image`. Gemini's `gemini-2.5-flash-image` may have a free tier on unbilled keys: set `IMAGE_GEN_MCP_GEMINI_MODEL=gemini-2.5-flash-image` to default to it.

## Timeouts

Image generation takes roughly 10-120 seconds depending on model and size. Claude Code defaults are generous (wall-clock limit is hours, stdio idle timeout is 30 minutes, and this server sends progress notifications during long calls), so no tuning is normally needed. If you set a tight global `MCP_TOOL_TIMEOUT`, add a per-server `"timeout": 600000` in `.mcp.json` as shown above.

## Local testing

```bash
# List tools over real MCP stdio
pnpm inspect

# Live generation test (costs one cheap image)
GEMINI_API_KEY=... node dist/smoke.js --provider gemini
OPENAI_API_KEY=... node dist/smoke.js --provider openai

# Live edit test
node dist/smoke.js --provider gemini --edit ./smoke-output/smoke-gen-gemini.png
```

## Troubleshooting

- Server logs go to stderr with an `[image-gen-mcp]` prefix; Claude Code surfaces them in `/mcp` output and its logs.
- Registered but tools missing: start a new Claude Code session; check `claude mcp list` and `claude mcp get image-gen`.
- `Provider 'x' is not configured`: the API key env var is missing from the MCP registration. Re-register with the `-e` flag or edit `.mcp.json`.
- Large `return_image` responses can exceed the MCP output token limit (`MAX_MCP_OUTPUT_TOKENS`, default 25k). Leave `return_image` off and let Claude Read the saved file instead.
- Gemini refusals include the finish reason and any provider text; rephrase the prompt.

## Future work

- OpenAI mask/inpainting support
- Gemini Interactions API migration (generateContent image docs are marked legacy)
- gpt-image-2 once it appears in the official Images API model list
- npm publish for `npx image-gen-mcp` installs
- More providers (Stability, BFL Flux, xAI)
