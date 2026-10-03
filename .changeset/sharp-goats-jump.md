---
type: Changed
pr: 5191
---
**gsd-tools and the hooks that load gsd-core/bin/lib start faster** — they turn on Node's compile cache, so later runs reuse compiled code for unchanged modules. Output is unchanged; the cache lives under the OS temp directory and `NODE_DISABLE_COMPILE_CACHE` (any value) turns it off. (#5183)
