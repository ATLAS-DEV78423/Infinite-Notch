import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Replace external check executables only; execute the real composition script.
async function fixture(t) {
  const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'coucou-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'bin'));
  const script = await readFile(new URL('../scripts/test-notch-foundation.sh', import.meta.url));
  await writeFile(join(root, 'scripts/test-notch-foundation.sh'), script);
  await writeFile(join(root, 'bin/node'), '#!/bin/sh\nexit "${FIXTURE_CHECK_EXIT:-0}"\n', { mode: 0o755 });
  return (args = [], env = {}) => spawnSync('bash', [join(root, 'scripts/test-notch-foundation.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin`, RUSTC: '', ...env },
  });
}

test('foundation runner rejects unknown and extra flags', async (t) => {
  const run = await fixture(t);
  assert.equal(run(['--unknown']).status, 2);
  assert.equal(run(['--require-native', 'extra']).status, 2);
});

test('foundation runner propagates an executed check failure', async (t) => {
  const run = await fixture(t);
  assert.equal(run([], { FIXTURE_CHECK_EXIT: '7' }).status, 7);
});

test('foundation runner distinguishes portable success from missing native acceptance', async (t) => {
  const run = await fixture(t);
  const portable = run();
  assert.equal(portable.status, 0);
  assert.match(portable.stdout, /PENDING/);
  const strict = run(['--require-native']);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout + strict.stderr, /native.*incomplete/i);
});
