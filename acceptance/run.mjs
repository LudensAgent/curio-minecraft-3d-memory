/**
 * Independent consumer acceptance orchestrator with full provenance.
 *
 * Two modes:
 *
 *   node acceptance/run.mjs            # readiness: gather provenance + classify
 *                                      #   inputs; fail (non-zero) on a git error
 *                                      #   or dirty build/package/acceptance input
 *   node acceptance/run.mjs --execute  # after a clean gate: clean-dist build,
 *                                      #   pack, independent install, positive +
 *                                      #   two negative consumer scenarios, type
 *                                      #   check, evidence + artifact kept
 *
 * The readiness check never reports a clean HEAD package when the working copy
 * differs, and it distinguishes a real git failure from a merely-absent tag. The
 * destructive clean-dist build + pack + install only runs behind `--execute`, so a
 * dry readiness run never touches the worktree `dist/` or the network.
 *
 * Errors are carried by exceptions through an owning I/O boundary; there are no
 * `process.exit` shortcuts that would skip cleanup, so the primary error is never
 * masked by a cleanup failure. Evidence (including failure) is written to a unique
 * per-run output directory and is never overwritten.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as P from './provenance.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER_VERSION = '0.7.6';
const RUNNER_FILES = ['acceptance/run.mjs', 'acceptance/provenance.mjs'];
const CONSUMER_FILES = ['acceptance/consumer.mjs', 'acceptance/consumer-types.ts'];
const EVIDENCE_ROOT = join(tmpdir(), 'curio-minecraft-3d-memory-acceptance');

// Actual non-generated npm pack entries for this repo (see provenance.mjs). The
// runner reconciles the packed file list against this instead of trusting any
// universal always-include rule.
const EXPECTED_NON_DIST_PACK = ['package.json', 'README.md'];

// Mandatory consumer scenarios (B2a commit 91d14ea interface). Positive must exit
// 0; each negative must exit 1 at its own intended AssertionError — never a
// startup/timeout/signal/worker/cleanup failure. `expectStderr` is the assertion
// substring the negative mode must hit.
const SCENARIOS = [
  { id: 'positive', flags: [], expectExit: 0, expectStdout: 'PASS (all assertions held)' },
  { id: 'early-release-pin', flags: ['--early-release-pin'], expectExit: 1, expectStderr: 'stays pinned during the active walk' },
  { id: 'skip-final-checkpoint', flags: ['--skip-final-checkpoint'], expectExit: 1, expectStderr: 'reopen has the unique final fact' },
];

class AcceptanceFailure extends Error {}

function fail(stage, detail) {
  throw new AcceptanceFailure(`[${stage}] ${detail}`);
}

/** Run an npm subcommand through the platform shell (npm is a `.cmd` shim on Windows). */
function runNpm(args, opts = {}) {
  if (process.platform === 'win32') {
    return P.run('cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], opts);
  }
  return P.run('npm', args, opts);
}

function check(stage, res) {
  if (res.error) fail(stage, `could not run \`${res.cmd} ${res.args.join(' ')}\`: ${res.error}`);
  if (res.signal) fail(stage, `\`${res.cmd} ${res.args.join(' ')}\` killed by ${res.signal}`);
  if (res.code !== 0) fail(stage, `\`${res.cmd} ${res.args.join(' ')}\` exited ${res.code}\n${(res.stderr || res.stdout).trim()}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function contentHash(relPaths) {
  return P.sha256(relPaths.map((p) => readFileSync(join(ROOT, p))).join('\n'));
}

/** A tool version is only claimed when its query succeeded. */
function toolVersion(res, label) {
  if (res.error) return { ok: false, label, error: `could not run: ${res.error}` };
  if (res.signal) return { ok: false, label, error: `killed by ${res.signal}` };
  if (res.code !== 0) return { ok: false, label, error: `exited ${res.code}` };
  return { ok: true, label, version: res.stdout.trim() };
}

function typescriptVersion(root) {
  try {
    return { ok: true, label: 'typescript', version: readJson(join(root, 'node_modules', 'typescript', 'package.json')).version };
  } catch (err) {
    return { ok: false, label: 'typescript', error: String(err && err.message ? err.message : err) };
  }
}

function cmdRecord(res, label) {
  return { label, cmd: res.cmd, args: res.args, cwd: res.cwd, code: res.code, signal: res.signal, error: res.error, stdout: res.stdout, stderr: res.stderr };
}

function versionLine(v) {
  return v.ok ? v.version : `FAILED: ${v.error}`;
}

/**
 * Resource-closing/cleanup failure markers the consumer prints when a session close
 * or the final cleanup is unclean. A scenario that hits one of these did NOT fail at
 * its intended assertion alone (or, for the positive path, did not close cleanly), so
 * it must not be judged PASS. These three cover the consumer's real closing errors:
 * `unclean/unknown close`, `cleanup failure`, and the older `secondary close/cleanup
 * error` wording.
 */
const RESOURCE_FAILURE_MARKERS = ['unclean/unknown close', 'cleanup failure', 'secondary close/cleanup error'];

export function hasResourceFailure(text) {
  return RESOURCE_FAILURE_MARKERS.some((m) => text.includes(m));
}

/** Evaluate a consumer scenario against its expected exit + assertion marker. */
export function evaluateScenario(scenario, res) {
  if (res.error) return { status: 'FAIL', why: `spawn error: ${res.error}` };
  if (res.signal) return { status: 'FAIL', why: `killed by ${res.signal}` };
  const resourceFailure = hasResourceFailure(res.stderr);
  if (scenario.expectExit === 0) {
    if (res.code !== 0) return { status: 'FAIL', why: `expected exit 0, got ${res.code}` };
    if (scenario.expectStdout && !res.stdout.includes(scenario.expectStdout)) {
      return { status: 'FAIL', why: `missing expected stdout marker: ${JSON.stringify(scenario.expectStdout)}` };
    }
    if (resourceFailure) return { status: 'FAIL', why: 'positive run had a resource/cleanup failure' };
    return { status: 'PASS' };
  }
  if (res.code !== 1) return { status: 'FAIL', why: `expected exit 1 (assertion), got ${res.code ?? 'null'}` };
  if (scenario.expectStderr && !res.stderr.includes(scenario.expectStderr)) {
    return { status: 'FAIL', why: `missing intended assertion ${JSON.stringify(scenario.expectStderr)} in stderr` };
  }
  if (resourceFailure) return { status: 'FAIL', why: 'negative run had a resource/cleanup failure alongside the assertion' };
  return { status: 'PASS' };
}

/** Re-verify that HEAD and release inputs did not change during the release work. */
function recheckSourceBinding(root, originalHead) {
  const head = P.gitHead(root);
  const headChanged = !head.ok || head.hash !== originalHead;
  let releaseBlocked = true;
  let dirtyDetail = null;
  if (!headChanged) {
    const dirty = P.gitDirty(root);
    if (!dirty.ok) dirtyDetail = dirty.error;
    else releaseBlocked = P.analyzeInputs(root, dirty).releaseBlocked;
  }
  return {
    clean: !headChanged && !releaseBlocked && !dirtyDetail,
    headChanged,
    releaseBlocked,
    head: head.ok ? head.hash : head.error,
    dirtyDetail,
  };
}

/** Print the provenance record as stable text lines (also the human-facing summary). */
function printRecord(record, execute) {
  const g = record.git;
  console.log('--- provenance summary ---');
  console.log(`runner version    : ${record.runnerVersion}`);
  console.log(`mode              : ${execute ? 'execute' : 'readiness'}`);
  console.log(`source commit     : ${g.head.ok ? g.head.hash : 'FAILED: ' + g.head.error}`);
  console.log(`source tag        : ${g.tag.ok ? (g.tag.tag ?? '(none)') : 'FAILED: ' + g.tag.error}`);
  console.log(`package name      : ${record.package.name}`);
  console.log(`package version   : ${record.package.version}`);
  console.log(`build command     : ${record.buildCommand}`);
  console.log(`node version      : ${versionLine(record.nodeVersion)}`);
  console.log(`npm version       : ${versionLine(record.npmVersion)}`);
  console.log(`typescript version: ${versionLine(record.typescriptVersion)}`);
  console.log(`runner hash       : ${record.runnerHash}`);
  console.log(`consumer hash     : ${record.consumerHash}`);
  console.log(`release blocked   : ${record.inputs.releaseBlocked}`);
  const cats = record.inputs.categories;
  for (const cat of ['build', 'package', 'acceptance']) {
    for (const entry of cats[cat]) {
      console.log(`  dirty ${cat} input : ${entry.path} [${entry.kinds.join(', ')}]${entry.digest ? ' ' + entry.digest.sha256 : ''}`);
    }
  }
  for (const entry of cats['non-input']) {
    console.log(`  dirty non-input  : ${entry.path} [${entry.kinds.join(', ')}]`);
  }
  if (execute && record.execution) {
    const ex = record.execution;
    console.log(`artifact          : ${ex.artifact ? ex.artifact.filename : '(none)'}`);
    if (ex.artifact) console.log(`artifact sha256   : ${ex.artifact.sha256}`);
    console.log(`installed version : ${ex.installed ? `${ex.installed.name}@${ex.installed.version}` : '(none)'}`);
    for (const s of SCENARIOS) {
      const r = ex.scenarios[s.id];
      console.log(`scenario ${s.id.padEnd(22)} : ${r ? r.outcome.status : 'NOT_RUN'}`);
    }
    console.log(`typecheck         : ${ex.typecheck ? ex.typecheck.status : 'NOT_RUN'}`);
    console.log(`source binding    : ${ex.sourceBinding ? (ex.sourceBinding.clean ? 'clean' : 'DIRTY') : 'NOT_RUN'}`);
    console.log(`outcome           : ${ex.outcome}`);
  }
}

function printScenarioFailure(ex) {
  for (const s of SCENARIOS) {
    const r = ex.scenarios[s.id];
    if (!r || r.outcome.status !== 'PASS') {
      console.error(`[scenario:${s.id}] ${r ? r.outcome.why : 'NOT_RUN'}`);
      if (r && r.stderr) console.error(r.stderr.trim());
    }
  }
}

async function orchestrate(execute) {
  const record = {
    runnerVersion: RUNNER_VERSION,
    package: readJson(join(ROOT, 'package.json')),
    buildCommand: readJson(join(ROOT, 'package.json')).scripts.build,
    nodeVersion: toolVersion(P.run(process.execPath, ['--version']), 'node'),
    npmVersion: toolVersion(runNpm(['--version']), 'npm'),
    typescriptVersion: typescriptVersion(ROOT),
    runnerHash: contentHash(RUNNER_FILES),
    consumerHash: contentHash(CONSUMER_FILES),
    git: {},
    inputs: null,
    execution: null,
  };

  // Traceability: a git failure here is a hard failure, never an empty hash + PASS.
  record.git.head = P.gitHead(ROOT);
  if (!record.git.head.ok) fail('git', record.git.head.error);
  record.git.tag = P.gitExactTag(ROOT);
  if (!record.git.tag.ok) fail('git', record.git.tag.error);

  // Input classification: staged / unstaged / untracked, per category.
  const dirty = P.gitDirty(ROOT);
  if (!dirty.ok) fail('git', dirty.error);
  const inputs = P.analyzeInputs(ROOT, dirty);
  for (const cat of ['build', 'package', 'acceptance']) {
    for (const entry of inputs.categories[cat]) {
      entry.digest = P.workDigest(ROOT, entry.path);
      entry.headDigest = P.headDigest(ROOT, entry.path);
    }
  }
  record.inputs = inputs;

  if (inputs.releaseBlocked) {
    printRecord(record, execute);
    fail(
      'clean-release',
      'dirty build/package/acceptance inputs block a clean HEAD release; ' +
        'commit all release inputs first (non-input files above may remain dirty).',
    );
  }

  if (!execute) {
    printRecord(record, false);
    console.log('readiness: clean HEAD release inputs present; run `node acceptance/run.mjs --execute` to build+pack+install.');
    return 0;
  }

  // ================= gated execution =================
  const runId = `${Date.now()}-${process.pid}`;
  const outputDir = join(EVIDENCE_ROOT, `run-${runId}`);
  const consumerDir = join(outputDir, 'consumer');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  const startedAt = new Date().toISOString();
  console.log(`[acceptance] run id      : ${runId}`);
  console.log(`[acceptance] evidence dir: ${outputDir}`);
  console.log(`[acceptance] started     : ${startedAt}`);

  const evidence = {
    ...record,
    runId,
    startedAt,
    endedAt: null,
    execution: {
      outputDir,
      commands: [],
      artifact: null,
      installed: null,
      packedNonDist: null,
      scenarios: {},
      typecheck: null,
      sourceBinding: null,
      cleanupError: null,
      outcome: 'NOT_RUN',
      primaryError: null,
    },
  };

  let failure = null;
  try {
    // 1. Clean the generated dist only, after confirming it stays inside the root.
    const del = P.safeDirDeletion(ROOT, 'dist');
    if (!del.ok) fail('clean-dist', del.error);
    rmSync(del.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    // 2. Fresh build.
    const build = runNpm(['run', 'build'], { cwd: ROOT, timeout: 300_000 });
    evidence.execution.commands.push(cmdRecord(build, 'build'));
    check('build', build);

    // 3. Pack into the unique output dir (immutable artifact path, no overwrite).
    const pack = runNpm(['pack', '--json', '--pack-destination', outputDir], { cwd: ROOT, timeout: 300_000 });
    evidence.execution.commands.push(cmdRecord(pack, 'pack'));
    check('pack', pack);
    let packInfo;
    try {
      [packInfo] = JSON.parse(pack.stdout);
    } catch (err) {
      fail('pack-parse', String(err));
    }
    const tarballPath = join(outputDir, packInfo.filename);
    const artifact = {
      filename: packInfo.filename,
      path: tarballPath,
      sha256: P.sha256File(tarballPath),
      size: packInfo.size,
      unpackedSize: packInfo.unpackedSize,
      npmShasum: packInfo.shasum,
      npmIntegrity: packInfo.integrity,
      files: (packInfo.files || []).map((f) => f.path),
    };
    evidence.execution.artifact = artifact;

    // Reconcile actual non-generated pack entries against the recorded list.
    const nonDist = artifact.files.filter((f) => f !== 'dist' && !f.startsWith('dist/')).sort();
    const unexpected = nonDist.filter((f) => !EXPECTED_NON_DIST_PACK.includes(f));
    const missing = EXPECTED_NON_DIST_PACK.filter((f) => !nonDist.includes(f));
    evidence.execution.packedNonDist = { actual: nonDist, expected: EXPECTED_NON_DIST_PACK, unexpected, missing };
    if (unexpected.length > 0 || missing.length > 0) {
      fail('pack-contents', `non-dist pack entries changed: unexpected=${JSON.stringify(unexpected)} missing=${JSON.stringify(missing)}`);
    }

    // 4. Independent consumer directory: install the exact tgz by file dependency
    //    (never a source path, `../dist`, `npm link`, or a dev-machine alias).
    copyFileSync(tarballPath, join(consumerDir, packInfo.filename));
    copyFileSync(join(ROOT, 'acceptance', 'consumer.mjs'), join(consumerDir, 'consumer.mjs'));
    copyFileSync(join(ROOT, 'acceptance', 'consumer-types.ts'), join(consumerDir, 'consumer-types.ts'));
    writeFileSync(
      join(consumerDir, 'package.json'),
      JSON.stringify(
        {
          name: 'consumer-acceptance',
          private: true,
          type: 'module',
          dependencies: {
            'better-sqlite3': '^12.0.0',
            [record.package.name]: `file:./${packInfo.filename}`,
          },
          devDependencies: { '@types/node': '^24.0.0', typescript: '^5.9.2' },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(consumerDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ['node'],
          },
          include: ['consumer-types.ts'],
        },
        null,
        2,
      ),
    );

    // 5. Install the tarball + driver + TypeScript.
    const install = runNpm(['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: consumerDir, timeout: 600_000 });
    evidence.execution.commands.push(cmdRecord(install, 'install'));
    check('install', install);

    // Installed package identity must equal the manifest AND the actual pack.
    const installedPkg = readJson(join(consumerDir, 'node_modules', record.package.name, 'package.json'));
    evidence.execution.installed = { name: installedPkg.name, version: installedPkg.version };
    if (installedPkg.name !== record.package.name || installedPkg.name !== packInfo.name) {
      fail('installed-name', `installed ${installedPkg.name} != manifest ${record.package.name} / pack ${packInfo.name}`);
    }
    if (installedPkg.version !== record.package.version || installedPkg.version !== packInfo.version) {
      fail('installed-version', `installed ${installedPkg.version} != manifest ${record.package.version} / pack ${packInfo.version}`);
    }

    // 6. Consumer scenarios: positive + two negative modes, each a fresh process.
    for (const scenario of SCENARIOS) {
      const res = P.run(process.execPath, ['consumer.mjs', ...scenario.flags], { cwd: consumerDir, timeout: 120_000 });
      evidence.execution.commands.push(cmdRecord(res, `consumer:${scenario.id}`));
      const outcome = evaluateScenario(scenario, res);
      evidence.execution.scenarios[scenario.id] = {
        flags: scenario.flags,
        expectedExit: scenario.expectExit,
        expectedMarker: scenario.expectExit === 0 ? scenario.expectStdout : scenario.expectStderr,
        outcome,
        code: res.code,
        signal: res.signal,
        error: res.error,
        stdout: res.stdout,
        stderr: res.stderr,
      };
      if (outcome.status !== 'PASS') fail(`scenario:${scenario.id}`, outcome.why);
      process.stdout.write(res.stdout);
    }

    // 7. Public type resolution through the installed package's declarations.
    const tsc = P.run(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.json'], { cwd: consumerDir, timeout: 120_000 });
    evidence.execution.commands.push(cmdRecord(tsc, 'tsc'));
    check('tsc --noEmit', tsc);
    evidence.execution.typecheck = { status: 'PASS' };
    console.log('type-check: PASS (public types resolve from the installed package)');
  } catch (err) {
    failure = err;
  }

  // Source binding: reject if HEAD/release inputs changed during the release work.
  const sourceBinding = recheckSourceBinding(ROOT, record.git.head.hash);
  evidence.execution.sourceBinding = sourceBinding;
  if (!failure && !sourceBinding.clean) {
    failure = new AcceptanceFailure(
      `[source-binding] ${sourceBinding.headChanged ? 'HEAD changed during release work' : 'release inputs changed during release work'}`,
    );
  }

  // Reclaim only the transient consumer install; keep evidence + artifact. Reuse the
  // same confined-path validation as `dist` so a re-pointed/symlinked consumer dir
  // cannot escape the run output dir, and delete the returned resolved path.
  const consumerDel = P.safeDirDeletion(outputDir, 'consumer');
  if (consumerDel.ok) {
    try {
      rmSync(consumerDel.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (cleanupErr) {
      evidence.execution.cleanupError = String(cleanupErr.message || cleanupErr);
      console.error(`[cleanup] could not remove ${consumerDel.path}: ${cleanupErr.message}`);
    }
  } else {
    evidence.execution.cleanupError = consumerDel.error;
    console.error(`[cleanup] ${consumerDel.error}`);
  }

  // Reflect the true end of the run (after cleanup), never before it.
  evidence.endedAt = new Date().toISOString();

  const cleanupFailure = evidence.execution.cleanupError
    ? new AcceptanceFailure(`[cleanup] ${evidence.execution.cleanupError}`)
    : null;
  const failed = failure !== null || cleanupFailure !== null;
  if (failed) {
    evidence.execution.outcome = 'FAIL';
    evidence.execution.primaryError = failure ? String(failure.message || failure) : null;
  } else {
    evidence.execution.outcome = 'PASS';
  }

  // Persist evidence (success OR failure) at the unique run output path.
  writeFileSync(join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  printRecord(evidence, execute);

  if (failed) {
    console.error('--- acceptance summary ---');
    console.error('independent consumer acceptance: FAIL');
    printScenarioFailure(evidence.execution);
    if (failure) console.error(`primary error   : ${failure.message}`);
    if (evidence.execution.cleanupError) console.error(`cleanup error   : ${evidence.execution.cleanupError}`);
    console.error(`evidence        : ${join(outputDir, 'evidence.json')}`);
    throw failure ?? cleanupFailure;
  }

  console.log('--- acceptance summary ---');
  console.log('independent consumer acceptance: PASS (positive + both negative modes + type check)');
  console.log(`evidence         : ${join(outputDir, 'evidence.json')}`);
  console.log(`artifact         : ${evidence.execution.artifact.path}`);
  return 0;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const code = await orchestrate(execute);
  process.exitCode = code;
}

// Direct-entry guard: only run the orchestrator when this file is the CLI entry,
// so `run.test.mjs` can import the exported helpers without triggering a run.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[acceptance] hard failure:');
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
