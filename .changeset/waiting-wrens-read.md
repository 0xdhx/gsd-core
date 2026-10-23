---
type: Fixed
pr: 0
---
**The secret-read guard reads the body of a heredoc left waiting by a `$( )` that closes on its own line** — `echo $(cat <<EOF) x`, then a body line with a lone quote, then `EOF`, then `cat .env` was allowed: bash reads the body from the lines after the next newline, but the scan read those lines as part of the command around them, and the quote hid the read after them. The scan now passes over those lines at that newline, whether it falls at the end of the line, in a quoted string, after a line continuation or in a later substitution. It reads each body with the command that opened its heredoc, so `$(bash <<EOF)`'s body is scanned as a script, and also reads it on its own as commands, as those lines were read before, so a read written in a body is still denied. The same holds for a `<( )` and a double-quoted `"$( )"`. (#5515)
