---
type: Fixed
pr: 5047
---
**The secret-read guard no longer blocks `git check-ignore`, `git ls-files`, `git rm --cached` or a template copy on a secret file** — these name the file without printing it (`git check-ignore -v .env`, `cp .env.example .env`), yet the guard treated every operand of `git`, `cp` and `mv` as a read. Only those operand positions are now exempt; content-revealing forms (`git show`, `git diff`, `git log -p`, `git blame`, a secret `cp`/`mv` source) and any unlisted option stay blocked.
