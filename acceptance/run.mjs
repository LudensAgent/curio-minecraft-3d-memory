/**
 * Independent consumer acceptance orchestrator with full provenance.
 *
 * Two modes:
 *
 *   node acceptance/run.mjs            # readiness: gather provenance + classify
 *                                      #   inputs; fail (non-zero) on a git error
 *                                      #   or dirty build/package/acceptance input
 *   node acceptance/run.mjs --execute  # after a clean gate: clean-dist build,
 *                                      #   pack, independent install, runtime +
 *                                      #   type checks, evidence + artifact kept
 *
 * The readiness check is the whole point of "L5 provenance": it never reports a
 * clean HEAD package when the working copy differs, and it distinguishes a real
 * git failure from a merely-absent tag. The destructive clean-dist build + pack +
 * install only runs behind `--execute`, so a dry readiness run never touches the
 * worktree `dist/` or the network.
 *
 * Errors are carried by exceptions through an owning I/O boundary; there are no
 * `process.exit` shortcuts that would skip `finally`, so cleanup always runs and
 * the primary error is never masked by a cleanup failure.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as P from './provenance.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNNER_VERSION = '0.7.5';
const RUNNER_FILES = ['acceptance/run.mjs', 'acceptance/provenance.mjs'];
const CONSUMER_FILES = ['acceptance/consumer.mjs', 'acceptance/consumer-types.ts'];
const EVIDENCE_ROOT = join(tmpdir(), 'curio-minecraft-3d-memory-acceptance');

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
  console.log(`node version      : ${record.nodeVersion}`);
  console.log(`npm version       : ${record.npmVersion}`);
  console.log(`typescript version: ${record.typescriptVersion}`);
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
    console.log(`artifact          : ${record.execution.artifact.filename}`);
    console.log(`artifact sha256   : ${record.execution.artifact.sha256}`);
    console.log(`installed version : ${record.execution.installedVersion}`);
    console.log(`scenarios         : ${JSON.stringify(record.execution.scenarios)}`);
  }
}

async function orchestrate(execute) {
  const record = {
    runnerVersion: RUNNER_VERSION,
    package: readJson(join(ROOT, 'package.json')),
    buildCommand: readJson(join(ROOT, 'package.json')).scripts.build,
    nodeVersion: P.run(process.execPath, ['--version']).stdout.trim(),
    npmVersion: runNpm(['--version']).stdout.trim(),
    typescriptVersion: readJson(join(ROOT, 'node_modules', 'typescript', 'package.json')).version,
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

  const commands = [];

  try {
    // 1. Clean the generated dist only, after confirming it stays inside the root.
    const del = P.safeDirDeletion(ROOT, 'dist');
    if (!del.ok) fail('clean-dist', del.error);
    rmSync(del.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    // 2. Fresh build.
    const build = runNpm(['run', 'build'], { cwd: ROOT, timeout: 300_000 });
    commands.push(build);
    check('build', build);

    // 3. Pack into the unique output dir (immutable artifact path, no overwrite).
    const pack = runNpm(['pack', '--json', '--pack-destination', outputDir], { cwd: ROOT, timeout: 300_000 });
    commands.push(pack);
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
    commands.push(install);
    check('install', install);
    const installedVersion = readJson(join(consumerDir, 'node_modules', record.package.name, 'package.json')).version;

    // 6. Runtime assertions (real SQLite Worker + Fake body walk lifecycle).
    const consumer = P.run(process.execPath, ['consumer.mjs'], { cwd: consumerDir, timeout: 120_000 });
    commands.push(consumer);
    check('consumer.mjs', consumer);
    process.stdout.write(consumer.stdout);

    // 7. Public type resolution through the installed package's declarations.
    const tsc = P.run(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.json'], { cwd: consumerDir, timeout: 120_000 });
    commands.push(tsc);
    check('tsc --noEmit', tsc);
    console.log('type-check: PASS (public types resolve from the installed package)');

    // Consumer's positive path held. B2a's two negative modes (release-pin-early,
    // skip-final-checkpoint) are owned by the consumer stage and wired once their
    // committed CLI options exist; record them as pending, never a fabricated PASS.
    const scenarios = {
      positive: { outcome: 'PASS', command: ['node', 'consumer.mjs'] },
      'release-pin-early': { outcome: 'PENDING', note: 'consumer stage owns flags; not wired yet' },
      'skip-final-checkpoint': { outcome: 'PENDING', note: 'consumer stage owns flags; not wired yet' },
    };

    record.execution = {
      outputDir,
      artifact,
      installedVersion,
      scenarios,
      commands: commands.map((c) => ({ cmd: c.cmd, args: c.args, cwd: c.cwd, code: c.code, signal: c.signal, error: c.error })),
      packedDefaultInclusions: {
        packageJson: artifact.files.includes('package.json'),
        readme: artifact.files.includes('README.md'),
        license: artifact.files.includes('LICENSE'),
      },
    };

    writeFileSync(join(outputDir, 'evidence.json'), JSON.stringify(record, null, 2));
    printRecord(record, execute);

    console.log('--- acceptance summary ---');
    console.log(`independent consumer acceptance: PASS`);
    console.log(`evidence         : ${join(outputDir, 'evidence.json')}`);
    console.log(`artifact         : ${artifact.path}`);
    return 0;
  } finally {
    // Keep the evidence + immutable artifact; reclaim only the transient consumer
    // install. A cleanup failure is reported but never masks the primary result.
    try {
      rmSync(consumerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (cleanupErr) {
      console.error(`[cleanup] could not remove ${consumerDir}: ${cleanupErr.message}`);
    }
  }
}

async function main() {
  const execute = process.argv.includes('--execute');
  const code = await orchestrate(execute);
  process.exitCode = code;
}

main().catch((err) => {
  console.error('[acceptance] hard failure:');
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
