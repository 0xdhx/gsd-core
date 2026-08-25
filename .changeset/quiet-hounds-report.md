---
type: Fixed
pr: 0
---
**A scoped `commit --files` call whose named files are already committed and unmodified now reports `nothing_to_commit` instead of a failed commit carrying your pre-commit hook's rejection message.** The empty-diff case used to reach `git commit`, where a rejecting hook fires before git can report "nothing to commit" — so callers were handed `commit_failed` and a gate message that was true about the repository and irrelevant to the call. Genuine rejections still report `commit_failed` with the hook's message, and `--amend`, missing named paths, and merges or cherry-picks in progress are unchanged. (#3776)
