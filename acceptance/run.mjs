/**
 * Independent consumer acceptance orchestrator.
 *
 * Packs the real `.tgz`, installs it into a throwaway directory together with the
 * SQLite driver and TypeScript, then runs `consumer.mjs` (runtime assertions) and
 * `tsc --noEmit` over `consumer-types.ts` (type resolution). Every stage is a hard
 * check: a failure prints a non-zero exit, so a green run is evidence, not prose.
 *
 * Run from the repository root:
 *
 *   node acceptance/run.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Run an npm subcommand through the platform shell (npm is a `.cmd` shim on Windows). */
function runNpm(args, opts = {}) {
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')], opts);
  }
  return run('npm', args, opts);
}

function fail(stage, detail) {
  console.error(`[acceptance] FAIL at ${stage}`);
  console.error(detail.trim());
  process.exit(1);
}

function check(stage, res) {
  if (res.code !== 0) fail(stage, res.stderr || res.stdout);
}

// 1. Traceability: source commit + package version.
const head = run('git', ['rev-parse', 'HEAD'], { cwd: root });
const tag = run('git', ['describe', '--tags', '--exact-match'], { cwd: root });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 2. Build + pack.
check('build', runNpm(['run', 'build'], { cwd: root }));
const pack = runNpm(['pack', '--json'], { cwd: root });
check('pack', pack);
let filename;
let packedVersion;
try {
  const [entry] = JSON.parse(pack.stdout);
  filename = entry.filename;
  packedVersion = entry.version;
} catch (err) {
  fail('pack-parse', String(err));
}
const tarballPath = join(root, filename);
const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');

// 3. Throwaway consumer directory.
const tempDir = mkdtempSync(join(tmpdir(), 'consumer-acceptance-'));
const consumerDir = join(tempDir, 'app');
mkdirSync(consumerDir, { recursive: true });

try {
  copyFileSync(tarballPath, join(consumerDir, filename));
  copyFileSync(join(root, 'acceptance', 'consumer.mjs'), join(consumerDir, 'consumer.mjs'));
  copyFileSync(join(root, 'acceptance', 'consumer-types.ts'), join(consumerDir, 'consumer-types.ts'));

  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'consumer-acceptance',
        private: true,
        type: 'module',
        dependencies: {
          'better-sqlite3': '^12.0.0',
          'curio-minecraft-3d-memory': `file:./${filename}`,
        },
        devDependencies: {
          '@types/node': '^24.0.0',
          typescript: '^5.9.2',
        },
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

  // 4. Install the tarball + driver + TypeScript into the consumer directory.
  check('install', runNpm(['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: consumerDir }));

  // 5. Runtime assertions (worker startup, save/restore, passability, execution).
  const consumer = run(process.execPath, ['consumer.mjs'], { cwd: consumerDir });
  if (consumer.code !== 0) fail('consumer.mjs', consumer.stderr || consumer.stdout);
  process.stdout.write(consumer.stdout);

  // 6. Type resolution through the installed package's declaration files.
  const tsc = run(process.execPath, ['node_modules/typescript/lib/tsc.js', '-p', 'tsconfig.json'], { cwd: consumerDir });
  if (tsc.code !== 0) fail('tsc --noEmit', tsc.stdout || tsc.stderr);
  console.log('type-check: PASS (public types resolve from the installed package)');

  console.log('--- acceptance summary ---');
  console.log(`source commit : ${head.stdout.trim()}`);
  console.log(`source tag    : ${tag.stdout.trim() || '(none)'}`);
  console.log(`package name  : ${pkg.name}`);
  console.log(`package version: ${pkg.version} (packed as ${packedVersion})`);
  console.log(`artifact      : ${filename}`);
  console.log(`sha256        : ${sha256}`);
  console.log('independent consumer acceptance: PASS');
} finally {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
