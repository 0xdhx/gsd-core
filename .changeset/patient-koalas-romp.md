---
type: Fixed
pr: 5015
---
**With `GSD_HOME` set, `/gsd-new-project` now seeds the project config from the same `defaults.json` the config loader reads** — `config-new-project` (and every other command that creates `.planning/config.json`, such as `config-ensure-section`) read `defaults.json` and the per-provider `*_api_key` files from the home directory, while the config loader and its shadowed-global-defaults warning (#3532) read `$GSD_HOME/.gsd/`. One `/gsd-new-project` run therefore seeded the project from a different file than the one the loader had just resolved, detected search providers from the wrong key files, wrote the `depth` → `granularity` migration into the wrong `defaults.json`, and the warning named a file that never seeded the project. `config-new-project` and `init new-project` now resolve the store as `GSD_HOME`, falling back to the home directory, exactly like the loader. Nothing changes when `GSD_HOME` is unset. (#4976)
