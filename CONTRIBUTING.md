# Contributing

Thanks for taking an interest. This is a small, focused MCP server, and it stays
that way on purpose. Bug fixes, provider quirk handling, and documentation
improvements are always welcome. For anything larger, open an issue first so we
can agree on the shape before you spend time on it.

## Development setup

Requires Node 22 or newer and pnpm.

```bash
git clone https://github.com/nuver-labs/image-gen-mcp.git
cd image-gen-mcp
pnpm install
pnpm build
```

## The loop

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # node:test, no API keys needed
pnpm build       # compile to dist/
pnpm inspect     # build, then list the tools over real MCP stdio
```

`pnpm test` and `pnpm inspect` are what CI runs. Both work without API keys, so
you can develop the whole server offline apart from the provider calls
themselves.

To test against a live provider:

```bash
GEMINI_API_KEY=... node dist/smoke.js --provider gemini
OPENAI_API_KEY=... node dist/smoke.js --provider openai --quality low
```

**`smoke.js` spends real money.** Every run hits a paid image API and costs cents
per image. Use `--quality low` on OpenAI or `--model gemini-3.1-flash-lite-image`
on Gemini while iterating, and do not put it in a loop.

## House rules

These are not style preferences, they are correctness constraints:

1. **stdout belongs to the MCP JSON-RPC protocol.** No `console.log` anywhere in
   `src/`. All diagnostics go through `log()` in `src/config.ts`, which writes to
   stderr. The one exception is `src/smoke.ts`, a standalone CLI that never
   speaks MCP. CI fails the build if `console.log` appears anywhere else.
2. **Never log, echo, or commit API key values.** Keys go from the environment to
   the provider SDK constructors and nowhere else. `list_capabilities` reports
   booleans.
3. **Expected failures do not throw across the MCP boundary.** Return
   `{ isError: true, content: [text] }` with a message the calling agent can act
   on. Use `ProviderError` (`src/providers/types.ts`) and `FileError`
   (`src/files.ts`).
4. **Never use em dashes or en dashes**, in code comments, docs, commit messages,
   or tool descriptions. Use periods, commas, colons, parentheses, or plain
   hyphens.
5. **ESM with NodeNext resolution.** Relative imports need the `.js` extension,
   even from `.ts` files.

## Tests

Tests use the Node built-in runner, so there is no test framework dependency.
Add cases to `test/*.test.ts`. Anything that touches path resolution or the
allowed-directory containment needs a test, including the negative cases: a
`..` traversal, a sibling directory that shares a name prefix with an allowed
root, and a symlink pointing outside a root.

## Pull requests

Keep commits atomic and use conventional commit prefixes (`fix:`, `feat:`,
`docs:`, `refactor:`). PR titles are plain descriptive sentences without a
prefix.

Before you open a PR, confirm:

- `pnpm typecheck`, `pnpm test`, and `pnpm build` all pass
- `pnpm inspect` still lists exactly 3 tools
- A keyless `node dist/index.js` prints the ready line on stderr and nothing on
  stdout
- If you touched a provider, one live smoke run against it, and you looked at the
  resulting image

## Releases

Maintainers only. Releases are driven by the `version` field in `package.json`.
Bump it, merge to `main`, and the release workflow publishes to npm with
provenance, tags the commit, and creates the GitHub release. The PR carrying the
version bump is the release proposal.
