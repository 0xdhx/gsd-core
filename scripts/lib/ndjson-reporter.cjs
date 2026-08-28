'use strict';

// Machine-readable companion reporter for scripts/run-tests.cjs (#3889).
//
// node:test's built-in reporters (spec/tap) are human-formatted and
// scripts/run-tests.cjs spawns the child with `stdio: 'inherit'` — by design,
// per #3597/#1051, to avoid the maxBuffer and live-output risks of piping —
// so the parent process has no way to see WHICH file was executing when a
// per-chunk timeout kills the child. This reporter runs ALONGSIDE the normal
// human reporter (a second `--test-reporter` on the same invocation, per
// Node's documented multi-reporter pairing) and appends one JSON object per
// line to a path supplied via the GSD_RUN_TESTS_EVENTS_FILE env var. On a
// timeout, run-tests.cjs reads that file back to name the file(s) still
// in flight (a `test:start` with no matching `test:pass`/`test:fail`).
//
// Durability, not `--test-reporter-destination` (#3889 root cause): a
// reporter that YIELDS strings has them piped by Node into a
// `fs.WriteStream` targeting the destination path, and that stream buffers.
// The parent's `execFileSync` timeout SIGKILLs the child on a hang, and
// SIGKILL is uncatchable and gives the process zero chance to flush — so a
// yield-based reporter can lose every event still sitting in the stream's
// buffer, which is exactly the case this feature exists to diagnose (proven
// live: a chunk killed at 2006ms produced a `killed after 2006ms` line from
// the TIMER, which lives in the parent, but zero usable events from the
// reporter, which lives in the child and never flushed). Writing each event
// with `fs.appendFileSync` — synchronous and unbuffered — makes it durable
// the instant it happens, before the process can be killed out from under
// it. The reporter therefore yields NOTHING; it is a pure side-effecting
// sink. Node still requires a `--test-reporter-destination` to pair with
// this `--test-reporter` (see run-tests.cjs's reporterArgsFor), but that
// destination is a throwaway sink that stays empty by design — the durable
// path is GSD_RUN_TESTS_EVENTS_FILE, not the destination Node manages.
//
// Contract targeted: Node's "Custom reporters" contract
// (https://nodejs.org/api/test.html#custom-reporters) — a reporter module's
// default export is a function receiving the test runner's event stream (an
// AsyncIterable of `{ type, data }` objects) and returning an iterable (sync
// or async) of the reporter's output. This one intentionally emits no output
// (see the durability note above) — a plain `async function` that returns an
// empty array satisfies the contract without an `async function*` generator
// that would otherwise never `yield` (require-yield). This repo's
// `engines.node` requires >=24.0.0 (package.json), where this contract has
// been stable since Node 20.
//
// Kept intentionally tiny: only the three event types run-tests.cjs needs to
// pair start/completion are handled; everything else (diagnostics, plans,
// coverage) is ignored so a truncated events file (the process is SIGKILLed
// mid-`appendFileSync` on timeout — an individual write is unbuffered but
// not atomic, so the OS can still interleave a partial write with the kill)
// never leaves more than one dangling unparsable trailing line.
module.exports = async function ndjsonEventReporter(source) {
  const eventsPath = process.env.GSD_RUN_TESTS_EVENTS_FILE;
  for await (const event of source) {
    if (!eventsPath) continue; // no destination configured — nothing to record
    if (
      event.type === 'test:start' ||
      event.type === 'test:pass' ||
      event.type === 'test:fail'
    ) {
      const { file, name, nesting, testNumber } = event.data || {};
      const line = `${JSON.stringify({
        type: event.type,
        file,
        name,
        nesting,
        testNumber,
        ts: Date.now(),
      })}\n`;
      try {
        require('fs').appendFileSync(eventsPath, line);
      } catch {
        // Best-effort: a write failure here (e.g. the events dir vanished)
        // must never crash the test run this reporter is only observing.
      }
    }
  }
  // Intentionally empty: this reporter is a pure side-effecting sink (see the
  // durability note above), never a source of reporter OUTPUT. Node still
  // requires the exported function to return an iterable.
  return [];
};
