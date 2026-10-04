'use strict';

/**
 * #5207 / ADR-5057 Phase 11 — hook registration is a table behind the
 * `settings-json` hooksSurface adapter.
 *
 * `golden.json` was generated from the pre-migration per-hook-branch
 * implementation; the table-driven loop must reproduce it byte-for-byte for
 * every runtime whose hooksSurface is `settings-json`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const surface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const scenarios = require('./fixtures/hook-registration/run-scenarios.cjs');
const golden = require('./fixtures/hook-registration/golden.json');

const { applySettingsJsonHooks, SETTINGS_JSON_HOOK_ROWS, SETTINGS_JSON_EXTENDED_ROWS, applySettingsJsonHookTables } = surface;

describe('settings-json hook registration parity (golden)', () => {
  const runtimes = scenarios.settingsJsonRuntimes();

  test('the golden covers every settings-json runtime the registry declares', () => {
    assert.deepEqual(runtimes.map((r) => r.id).sort(), Object.keys(golden).sort());
    assert.ok(runtimes.length >= 6);
  });

  for (const rt of runtimes) {
    for (const [name, spec] of Object.entries(scenarios.scenarioSpecs(rt))) {
      test(`${rt.id} ${name} registers identically to the pre-migration golden`, () => {
        const actual = scenarios.runOne(rt, spec);
        assert.deepEqual(actual, golden[rt.id][name]);
      });
    }
  }

  test('the golden comparison goes red on a mutated row (positive control)', () => {
    const rt = runtimes.find((r) => r.id === 'claude');
    const rows = structuredClone(SETTINGS_JSON_HOOK_ROWS);
    const target = rows.find((r) => r.file === 'gsd-write-guard.js');
    assert.ok(target, 'gsd-write-guard.js row exists');
    target.matcher = 'Write|Edit';
    const actual = scenarios.runOne(
      rt,
      scenarios.scenarioSpecs(rt)['local/all-present'],
      (settings, opts) => applySettingsJsonHookTables(settings, opts, { rows, extendedRows: SETTINGS_JSON_EXTENDED_ROWS }),
    );
    assert.notDeepEqual(actual, golden.claude['local/all-present']);
  });
});

describe('settings-json hook registration table', () => {
  test('rows are well-formed with a closed event vocabulary', () => {
    const events = new Set(['SessionStart', 'post', 'pre']);
    const seen = new Set();
    for (const row of SETTINGS_JSON_HOOK_ROWS) {
      assert.match(row.file, /^gsd-[a-z-]+\.(js|sh)$/);
      assert.ok(events.has(row.event), `${row.file}: unknown event ${row.event}`);
      assert.ok(!seen.has(row.file), `${row.file}: duplicate row`);
      seen.add(row.file);
      assert.equal(typeof row.configuredMessage, 'string');
      assert.equal(typeof row.skipLabel, 'string');
      assert.ok(row.command && (row.command.opts || row.command.build), `${row.file}: no command source`);
      if (row.matcher !== undefined) assert.equal(typeof row.matcher, 'string');
      if (row.timeout !== undefined) assert.ok(row.timeout === 'blocking' || Number.isInteger(row.timeout));
    }
  });

  test('every registered hook comes from a table row', () => {
    const registered = new Set();
    const g = golden.claude['local/all-present'].settings.hooks;
    for (const entries of Object.values(g)) {
      for (const entry of entries) {
        for (const h of entry.hooks) registered.add(path.basename(h.command.split(' ').pop()));
      }
    }
    const fromTables = new Set([
      ...SETTINGS_JSON_HOOK_ROWS.map((r) => r.file),
      ...SETTINGS_JSON_EXTENDED_ROWS.map((r) => r.file),
    ]);
    assert.deepEqual([...registered].sort(), [...fromTables].sort());
  });
});

describe('settings-json hook registration edge shapes', () => {
  const rt = scenarios.settingsJsonRuntimes().find((r) => r.id === 'claude');

  for (const surfaceName of ['none', 'kimi-hooks-toml']) {
    test(`hooksSurface '${surfaceName}' leaves settings untouched and silent`, () => {
      const out = scenarios.runOne(rt, { isGlobal: false, present: scenarios.ALL_HOOKS, hooksSurface: surfaceName });
      assert.deepEqual(out.settings, {});
      assert.equal(out.stdout, '');
      assert.equal(out.stderr, '');
    });
  }

  for (const bad of ['oops', 42, { not: 'array' }, true]) {
    test(`a malformed extended-event key (${JSON.stringify(bad)}) is repaired, not thrown on`, () => {
      const spec = {
        isGlobal: false,
        present: scenarios.ALL_HOOKS,
        seed: { hooks: { Stop: bad, BeforeAgent: bad } },
      };
      const out = scenarios.runOne({ ...rt, extendedHookEvents: ['Stop', 'BeforeAgent'] }, spec);
      assert.ok(Array.isArray(out.settings.hooks.Stop));
      assert.equal(out.settings.hooks.Stop.length, 1);
      assert.ok(Array.isArray(out.settings.hooks.BeforeAgent));
    });
  }

  test('the public entry point is the table loop over the default tables', () => {
    const spec = scenarios.scenarioSpecs(rt)['local/all-present'];
    const viaPublic = scenarios.runOne(rt, spec, applySettingsJsonHooks);
    const viaTables = scenarios.runOne(
      rt,
      spec,
      (s, o) => applySettingsJsonHookTables(s, o, { rows: SETTINGS_JSON_HOOK_ROWS, extendedRows: SETTINGS_JSON_EXTENDED_ROWS }),
    );
    assert.deepEqual(viaPublic, viaTables);
  });
});
