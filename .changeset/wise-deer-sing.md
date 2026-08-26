---
type: Fixed
pr: 3773
---
**Acknowledging a deferred item now sticks for every shape of `status:` line** — `audit acknowledge` reported success while `audit-open` kept resurfacing the same item when the status line was a nested bullet (`  - status: open`), when the file used CRLF line endings and the status line was not the entry's last, or when the key was a bare capitalised `Status:`. In each case the writer rewrote a line the reader never consults, or no line at all. The writer now locates the status line with the reader's own field classifier, rewrites CRLF lines correctly, and refuses to report success unless the reader reads the result back as `acknowledged`. The line it inserts now takes the document's own line ending even when the entry is the last thing in a file with no trailing newline, and reuses the entry's own indent characters rather than a count of them. (#3740, #3775)
