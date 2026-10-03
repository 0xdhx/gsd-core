'use strict';

/**
 * The shell launcher's runtime-home candidate list is DERIVED from the runtime
 * descriptors, the same registry the JS resolver reads (#5169, ADR-5057 §5 "one
 * resolver", #4347).
 *
 * `_gsd_homes` used to be a hand-written copy of the JS resolver's list. It
 * drifted: it kept probing GEMINI_CONFIG_DIR after the gemini runtime was
 * retired, and it omitted zcode, pi, kimi and kimi-code. The sync script now
 * renders the function from the registry; this file proves
 *   - the committed snippet is exactly that rendering (drift fails here),
 *   - no retired-runtime env var survives anywhere the preamble ships,
 *   - and, by executing the real shell function, that for EVERY registered
 *     runtime the launcher finds the very install directory the JS resolver
 *     resolves — so the two resolvers cannot pick different installs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const registry = require(path.join(LIB, 'capability-registry.cjs'));
const { resolveConfigHomeFromDescriptor } = require(path.join(LIB, 'runtime-homes.cjs'));
const { LEGACY_NON_REGISTRY_RUNTIME_HOMES } = require(path.join(LIB, 'runtime-name-policy.cjs'));
const sync = require(path.join(ROOT, 'scripts', 'sync-runtime-launcher.cjs'));

const SNIPPET = path.join(ROOT, 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh');
const snippetText = fs.readFileSync(SNIPPET, 'utf8');
const RUNTIMES = Object.keys(registry.runtimes);

describe('_gsd_homes is rendered from the descriptors', () => {
  test('the committed snippet equals the registry rendering (no hand edits, no stale descriptors)', () => {
    const found = sync.extractHomesFunction(snippetText);
    assert.ok(found, 'the snippet carries a _gsd_homes function');
    assert.equal(found.text, sync.loadDerivedHomes());
  });

  test('rendering is deterministic and independent of registry key order', () => {
    const reversed = { runtimes: {} };
    for (const id of Object.keys(registry.runtimes).reverse()) reversed.runtimes[id] = registry.runtimes[id];
    assert.equal(
      sync.renderHomesFunction(reversed, LEGACY_NON_REGISTRY_RUNTIME_HOMES),
      sync.renderHomesFunction(registry, LEGACY_NON_REGISTRY_RUNTIME_HOMES),
    );
  });

  test('claude is probed first; the legacy non-registry home is probed last', () => {
    const text = sync.loadDerivedHomes();
    const firstArg = text.indexOf('"');
    assert.ok(text.slice(firstArg).startsWith('"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/'));
    const lastArgStart = text.lastIndexOf(' "');
    assert.ok(text.slice(lastArgStart).includes('GROK_AGENTS_HOME'));
  });

  test('every registered runtime with a file-projected home contributes its env override', () => {
    const text = sync.loadDerivedHomes();
    let contributing = 0;
    for (const id of RUNTIMES) {
      const configHome = registry.runtimes[id].runtime.configHome;
      if (!configHome || configHome.kind === 'none') continue;
      assert.ok(configHome.env.length > 0, `${id} declares an env override`);
      assert.ok(text.includes('${' + configHome.env[0] + ':-'), `${id} (${configHome.env[0]}) must be probed`);
      contributing += 1;
    }
    assert.ok(contributing >= 18);
  });

  test('a runtime with no file-projected home (kind "none") contributes nothing', () => {
    const fake = { runtimes: { ide: { runtime: { configHome: { kind: 'none', name: 'ide', env: [] } } } } };
    const text = sync.renderHomesFunction(fake, {});
    assert.equal(text, '_gsd_homes() { _gsd_at ; }');
  });

  test('the retired gemini runtime is no longer probed (#4347)', () => {
    assert.ok(!snippetText.includes('GEMINI_CONFIG_DIR'));
    for (const id of RUNTIMES) assert.ok(!registry.runtimes[id].runtime.configHome.env.includes('GEMINI_CONFIG_DIR'));
  });

  test('no shipped workflow, agent or command carries the retired env var', () => {
    const offenders = [];
    for (const dir of ['gsd-core/workflows', 'agents', 'commands']) {
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.md') || entry.name.endsWith('.sh')) {
            if (fs.readFileSync(full, 'utf8').includes('GEMINI_CONFIG_DIR')) offenders.push(path.relative(ROOT, full));
          }
        }
      };
      walk(path.join(ROOT, dir));
    }
    assert.deepEqual(offenders, []);
  });
});

describe('the launcher finds the install the JS resolver resolves, for every runtime', () => {
  const homesPrefix = (() => {
    const end = snippetText.indexOf('; if _gsd_at');
    return snippetText.slice(0, end + 1);
  })();

  function runLauncher(home) {
    const script = `${homesPrefix} _gsd_homes && printf '%s' "$GSD_TOOLS"`;
    return spawnSync('sh', ['-c', script], {
      cwd: home,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      // A minimal environment: no *_CONFIG_DIR / *_HOME override, so the
      // descriptor defaults (`$HOME/.<dir>`) are what is probed.
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH || '/usr/bin:/bin' },
    });
  }

  const skipShell = process.platform === 'win32' ? 'POSIX shell launcher' : false;

  for (const id of RUNTIMES) {
    const configHome = registry.runtimes[id].runtime.configHome;
    if (!configHome || configHome.kind === 'none') continue;
    test(`${id}: _gsd_homes resolves ${configHome.kind} home identically to the JS resolver`, { skip: skipShell }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
      try {
        // Make the descriptor's own probe marker true so the JS resolver picks this dir
        // (probeExists is `gsd-core/VERSION` or `skills`, depending on the kind).
        const jsDir = resolveConfigHomeFromDescriptor(configHome, {
          env: {},
          home,
          existsSync: (p) => fs.existsSync(p),
        });
        fs.mkdirSync(path.join(jsDir, 'gsd-core', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(jsDir, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
        fs.writeFileSync(path.join(jsDir, 'gsd-core', 'VERSION'), '0.0.0\n');
        if (configHome.probeExists) {
          // The resolver only tests existence of `<dir>/<probeExists>`; a marker FILE satisfies it for
          // both the `gsd-core/VERSION` and the `skills` spellings (mkdir would collide with VERSION).
          const marker = path.join(jsDir, configHome.probeExists);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
        }
        // Re-resolve now that the markers exist: the JS resolver and the launcher must agree.
        const jsAfter = resolveConfigHomeFromDescriptor(configHome, { env: {}, home, existsSync: (p) => fs.existsSync(p) });
        const result = runLauncher(home);
        assert.equal(result.status, 0, `launcher exited ${result.status}: ${result.stderr}`);
        assert.equal(
          fs.realpathSync(result.stdout),
          fs.realpathSync(path.join(jsAfter, 'gsd-core', 'bin', 'gsd-tools.cjs')),
        );
      } finally {
        cleanup(home);
      }
    });
  }

  for (const [id, legacy] of Object.entries(LEGACY_NON_REGISTRY_RUNTIME_HOMES)) {
    test(`${id}: the legacy non-registry home is probed`, { skip: skipShell }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
      try {
        const dir = path.join(home, ...legacy.dir);
        fs.mkdirSync(path.join(dir, 'gsd-core', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
        const result = runLauncher(home);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs')));
      } finally {
        cleanup(home);
      }
    });
  }

  test('with no install anywhere the function reports failure (a miss is not a silent success)', { skip: skipShell }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
    try {
      const result = runLauncher(home);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.includes('gsd-tools.cjs') && fs.existsSync(result.stdout), false);
    } finally {
      cleanup(home);
    }
  });

  test('an env override wins over the default home (the same precedence as the JS resolver)', { skip: skipShell }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-launcher-'));
    try {
      const custom = path.join(home, 'custom-claude');
      fs.mkdirSync(path.join(custom, 'gsd-core', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(custom, 'gsd-core', 'bin', 'gsd-tools.cjs'), '// fixture\n');
      const script = `${homesPrefix} _gsd_homes && printf '%s' "$GSD_TOOLS"`;
      const result = spawnSync('sh', ['-c', script], {
        cwd: home,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH || '/usr/bin:/bin', CLAUDE_CONFIG_DIR: custom },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.realpathSync(result.stdout), fs.realpathSync(path.join(custom, 'gsd-core', 'bin', 'gsd-tools.cjs')));
    } finally {
      cleanup(home);
    }
  });
});
