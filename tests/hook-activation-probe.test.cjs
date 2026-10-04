'use strict';

/**
 * #5215 / ADR-5057 Phase 12 — registration is proven to activate.
 *
 * `ON_CRASH = ALLOW` keeps advisory guards from ever failing a session, which
 * also means a registration that resolves to nothing fails silently (#4849,
 * #4557). This probe is the only place the class can be caught: for every
 * `settings-json` runtime × install scope it runs the REAL installer, takes
 * every managed hook command out of the settings file the installer wrote,
 * replaces the hook script with a sentinel stub, executes the registered
 * command verbatim through the host shell with a synthetic stdin payload, and
 * asserts the stub ran and received the payload.
 *
 * The probed pairs are enumerated from what the installer registered; a second
 * assertion pins that set to the Phase 11 tables, so adding a runtime or a hook
 * row without a passing probe fails here.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const surface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const scenarios = require('./fixtures/hook-registration/run-scenarios.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const { SETTINGS_JSON_HOOK_ROWS, SETTINGS_JSON_EXTENDED_ROWS } = surface;

const SCOPES = ['global', 'local'];
const MANAGED_HOOK = /gsd-[a-z-]+\.(?:js|sh)\b/;
const PAYLOAD = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'probe.txt' }, probe: 'gsd-5215' });

// Both stubs append {hook, payload} to $GSD_PROBE_LOG; the sentinel proves the
// registered command reached the script at the registered path with the payload.
const JS_STUB = [
  "const fs = require('fs');",
  "let d = '';",
  "process.stdin.on('data', (c) => { d += c; }).on('end', () => {",
  "  fs.appendFileSync(process.env.GSD_PROBE_LOG, JSON.stringify({ hook: require('path').basename(__filename), payload: d }) + '\\n');",
  '});',
  '',
].join('\n');
const SH_STUB = [
  '#!/bin/sh',
  'payload=$(cat)',
  'name=$(basename "$0")',
  "case \"$payload\" in *gsd-5215*) printf '{\"hook\":\"%s\",\"payload\":\"gsd-5215\"}\\n' \"$name\" >> \"$GSD_PROBE_LOG\" ;; esac",
  '',
].join('\n');

function settingsOf(configDir) {
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(configDir, name);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.hooks) return parsed;
    }
  }
  return null;
}

/** Every managed hook command the installer registered: [{ event, file, command }]. */
function registeredCommands(settings) {
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups) {
      for (const h of group.hooks || []) {
        const m = typeof h.command === 'string' ? MANAGED_HOOK.exec(h.command) : null;
        if (m) out.push({ event, file: m[0], command: h.command });
      }
    }
  }
  return out;
}

/** Normalize a registered event name onto the table's `event` vocabulary. */
function tableEvent(event) {
  if (event === 'PostToolUse' || event === 'AfterTool') return 'post';
  if (event === 'PreToolUse' || event === 'BeforeTool') return 'pre';
  return event;
}

function pairsOf(registered) {
  return registered.map((r) => `${tableEvent(r.event)}:${r.file}`).sort();
}

/** Table rows the runtime registers, limited to hook files the install shipped. */
function expectedPairs(rt, hooksDir) {
  const shipped = new Set(fs.readdirSync(hooksDir));
  const rows = [
    ...SETTINGS_JSON_HOOK_ROWS,
    ...SETTINGS_JSON_EXTENDED_ROWS.filter((r) => rt.extendedHookEvents.includes(r.event)),
  ];
  return rows.filter((r) => shipped.has(r.file)).map((r) => `${r.event}:${r.file}`).sort();
}

/**
 * Execute one registered command through the host shell with a synthetic
 * payload. `ran` is true only when the stub at the registered path wrote its
 * sentinel carrying the payload — a command that resolves to nothing, exits
 * early, or runs a different script reports false.
 */
function probeRegistration({ command, file, hooksDir, root }) {
  const log = path.join(root, `probe-${process.hrtime.bigint()}.log`);
  const target = path.join(hooksDir, file);
  if (fs.existsSync(target)) fs.writeFileSync(target, file.endsWith('.sh') ? SH_STUB : JS_STUB);
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd: root,
    input: PAYLOAD,
    encoding: 'utf8',
    timeout: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_PROJECT_DIR: root, GSD_PROBE_LOG: log },
  });
  const lines = fs.existsSync(log) ? splitLines(fs.readFileSync(log, 'utf8')).filter(Boolean) : [];
  const hit = lines.map((l) => JSON.parse(l)).find((e) => e.hook === file && String(e.payload).includes('gsd-5215'));
  return { ran: Boolean(hit), status: res.status };
}

describe('activation probe: every runtime × registered hook executes', () => {
  const runtimes = scenarios.settingsJsonRuntimes();

  test('the probe covers every settings-json runtime the registry declares', () => {
    assert.ok(runtimes.length >= 6);
  });

  for (const rt of runtimes) {
    for (const scope of SCOPES) {
      test(`${rt.id} ${scope}`, (t) => {
        if (process.platform === 'win32') {
          t.skip('registered commands target the host shell; the Windows lane runs the same probe through its own projection');
          return;
        }
        const install = runMinimalInstall({ runtime: rt.id, scope });
        try {
          const hooksDir = path.join(install.configDir, 'hooks');
          const settings = settingsOf(install.configDir);
          assert.ok(settings, `${rt.id} ${scope}: installer wrote no settings file with hooks`);

          const registered = registeredCommands(settings);
          // Census: the registered pairs are exactly the table-derived pairs.
          assert.deepEqual(pairsOf(registered), expectedPairs(rt, hooksDir), `${rt.id} ${scope}: registered hooks differ from the Phase 11 table rows`);

          const failed = [];
          for (const r of registered) {
            const out = probeRegistration({ command: r.command, file: r.file, hooksDir, root: install.root });
            if (!out.ran) failed.push(`${r.event}:${r.file} (exit ${out.status})\n    ${r.command}`);
          }
          assert.deepEqual(failed, [], `${rt.id} ${scope}: registered hook commands that never reached their script`);
        } finally {
          cleanup(install.root);
        }
      });
    }
  }
});

describe('positive controls: the probe goes red on a registration that does not activate', () => {
  function withInstall(fn) {
    const install = runMinimalInstall({ runtime: 'claude', scope: 'local' });
    try {
      const hooksDir = path.join(install.configDir, 'hooks');
      const registered = registeredCommands(settingsOf(install.configDir));
      fn({ install, hooksDir, registered });
    } finally {
      cleanup(install.root);
    }
  }
  const pick = (registered, file) => registered.find((r) => r.file === file);

  test('a healthy registration is reported as ran (control for the controls)', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX host shell'); return; }
    withInstall(({ install, hooksDir, registered }) => {
      const r = pick(registered, 'gsd-write-guard.js');
      assert.equal(probeRegistration({ command: r.command, file: r.file, hooksDir, root: install.root }).ran, true);
    });
  });

  test('a command whose script is missing is reported as not ran', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX host shell'); return; }
    withInstall(({ install, hooksDir, registered }) => {
      const r = pick(registered, 'gsd-write-guard.js');
      fs.unlinkSync(path.join(hooksDir, r.file));
      assert.equal(probeRegistration({ command: r.command, file: r.file, hooksDir, root: install.root }).ran, false);
    });
  });

  test('a command with a mutated script basename is reported as not ran', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX host shell'); return; }
    withInstall(({ install, hooksDir, registered }) => {
      const r = pick(registered, 'gsd-write-guard.js');
      const mutated = r.command.replace('gsd-write-guard.js', 'gsd-write-gard.js');
      assert.notEqual(mutated, r.command);
      assert.equal(probeRegistration({ command: mutated, file: r.file, hooksDir, root: install.root }).ran, false);
    });
  });

  test('a body that exits without running the guard is reported as not ran', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX host shell'); return; }
    withInstall(({ install, hooksDir, registered }) => {
      const r = pick(registered, 'gsd-write-guard.js');
      const decoy = path.join(install.root, 'decoy.js');
      fs.writeFileSync(decoy, 'process.exit(0);\n');
      const redirected = r.command.replace(/"?[^"\s]*gsd-write-guard\.js"?/, JSON.stringify(decoy));
      assert.notEqual(redirected, r.command);
      assert.equal(probeRegistration({ command: redirected, file: r.file, hooksDir, root: install.root }).ran, false);
    });
  });
});

describe('probe-set boundaries (limit-1 / limit / limit+1)', () => {
  test('dropping one registered pair, or adding one unregistered pair, breaks the table equality', (t) => {
    if (process.platform === 'win32') { t.skip('POSIX host shell'); return; }
    const rt = scenarios.settingsJsonRuntimes().find((r) => r.id === 'claude');
    const install = runMinimalInstall({ runtime: 'claude', scope: 'local' });
    try {
      const hooksDir = path.join(install.configDir, 'hooks');
      const registered = pairsOf(registeredCommands(settingsOf(install.configDir)));
      const expected = expectedPairs(rt, hooksDir);
      assert.deepEqual(registered, expected, 'limit: registered == expected');
      assert.notDeepEqual(registered.slice(1), expected, 'limit-1: one dropped pair is caught');
      assert.notDeepEqual([...registered, 'pre:gsd-unregistered.js'].sort(), expected, 'limit+1: one extra pair is caught');
    } finally {
      cleanup(install.root);
    }
  });
});
