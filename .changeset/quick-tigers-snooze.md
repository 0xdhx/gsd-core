---
type: Fixed
pr: 5154
---
**Keep dispatch isolation sentinels out of Git status** — projects without an existing `.gsd` ignore rule no longer show the tool-owned sentinel as untracked, while existing local ignore rules remain intact. (#5086)
