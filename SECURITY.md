# Security policy

## Reporting a vulnerability

Report security issues privately to **security@nuverlabs.com**, or open a
[private security advisory](https://github.com/nuver-labs/image-gen-mcp/security/advisories/new)
on this repository. Please do not open a public issue for a vulnerability.

Include what you need to demonstrate the issue: the version, the configuration
(environment variables, MCP client), the tool call or input that triggers it,
and what you expected to happen instead. A minimal reproduction helps more than
anything else.

We aim to acknowledge a report within 3 business days and to ship a fix or a
mitigation plan within 30 days. You will be credited in the release notes unless
you ask not to be.

## Supported versions

Fixes land on the latest published version. There are no long term support
branches. Upgrade with `npx -y image-gen-mcp@latest`, or bump the pinned version
in your MCP client configuration.

## What this server does with your data

- **API keys** are read only from `GEMINI_API_KEY` and `OPENAI_API_KEY`, passed
  to the provider SDK constructors, and used nowhere else. They are never
  logged, never written to the image ledger, and never returned by
  `list_capabilities`, which reports configured providers as booleans only.
- **Prompts** are sent to the provider you select. A truncated copy is written
  to the local JSONL ledger. Disable the ledger with `IMAGE_GEN_MCP_LOG_FILE=none`.
- **Source images** passed to `edit_image` are read from disk and uploaded to the
  selected provider. Constrain which files are reachable with
  `IMAGE_GEN_MCP_ALLOWED_DIRS`.
- **Nothing is sent anywhere else.** There is no telemetry, no analytics, and no
  network call other than to the provider API you configured.

The README's [Security](README.md#security) section carries the full threat
model, including the file access boundary and hardening recommendations. Read it
before granting this server blanket tool approval.
