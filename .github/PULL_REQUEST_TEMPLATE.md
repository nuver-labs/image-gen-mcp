## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What was broken or missing. Skip if the title says it. -->

## Checks

- [ ] `pnpm typecheck`, `pnpm test`, and `pnpm build` pass
- [ ] `pnpm inspect` still lists exactly 3 tools
- [ ] Keyless `node dist/index.js` prints the ready line on stderr and nothing on stdout
- [ ] No `console.log` added under `src/` (`src/smoke.ts` is the only exception)
- [ ] No API key value is logged, returned, or committed
- [ ] No em dashes or en dashes anywhere, including comments and this PR

## Provider changes only

- [ ] One live smoke run against each provider touched, and I looked at the resulting image
- [ ] Token usage and pixel dimensions print correctly

## Notes for the reviewer

<!-- Anything surprising: a provider quirk, a deliberate tradeoff, a follow-up. -->
