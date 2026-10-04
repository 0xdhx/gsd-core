'use strict';

/**
 * #5215 / ADR-5057 Phase 12 — the installer's advertised "next step" command
 * is generated from the runtime's registered trigger surface, never from a
 * hand-kept per-runtime table (#4567: pi advertised `/gsd-new-project` while
 * registering only `/gsd`).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const layout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { runMinimalInstall } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

const { resolveAdvertisedNewProject, resolveTriggerSurface } = layout;

const RUNTIME_IDS = Object.keys(registry.runtimes).sort();
const SCOPES = ['global', 'local'];
const ESC = String.fromCharCode(0x1b);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const DEFAULT_CMD = '/gsd-new-project';

function registeredTriggers(runtime, scope) {
  return resolveTriggerSurface(runtime, [scope], { stems: ['new-project'] }).map((t) => t.trigger);
}

// Runtimes an installer run is meaningful for (vscode is registered but never CLI-installed).
const NON_INSTALLABLE = new Set(['vscode']);

describe('advertised command equals the registered surface', () => {
  for (const runtime of RUNTIME_IDS) {
    for (const scope of SCOPES) {
      test(`${runtime} ${scope}: advertised iff a new-project trigger is registered, and it names that trigger`, () => {
        const triggers = registeredTriggers(runtime, scope);
        const advert = resolveAdvertisedNewProject(runtime, scope);
        if (triggers.length === 0) {
          assert.deepEqual(advert, { kind: 'unregistered' });
          return;
        }
        assert.equal(advert.kind, 'command');
        assert.ok(
          advert.command.includes(triggers[0]),
          `${runtime} ${scope}: advertised ${JSON.stringify(advert.command)} does not name the registered trigger ${triggers[0]}`,
        );
      });
    }
  }

  test('runtimes that register no new-project trigger in a scope are exactly the ones that advertise nothing there', () => {
    const unregistered = [];
    for (const runtime of RUNTIME_IDS) {
      for (const scope of SCOPES) {
        if (resolveAdvertisedNewProject(runtime, scope).kind === 'unregistered') unregistered.push(`${runtime}:${scope}`);
      }
    }
    // The census this phase drives to zero: every "unregistered" pair is a pair
    // the old hand table advertised a command for anyway.
    assert.deepEqual(unregistered.sort(), [
      'pi:global', 'pi:local', 'vscode:global', 'vscode:local', 'windsurf:global',
      'cline:local', 'kimi:local', 'kimi-code:local',
    ].sort());
  });
});

describe('previously advertised strings are preserved for registered runtimes (Hyrum)', () => {
  const EXPECTED = {
    claude: DEFAULT_CMD,
    codex: '$gsd-new-project',
    cursor: 'gsd-new-project (mention the skill name)',
    kimi: '/skill:gsd-new-project',
    'kimi-code': DEFAULT_CMD,
    opencode: DEFAULT_CMD,
    qwen: DEFAULT_CMD,
    windsurf: DEFAULT_CMD,
  };
  for (const [runtime, command] of Object.entries(EXPECTED)) {
    test(`${runtime}`, () => {
      const scope = registeredTriggers(runtime, 'global').length > 0 ? 'global' : 'local';
      assert.deepEqual(resolveAdvertisedNewProject(runtime, scope), { kind: 'command', command });
    });
  }
});

describe('cross-agent default for an id GSD cannot know (ADR-5057 §5 Phase 10 amendment)', () => {
  test('empty and unknown ids keep /gsd-new-project', () => {
    for (const id of ['', 'future-runtime-xyz', 'gemini']) {
      for (const scope of SCOPES) {
        assert.deepEqual(resolveAdvertisedNewProject(id, scope), { kind: 'command', command: DEFAULT_CMD });
      }
    }
  });

  test('property: a non-registered id never resolves to unregistered', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), fc.constantFrom(...SCOPES), (id, scope) => {
        if (Object.prototype.hasOwnProperty.call(registry.runtimes, id)) return true;
        return resolveAdvertisedNewProject(id, scope).kind === 'command';
      }),
    );
  });
});

describe('the installer completion message is generated from the registered surface (wired surface)', () => {
  const cases = [
    ['pi', 'global', false],
    ['windsurf', 'global', false],
    ['claude', 'global', true],
    ['codex', 'global', true],
  ];
  for (const [runtime, scope, advertises] of cases) {
    test(`${runtime} --${scope} ${advertises ? 'advertises' : 'does not advertise'} a new-project command`, () => {
      assert.ok(!NON_INSTALLABLE.has(runtime));
      const res = runMinimalInstall({ runtime, scope });
      try {
        const out = res.stdout.replace(ANSI, '');
        const done = out.slice(out.lastIndexOf('Done!'));
        assert.ok(done.startsWith('Done!'), `no completion message in:\n${out}`);
        if (advertises) {
          assert.match(done, /gsd-new-project/);
        } else {
          assert.doesNotMatch(done, /gsd-new-project/, `completion message advertises an unregistered command:\n${done}`);
          assert.match(done, /registers no/);
        }
      } finally {
        cleanup(res.root);
      }
    });
  }
});
