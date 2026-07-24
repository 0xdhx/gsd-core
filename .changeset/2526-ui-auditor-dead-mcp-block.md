---
type: Fixed
pr: 0
---
**`gsd-ui-auditor` no longer documents an uncallable Playwright-MCP capture path** — the agent's `tools:` allowlist grants no MCP namespace, so the `<playwright_mcp_approach>` block it presented as "preferred" could never dispatch: the availability check had a fixed answer, the three `mcp__playwright__*` calls were unreachable, and the CLI fallback was the only branch that ever ran. The dead block is removed, leaving the CLI screenshot path as the sole documented approach, and a new consistency test fails any `agents/*.md` that documents an `mcp__<server>__*` namespace its own `tools:` line withholds. Session-level Playwright-MCP capture in `/gsd-ui-review` is unaffected — that path is genuinely runtime-detected. (#2526)
