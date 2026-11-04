/**
 * Provenance helpers shared by the acceptance runner (`run.mjs`) and its pure
 * fixture tests (`provenance.test.mjs`).
 *
 * Everything exported here is a pure function of the filesystem / git state it
 * is handed: no build, no pack, no install, no `dist` deletion. It records which
 * working-tree files constitute build/package/acceptance inputs, distinguishes a
 * genuine git failure from a merely-absent tag, and computes SHA-256 content
 * digests so the runner never claims a clean HEAD when the working copy differs.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Release-input categories: any dirty file in these blocks a clean HEAD release. */
export const INPUT_CATEGORIES = ['build', 'package', 'acceptance'];

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/**
 * Run a subprocess synchronously with captured stdio. The returned `error` field
 * records a spawn failure, `signal` a signal/timeout kill, `code` the exit code —
 * so callers can distinguish "could not run", "killed", and "exited non-zero".
 */
export function run(cmd, args, opts = {}) {
  const { timeout, ...rest } = opts;
  const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...rest };
  if (timeout != null) spawnOpts.timeout = timeout;
  const res = spawnSync(cmd, args, spawnOpts);
  return {
    cmd,
    args,
    cwd: rest.cwd ?? process.cwd(),
    code: res.status,
    signal: res.signal,
    error: res.error ? String(res.error.message || res.error) : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * Resolve the source commit. A git failure here is a hard error: the runner must
 * never fall back to an empty hash and still report PASS.
 */
export function gitHead(root) {
  const res = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (res.error) return { ok: false, error: `git rev-parse HEAD could not run: ${res.error}` };
  if (res.code !== 0) {
    return { ok: false, error: `git rev-parse HEAD failed (exit ${res.code}): ${(res.stderr || res.stdout).trim()}` };
  }
  const hash = res.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) {
    return { ok: false, error: `git rev-parse HEAD returned unexpected value: ${JSON.stringify(hash)}` };
  }
  return { ok: true, hash };
}

/**
 * Resolve the precise tag at HEAD. "No tag exactly matches" (and the no-tags-at-all
 * form) is a permitted, recorded-null state — NOT a git failure. Any other git
 * error is a hard failure.
 */
export function gitExactTag(root) {
  const res = run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: root });
  if (res.error) return { ok: false, error: `git describe could not run: ${res.error}` };
  if (res.code === 0) {
    const tag = res.stdout.trim();
    return { ok: true, tag: tag || null };
  }
  const stderr = (res.stderr || '').trim();
  if (/no tag exactly matches/i.test(stderr) || /no names found/i.test(stderr)) {
    return { ok: true, tag: null };
  }
  return { ok: false, error: `git describe --tags --exact-match failed (exit ${res.code}): ${stderr}` };
}

/** List staged, unstaged and untracked paths relative to HEAD. */
export function gitDirty(root) {
  const queries = [
    run('git', ['diff', '--name-only', '--cached'], { cwd: root }),
    run('git', ['diff', '--name-only'], { cwd: root }),
    run('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root }),
  ];
  for (const q of queries) {
    if (q.error) return { ok: false, error: `git status query could not run (${q.cmd}): ${q.error}` };
    if (q.code !== 0) {
      return { ok: false, error: `${q.cmd} failed (exit ${q.code}): ${(q.stderr || q.stdout).trim()}` };
    }
  }
  const lines = (s) => s.trim().split('\n').filter(Boolean);
  return {
    ok: true,
    staged: lines(queries[0].stdout),
    unstaged: lines(queries[1].stdout),
    untracked: lines(queries[2].stdout),
  };
}

/**
 * npm always bundles these basenames into the tarball regardless of `files`,
 * `.npmignore` or `.gitignore` (matched case-insensitively against the basename,
 * with an optional single trailing extension). `package.json` is handled
 * separately below. This is the reason a `README.md` edit is a package input even
 * though `files: ["dist"]` is set — but a `README_ZH.md` edit is not (its basename
 * does not match this set, so npm does not auto-pack it).
 */
const NPM_ALWAYS_INCLUDE = /^(readme|copying|license|licence|notice|changes|changelog|history)(\..*)?$/i;

/**
 * Classify a repo-relative path as a build, package, acceptance or non-input file.
 *
 * Build inputs compile into `dist/`; package inputs affect `npm pack` (the
 * manifest, lockfile, pack include/exclude files, and the README/LICENSE that npm
 * always bundles); acceptance inputs are the runner/consumer scripts that
 * establish the release's own evidence. Everything else (design docs, examples,
 * unrelated tests) is non-input and may remain dirty without blocking a clean
 * release.
 */
export function classifyPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  if (p === 'package.json' || p === 'package-lock.json' || p === '.npmignore' || p === '.gitignore') {
    return 'package';
  }
  const base = p.split('/').pop();
  if (base && NPM_ALWAYS_INCLUDE.test(base)) {
    return 'package';
  }
  if (p === 'tsconfig.json' || p === 'tsconfig.build.json' || p === 'src' || p.startsWith('src/')) {
    return 'build';
  }
  if (p === 'acceptance' || p.startsWith('acceptance/')) {
    return 'acceptance';
  }
  return 'non-input';
}

/**
 * Fold the dirty-path sets into per-category entries (a path can be both staged
 * and unstaged) and decide whether a clean HEAD release is blocked.
 */
export function analyzeInputs(root, dirty) {
  const kinds = new Map();
  for (const [kind, paths] of [
    ['staged', dirty.staged],
    ['unstaged', dirty.unstaged],
    ['untracked', dirty.untracked],
  ]) {
    for (const p of paths) {
      const set = kinds.get(p) || new Set();
      set.add(kind);
      kinds.set(p, set);
    }
  }
  const categories = { build: [], package: [], acceptance: [], 'non-input': [] };
  for (const [path, kindSet] of kinds) {
    const cat = classifyPath(path);
    categories[cat].push({ path, kinds: [...kindSet].sort() });
  }
  for (const cat of Object.keys(categories)) {
    categories[cat].sort((a, b) => a.path.localeCompare(b.path));
  }
  const releaseBlocked = INPUT_CATEGORIES.some((cat) => categories[cat].length > 0);
  return { categories, releaseBlocked };
}

/** SHA-256 of a working-tree file; `exists: false` for a deleted path. */
export function workDigest(root, relPath) {
  try {
    return { exists: true, sha256: sha256File(join(root, relPath)) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, sha256: null };
    throw err;
  }
}

/** SHA-256 of a file's committed content at HEAD (null when absent at HEAD). */
export function headDigest(root, relPath) {
  const res = run('git', ['show', `HEAD:${relPath}`], { cwd: root });
  if (res.error || res.code !== 0) return { ok: false, error: `git show HEAD:${relPath} failed` };
  return { ok: true, sha256: sha256(res.stdout) };
}

/**
 * Validate that a candidate directory (`subPath`, e.g. `dist`) resolves strictly
 * inside the real repository root and is not a symlink escaping it, before any
 * recursive deletion. Returns the absolute path to delete on success.
 */
export function safeDirDeletion(root, subPath) {
  const rootReal = realpathSync(root);
  const candidate = resolve(root, subPath);

  const confined = (real) => {
    const rel = relative(rootReal, real);
    if (rel === '') return false;
    if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
    if (isAbsolute(rel)) return false;
    return true;
  };

  if (!confined(candidate)) {
    return { ok: false, error: `refusing to delete ${candidate}: not strictly under root ${rootReal}` };
  }
  try {
    const st = lstatSync(candidate);
    if (st.isSymbolicLink()) {
      const real = realpathSync(candidate);
      if (!confined(real)) {
        return { ok: false, error: `refusing to delete ${candidate}: symlink target ${real} escapes root` };
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return { ok: true, path: candidate };
}
