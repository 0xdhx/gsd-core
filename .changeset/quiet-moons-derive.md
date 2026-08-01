---
type: Added
pr: 2677
---
**`runtime-homes` now exports its non-registry config-home descriptors** — `KIMI_HOOKS_TOML_DESCRIPTOR`, `NON_REGISTRY_CONFIG_HOME_DESCRIPTORS`, `GSD_LOCATION_ENV_KEYS`, and the `ConfigHomeDescriptor` type are public, so consumers that need the *set* of config-location env vars (rather than a single resolved path) can derive it instead of hand-maintaining a copy. `resolveKimiHooksTomlDir()` behaviour is unchanged; its descriptor is simply named rather than inline (#2665).
