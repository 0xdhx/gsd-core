---
type: Fixed
pr: 0
---
**An unknown runtime id is refused instead of installing into Claude Code's directory, and the shell launcher no longer probes the retired Gemini home** — `getGlobalConfigDir('gemini-typo')` and the other runtime accessors used to answer with `~/.claude` and the Claude label for any id they did not know, and the `gsd_run` launcher kept probing `GEMINI_CONFIG_DIR` while omitting zcode, pi and kimi; every accessor now throws `UnknownRuntimeError`, and the launcher's home list is generated from the same runtime descriptors the JS resolver reads. The stale-bake warning now resolves the active runtime the way every other consumer does (`GSD_RUNTIME`, then `config.runtime`, then the install marker), so it also fires for an install that names its runtime only through the marker. (#5169)
