/**
 * Pure fixture tests for the L5 provenance classifier. They exercise the actual
 * `provenance.mjs` boundary used by `run.mjs` (no duplicated classification logic)
 * inside an isolated temporary git repository, so a dirty file that affects the
 * build/package must block a clean release, while an unrelated design doc may stay
 * dirty. Cleanup is confined to the fixture directory only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import {
  analyzeInputs,
  classifyPath,
  gitDirty,
  gitExactTag,
  gitHead,
  safeDirDeletion,
  run,
} from './provenance.mjs';

const TMP_REAL = realpathSync(tmpdir());

function git(cwd, args) {
  const res = run('git', args, { cwd });
  assert.equal(res.error, null, `git ${args.join(' ')} spawn error: ${res.error}`);
  assert.equal(res.code, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(cwd, relPath, content) {
  const full = join(cwd, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Create a minimal committed repository exercising every input category. */
function makeFixture() {
  const dir = mkdtempSync(join(TMP_REAL, 'provenance-fixture-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);

  write(dir, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', files: ['dist'] }));
  write(dir, 'package-lock.json', '{}');
  write(dir, '.gitignore', 'dist/\n*.tgz\n');
  write(dir, 'tsconfig.json', '{ "compilerOptions": {} }');
  write(dir, 'tsconfig.build.json', '{ "extends": "./tsconfig.json" }');
  write(dir, 'src/index.ts', 'export const x = 1;\n');
  write(dir, 'src/util.ts', 'export const y = 2;\n');
  write(dir, 'README.md', '# fixture\n');
  write(dir, 'README_ZH.md', '# fixture\n');
  write(dir, 'LICENSE', 'unlicensed\n');
  write(dir, 'acceptance/run.mjs', '// runner\n');
  write(dir, 'acceptance/consumer.mjs', '// consumer\n');
  write(dir, 'docs/design.md', '# design\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'baseline']);

  return dir;
}

function cleanupFixture(dir) {
  // Confine every deletion to the fixture we created, never a broad removal.
  const real = realpathSync(dir);
  assert.ok(real.startsWith(TMP_REAL + sep), `fixture ${real} is not under tmpdir ${TMP_REAL}`);
  rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test('gitHead resolves a real commit in a repository', () => {
  const dir = makeFixture();
  try {
    const res = gitHead(dir);
    assert.equal(res.ok, true);
    assert.match(res.hash, /^[0-9a-f]{40}$/);
  } finally {
    cleanupFixture(dir);
  }
});

test('gitHead hard-fails (ok:false) outside a git repository, never an empty hash', () => {
  const res = gitHead(TMP_REAL);
  assert.equal(res.ok, false);
  assert.ok(res.error, 'must carry an error message');
});

test('gitExactTag reports null (ok) when HEAD has no precise tag', () => {
  const dir = makeFixture();
  try {
    const res = gitExactTag(dir);
    assert.equal(res.ok, true);
    assert.equal(res.tag, null);
  } finally {
    cleanupFixture(dir);
  }
});

test('gitExactTag resolves the precise tag once one exists', () => {
  const dir = makeFixture();
  try {
    git(dir, ['tag', 'v1.0.0']);
    const res = gitExactTag(dir);
    assert.equal(res.ok, true);
    assert.equal(res.tag, 'v1.0.0');
  } finally {
    cleanupFixture(dir);
  }
});

test('gitExactTag hard-fails outside a git repository (distinct from missing tag)', () => {
  const res = gitExactTag(TMP_REAL);
  assert.equal(res.ok, false);
  assert.ok(res.error, 'must carry an error message');
});

test('classifyPath maps each input category and keeps non-inputs out', () => {
  assert.equal(classifyPath('src/index.ts'), 'build');
  assert.equal(classifyPath('tsconfig.json'), 'build');
  assert.equal(classifyPath('tsconfig.build.json'), 'build');
  assert.equal(classifyPath('package.json'), 'package');
  assert.equal(classifyPath('package-lock.json'), 'package');
  assert.equal(classifyPath('.gitignore'), 'package');
  assert.equal(classifyPath('.npmignore'), 'package');
  // npm always packs the standard README and LICENSE basenames even with files:[dist].
  assert.equal(classifyPath('README.md'), 'package');
  assert.equal(classifyPath('LICENSE'), 'package');
  // ...but NOT a non-standard README_ZH.md basename, which npm does not auto-pack.
  assert.equal(classifyPath('README_ZH.md'), 'non-input');
  assert.equal(classifyPath('acceptance/run.mjs'), 'acceptance');
  assert.equal(classifyPath('docs/design.md'), 'non-input');
});

test('a clean fixture is not release-blocked', () => {
  const dir = makeFixture();
  try {
    const dirty = gitDirty(dir);
    assert.equal(dirty.ok, true);
    const inputs = analyzeInputs(dir, dirty);
    assert.equal(inputs.releaseBlocked, false);
  } finally {
    cleanupFixture(dir);
  }
});

test('an unstaged tracked source modification blocks a clean release as a build input', () => {
  const dir = makeFixture();
  try {
    write(dir, 'src/util.ts', 'export const y = 3;\n');
    const dirty = gitDirty(dir);
    assert.deepEqual(dirty.unstaged, ['src/util.ts']);
    const inputs = analyzeInputs(dir, dirty);
    assert.equal(inputs.releaseBlocked, true);
    assert.deepEqual(inputs.categories.build.map((e) => e.path), ['src/util.ts']);
    assert.equal(inputs.categories.build[0].kinds[0], 'unstaged');
  } finally {
    cleanupFixture(dir);
  }
});

test('a staged package manifest modification blocks a clean release as a package input', () => {
  const dir = makeFixture();
  try {
    write(dir, 'package.json', JSON.stringify({ name: 'fixture', version: '2.0.0', files: ['dist'] }));
    git(dir, ['add', 'package.json']);
    const dirty = gitDirty(dir);
    assert.deepEqual(dirty.staged, ['package.json']);
    const inputs = analyzeInputs(dir, dirty);
    assert.equal(inputs.releaseBlocked, true);
    assert.deepEqual(inputs.categories.package.map((e) => e.path), ['package.json']);
    assert.equal(inputs.categories.package[0].kinds[0], 'staged');
  } finally {
    cleanupFixture(dir);
  }
});

test('an untracked source file blocks a clean release as a build input', () => {
  const dir = makeFixture();
  try {
    write(dir, 'src/extra.ts', 'export const z = 4;\n');
    const dirty = gitDirty(dir);
    assert.deepEqual(dirty.untracked, ['src/extra.ts']);
    const inputs = analyzeInputs(dir, dirty);
    assert.equal(inputs.releaseBlocked, true);
    assert.deepEqual(inputs.categories.build.map((e) => e.path), ['src/extra.ts']);
    assert.equal(inputs.categories.build[0].kinds[0], 'untracked');
  } finally {
    cleanupFixture(dir);
  }
});

test('a dirty README (auto-packed) blocks a clean release, a dirty design doc does not', () => {
  const dir = makeFixture();
  try {
    write(dir, 'README.md', '# changed\n');
    write(dir, 'docs/design.md', '# changed design\n');
    const dirty = gitDirty(dir);
    const inputs = analyzeInputs(dir, dirty);
    assert.equal(inputs.releaseBlocked, true, 'README edit is a package input');
    assert.deepEqual(inputs.categories.package.map((e) => e.path), ['README.md']);
    assert.deepEqual(inputs.categories['non-input'].map((e) => e.path), ['docs/design.md']);
  } finally {
    cleanupFixture(dir);
  }
});

test('only a dirty design doc is reported as non-input and does not block a clean release', () => {
  const dir = makeFixture();
  try {
    write(dir, 'docs/design.md', '# changed design\n');
    const dirty = gitDirty(dir);
    const inputs = analyzeInputs(dir, dirty);
    assert.equal(inputs.releaseBlocked, false);
    assert.deepEqual(inputs.categories['non-input'].map((e) => e.path), ['docs/design.md']);
  } finally {
    cleanupFixture(dir);
  }
});

test('safeDirDeletion accepts a plain child directory inside the fixture', () => {
  const dir = makeFixture();
  try {
    mkdirSync(join(dir, 'dist'));
    const res = safeDirDeletion(dir, 'dist');
    assert.equal(res.ok, true);
    assert.equal(res.path, join(dir, 'dist'));
  } finally {
    cleanupFixture(dir);
  }
});

test('safeDirDeletion rejects a symlink that escapes the fixture root', (t) => {
  const dir = makeFixture();
  try {
    const outside = mkdtempSync(join(TMP_REAL, 'provenance-outside-'));
    try {
      try {
        symlinkSync(outside, join(dir, 'dist'));
      } catch (err) {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
          t.skip(`symlink creation not permitted in this environment (${err.code})`);
          return;
        }
        throw err;
      }
      const res = safeDirDeletion(dir, 'dist');
      assert.equal(res.ok, false);
      assert.match(res.error, /escapes root/);
    } finally {
      // Remove the symlink itself (not its target) before reclaiming `outside`,
      // so the later fixture cleanup never follows a dangling link on Windows.
      try {
        rmSync(join(dir, 'dist'), { force: true });
      } catch {
        /* already gone */
      }
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    cleanupFixture(dir);
  }
});

test('safeDirDeletion rejects a lexical escape above the fixture root', () => {
  const dir = makeFixture();
  try {
    const res = safeDirDeletion(dir, '../outside');
    assert.equal(res.ok, false);
    assert.match(res.error, /not strictly under root/);
  } finally {
    cleanupFixture(dir);
  }
});
