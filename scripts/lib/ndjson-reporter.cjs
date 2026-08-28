'use strict';

// Machine-readable companion reporter for scripts/run-tests.cjs (#3889).
//
// node:test's built-in reporters (spec/tap) are human-formatted and
// scripts/run-tests.cjs spawns the child with `stdio: 'inherit'` — by design,
// per #3597/#1051, to avoid the maxBuffer and live-output risks of piping —
// so the parent process has no way to see WHICH file was executing when a
// per-chunk timeout kills the child. This reporter runs ALONGSIDE the normal
// human reporter (a second `--test-reporter`/`--test-reporter-destination`
// pair on the same invocation, per Node's documented multi-reporter pairing)
// and appends one JSON object per line to its own destination file. On a
// timeout, run-tests.cjs reads that file back to name the file(s) still
// in flight (a `test:start` with no matching `test:pass`/`test:fail`).
//
// Contract targeted: Node's "Custom reporters" contract
// (https://nodejs.org/api/test.html#custom-reporters) — a reporter module's
// default export is a function receiving the test runner's event stream
// (an AsyncIterable of `{ type, data }` objects) and returning/yielding the
// reporter's output. This repo's `engines.node` requires >=24.0.0
// (package.json), where this contract — including the CommonJS
// `async function*` form used here — has been stable since Node 20.
//
// Kept intentionally tiny: only the three event types run-tests.cjs needs to
// pair start/completion are handled; everything else (diagnostics, plans,
// coverage) is ignored so a truncated destination file (the process is
// SIGKILLed mid-write on timeout) never leaves more than one dangling
// unparsable trailing line.
module.exports = async function* ndjsonEventReporter(source) {
  for await (const event of source) {
    if (
      event.type === 'test:start' ||
      event.type === 'test:pass' ||
      event.type === 'test:fail'
    ) {
      const { file, name, nesting, testNumber } = event.data || {};
      yield `${JSON.stringify({
        type: event.type,
        file,
        name,
        nesting,
        testNumber,
        ts: Date.now(),
      })}\n`;
    }
  }
};
