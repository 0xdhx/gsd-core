---
type: Fixed
pr: 0
---
**Mempalace gates on default-true keys now say what they mean** — the recall command's knowledge-graph step and the curator agent's diary and KG-mirror steps read "unless `<key> !== false`", which literally licenses the step only when the key is `false`. They now read "when `<key> !== false`"; behavior is unchanged (an absent key still means enabled, only an explicit `false` disables). (#5173)
