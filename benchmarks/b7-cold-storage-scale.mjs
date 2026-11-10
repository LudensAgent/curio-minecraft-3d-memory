/**
 * B7 cold-storage scale acceptance: many distinct observed cells, bounded dirty
 * checkpoints, manual residency, then cold reopen/read-back.
 *
 * Build current sources first: npm run build
 *
 * Run the full 4,000,000-cell acceptance:
 *   node --max-old-space-size=8192 benchmarks/b7-cold-storage-scale.mjs
 *
 * Small validation run (same code path, 50,000 cells):
 *   node --max-old-space-size=8192 benchmarks/b7-cold-storage-scale.mjs --cells=50000
 *
 * What it measures / asserts:
 *   1. Write `cells` distinct cells across dense 16x16x16 Sections in manual
 *      residency mode. Each cell is written once with a unique sequence and
 *      observedAt. Sections are filled, checkpointed in bounded dirty batches
 *      (`voxelBatchMaxBytes`), then unloaded so the resident working set stays
 *      bounded by `residencyLimits`.
 *   2. Close, reopen in manual mode, load the earliest and latest Sections, and
 *      assert the earliest cell's state and original observedAt survived and the
 *      loaded evidence is STALE (never silently FRESH after a cold restart).
 *   3. Write one new cell state incrementally, checkpoint, close, restart, and
 *      assert the new state/observedAt is read while older cells stay readable.
 *
 * Cell layout (dense Sections, not sparse columns):
 *   Section index s = floor(i / 4096), cell index j = i % 4096.
 *   cx = s % 16, cz = floor(s / 16) % 16, sy = floor(s / 256).
 *   lx = j & 15, ly = (j >> 4) & 15, lz = (j >> 8) & 15.
 *   pos = (cx*16 + lx, sy*16 + ly, cz*16 + lz).
 * This fills 16x16x16 Sections; the suggested sparse formula
 * (x = i%64, z = floor(i/64)%64, y = floor(i/4096)) would instead create ~15,872
 * Sections holding only 256 cells each, contradicting the ~1024-Section target
 * and the maxVoxelSections budget.
 *
 * This is a synthetic library/storage probe. It does not run Minecraft, does not
 * measure a real host's event-loop delay, and does not claim gameplay behavior.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const WORLD = 'b7-cold-storage-scale';
const DIM = 'overworld';
const WRITE_SESSION = 'b7-write';
const WRITE_SESSION_2 = 'b7-write-2';
const GAME_VERSION = '1.20.1';
const SECTION_CELLS = 16 * 16 * 16;
const STONE = Object.freeze({ name: 'minecraft:stone', properties: {} });
const DIRT = Object.freeze({ name: 'minecraft:dirt', properties: {} });
/** Fixed synthetic acquisition epoch (2023-11-14T22:13:20Z), not wall-clock time. */
const BASE_OBSERVED_AT = 1_700_000_000_000;

const DEFAULTS = {
  cells: 4_000_000,
  groupSections: 32,
  batchBytes: 16 * 1024 * 1024,
  maxBytes: 3 * 1024 * 1024 * 1024,
  residencyBytes: 128 * 1024 * 1024,
  residencySections: 64,
  timeoutMs: 120_000,
  sampleMs: 200,
  keepDb: false,
  dbPath: null,
};

function usage() {
  return [
    'Usage: node --max-old-space-size=8192 benchmarks/b7-cold-storage-scale.mjs [options]',
    '',
    'Options:',
    '  --cells=<n>               distinct observed cells (default 4000000)',
    '  --sections-per-group=<n>  Sections filled/checkpointed/unloaded per cycle (default 32)',
    '  --batch-bytes=<n>         per-checkpoint voxel dirty-batch byte cap (default 16 MiB)',
    '  --max-bytes=<n>           snapshotLimits.maxBytes, must cover the committed full set (default 3 GiB)',
    '  --residency-bytes=<n>     maxResidentBytes working-set cap (default 128 MiB)',
    '  --residency-sections=<n>  maxResidentSections working-set cap (default 64)',
    '  --timeout-ms=<n>          persistence operation timeout (default 120000)',
    '  --sample-ms=<n>           memory sampling interval (default 200)',
    '  --db=<path>               database path (default: a fresh temp directory)',
    '  --keep-db                 keep the database after a successful run',
    '  --help                    print this help',
  ].join('\n');
}

function parsePositiveInt(name, raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer, got "${raw}"`);
  }
  return value;
}

function parseArgs(argv) {
  const config = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--keep-db') {
      config.keepDb = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match === null) throw new Error(`unknown argument "${arg}" (see --help)`);
    const [, key, raw] = match;
    switch (key) {
      case 'cells':
        config.cells = parsePositiveInt('--cells', raw);
        break;
      case 'sections-per-group':
        config.groupSections = parsePositiveInt('--sections-per-group', raw);
        break;
      case 'batch-bytes':
        config.batchBytes = parsePositiveInt('--batch-bytes', raw);
        break;
      case 'max-bytes':
        config.maxBytes = parsePositiveInt('--max-bytes', raw);
        break;
      case 'residency-bytes':
        config.residencyBytes = parsePositiveInt('--residency-bytes', raw);
        break;
      case 'residency-sections':
        config.residencySections = parsePositiveInt('--residency-sections', raw);
        break;
      case 'timeout-ms':
        config.timeoutMs = parsePositiveInt('--timeout-ms', raw);
        break;
      case 'sample-ms':
        config.sampleMs = parsePositiveInt('--sample-ms', raw);
        break;
      case 'db':
        if (raw.length === 0) throw new Error('--db must be a non-empty path');
        config.dbPath = path.resolve(raw);
        break;
      default:
        throw new Error(`unknown option "--${key}" (see --help)`);
    }
  }
  if (config.batchBytes > config.maxBytes) {
    throw new Error('--batch-bytes must not exceed --max-bytes');
  }
  if (config.groupSections > config.residencySections) {
    throw new Error('--sections-per-group must not exceed --residency-sections');
  }
  return config;
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function mb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

/** Read a `--name=value` (or `--name value`) Node option from `process.execArgv`. */
function nodeOption(name) {
  const prefix = `${name}=`;
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === name && process.execArgv[index + 1] !== undefined) return process.execArgv[index + 1];
  }
  return null;
}

function startMemorySampler(intervalMs) {
  const peak = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };
  const sample = () => {
    const usage = process.memoryUsage();
    peak.rss = Math.max(peak.rss, usage.rss);
    peak.heapUsed = Math.max(peak.heapUsed, usage.heapUsed);
    peak.heapTotal = Math.max(peak.heapTotal, usage.heapTotal);
    peak.external = Math.max(peak.external, usage.external);
    peak.arrayBuffers = Math.max(peak.arrayBuffers, usage.arrayBuffers);
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    sample,
    stop() {
      clearInterval(timer);
      sample();
      return {
        peakRssBytes: peak.rss,
        peakHeapUsedBytes: peak.heapUsed,
        peakHeapTotalBytes: peak.heapTotal,
        peakExternalBytes: peak.external,
        peakArrayBuffersBytes: peak.arrayBuffers,
      };
    },
  };
}

function prepareDatabase(config) {
  if (config.dbPath !== null) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    return { dbPath: config.dbPath, dir: null, createdDir: false };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-cold-storage-'));
  return { dbPath: path.join(dir, 'world.sqlite'), dir, createdDir: true };
}

function dbFileSizes(dbPath) {
  const files = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    try {
      files[suffix === '' ? 'main' : suffix.slice(1)] = fs.statSync(file).size;
    } catch {
      // File absent (for example a cleanly checkpointed/removed -wal).
    }
  }
  return files;
}

function dbSizeBytes(dbPath) {
  return Object.values(dbFileSizes(dbPath)).reduce((sum, size) => sum + size, 0);
}

function readCommittedFacts(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS sections,
              COALESCE(SUM(observed_cells), 0) AS observedCells,
              COALESCE(SUM(palette_entries), 0) AS paletteEntries,
              COALESCE(SUM(octet_length(payload)), 0) AS payloadBytes
         FROM spatial_sections WHERE world_id = ?`,
    ).get(WORLD);
    const checkpoint = db.prepare(
      'SELECT COUNT(*) AS checkpoints, MAX(seq) AS lastSeq FROM checkpoints WHERE world_id = ?',
    ).get(WORLD);
    return {
      sections: row.sections,
      observedCells: row.observedCells,
      paletteEntries: row.paletteEntries,
      payloadBytes: row.payloadBytes,
      checkpoints: checkpoint.checkpoints,
      lastCheckpointSeq: checkpoint.lastSeq,
    };
  } finally {
    db.close();
  }
}

function totalSectionsFor(cells) {
  return Math.ceil(cells / SECTION_CELLS);
}

function sectionCoords(s) {
  return { cx: s % 16, cz: Math.floor(s / 16) % 16, sy: Math.floor(s / 256) };
}

function sectionKey(s) {
  const { cx, cz, sy } = sectionCoords(s);
  return { worldId: WORLD, dim: DIM, cx, cz, sy };
}

/** World position of local cell `j` inside Section `s` (both within one 16^3). */
function cellPosition(s, j) {
  const { cx, cz, sy } = sectionCoords(s);
  const lx = j & 15;
  const ly = (j >> 4) & 15;
  const lz = (j >> 8) & 15;
  return { x: cx * 16 + lx, y: sy * 16 + ly, z: cz * 16 + lz };
}

function cellsInSection(s, totalCells) {
  return Math.max(0, Math.min(SECTION_CELLS, totalCells - s * SECTION_CELLS));
}

function makeObservation(s, j, state, observedAt, sequence) {
  return {
    worldId: WORLD,
    dim: DIM,
    pos: cellPosition(s, j),
    state,
    stateComplete: true,
    evidence: 'seen',
    observedAt,
    source: 'vision',
    sessionId: WRITE_SESSION,
    sequence,
  };
}

function buildOpenOptions(config, dbPath, totals) {
  return {
    databasePath: dbPath,
    worldId: WORLD,
    voxelLoading: 'manual',
    gameVersion: GAME_VERSION,
    voxelBatchMaxBytes: config.batchBytes,
    snapshotLimits: {
      maxBytes: config.maxBytes,
      maxVoxelSections: totals.sections + 128,
      maxObservedCells: config.cells + 100_000,
      maxPaletteEntries: totals.sections + 10_000,
    },
    residencyLimits: {
      maxResidentSections: config.residencySections,
      maxResidentBytes: config.residencyBytes,
      maxLoadBatchSections: 64,
      maxPins: 1024,
      maxPinnedSections: 10_000,
    },
    timeoutMs: config.timeoutMs,
  };
}

function summarizeClose(result) {
  return {
    completed: result.completed,
    dirty: result.dirty,
    unconfirmedRequest: result.unconfirmedRequest,
    lastConfirmedCheckpointId: result.lastConfirmedCheckpointId,
    error: result.error === null ? null : { kind: result.error.kind, message: result.error.message },
  };
}

function assertCell(session, pos, expected, label) {
  const cell = session.voxel.cellAt(DIM, pos.x, pos.y, pos.z);
  assert(cell.observed === true, `${label}: cell (${pos.x},${pos.y},${pos.z}) is not observed`);
  const observation = cell.evidence.observation;
  assert(
    observation.state.name === expected.state,
    `${label}: expected state ${expected.state}, got ${observation.state.name}`,
  );
  assert(
    JSON.stringify(observation.state.properties) === JSON.stringify(expected.properties ?? {}),
    `${label}: state properties changed`,
  );
  assert(
    observation.observedAt === expected.observedAt,
    `${label}: expected observedAt ${expected.observedAt}, got ${observation.observedAt}`,
  );
  assert(observation.stateComplete === true, `${label}: stateComplete was not preserved`);
  assert(observation.evidence === 'seen', `${label}: evidence kind was not preserved`);
  assert(cell.evidence.freshness === 'STALE', `${label}: restored evidence is not STALE`);
  return {
    pos,
    state: observation.state.name,
    observedAt: observation.observedAt,
    freshness: cell.evidence.freshness,
  };
}

async function run(config) {
  const totals = {
    cells: config.cells,
    sections: totalSectionsFor(config.cells),
    lastSection: totalSectionsFor(config.cells) - 1,
    lastSectionCells: cellsInSection(totalSectionsFor(config.cells) - 1, config.cells),
  };
  const sampler = startMemorySampler(config.sampleMs);
  const dbInfo = prepareDatabase(config);
  const options = buildOpenOptions(config, dbInfo.dbPath, totals);
  const report = {
    ok: false,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      execArgv: process.execArgv,
      maxOldSpaceSizeMb: nodeOption('--max-old-space-size'),
    },
    config: { ...config, dbPath: dbInfo.dbPath },
    layout: {
      worldId: WORLD,
      dim: DIM,
      cells: totals.cells,
      sections: totals.sections,
      lastSectionCells: totals.lastSectionCells,
      occupancy: `${totals.cells} cells in ${totals.sections} dense Sections ` +
        `(${totals.sections - 1} full + 1 with ${totals.lastSectionCells})`,
    },
    phases: {},
    counts: {},
    checkpoints: { count: 0, totalMs: 0, maxMs: 0, perPhase: {} },
    residency: { maxObservedSections: 0, maxObservedBytes: 0 },
    assertions: {},
    memory: null,
    database: { path: dbInfo.dbPath, sizeBytes: 0, files: {} },
  };

  let session = null;
  let phase = 'setup';
  let checkpointsInPhase = 0;
  let checkpointMsInPhase = 0;

  const beginPhase = (name) => {
    phase = name;
    checkpointsInPhase = 0;
    checkpointMsInPhase = 0;
  };
  const endPhase = () => {
    report.checkpoints.perPhase[phase] = {
      count: checkpointsInPhase,
      totalMs: Number(checkpointMsInPhase.toFixed(1)),
    };
  };
  const checkpointOnce = async (active) => {
    const started = performance.now();
    const result = await active.checkpoint();
    const elapsed = performance.now() - started;
    report.checkpoints.count += 1;
    report.checkpoints.totalMs += elapsed;
    report.checkpoints.maxMs = Math.max(report.checkpoints.maxMs, elapsed);
    checkpointsInPhase += 1;
    checkpointMsInPhase += elapsed;
    return result;
  };
  const observeResidency = (active) => {
    const resident = active.voxel.residentSize();
    report.residency.maxObservedSections = Math.max(report.residency.maxObservedSections, resident.sections);
    report.residency.maxObservedBytes = Math.max(report.residency.maxObservedBytes, resident.bytes);
  };

  try {
    // ------------------------------------------------------------------
    // Phase A: fill, bounded-save, and unload group by group.
    // ------------------------------------------------------------------
    beginPhase('writeAndSave');
    const writeStarted = performance.now();
    session = await openSpatialSession(options);
    assert(session.voxelLoading === 'manual', 'session did not open in manual residency mode');
    session.voxel.beginSession(WRITE_SESSION);

    let observationsWritten = 0;
    let groups = 0;
    for (let groupStart = 0; groupStart < totals.sections; groupStart += config.groupSections) {
      const groupEnd = Math.min(totals.sections, groupStart + config.groupSections);
      groups += 1;
      const groupStarted = performance.now();

      for (let s = groupStart; s < groupEnd; s += 1) {
        const count = cellsInSection(s, totals.cells);
        const observations = new Array(count);
        for (let j = 0; j < count; j += 1) {
          const i = s * SECTION_CELLS + j;
          observations[j] = makeObservation(s, j, STONE, BASE_OBSERVED_AT + i, i + 1);
        }
        session.voxel.observeBatch({ observations, unobserved: [] });
        observationsWritten += count;
        observeResidency(session);
      }

      // Commit bounded dirty batches until this group is fully confirmed.
      let guard = 0;
      while (session.getPersistenceState().dirty) {
        await checkpointOnce(session);
        guard += 1;
        if (guard > groupEnd - groupStart + 4) {
          throw new Error(`dirty batch made no progress after ${guard} checkpoints in group starting at ${groupStart}`);
        }
      }

      const keys = [];
      for (let s = groupStart; s < groupEnd; s += 1) keys.push(sectionKey(s));
      const unloaded = session.unloadSections(keys);
      assert(unloaded.rejected.length === 0, `group ${groups}: unload rejected ${JSON.stringify(unloaded.rejected)}`);
      assert(unloaded.unloaded.length === keys.length, `group ${groups}: not all sections unloaded`);
      assert(session.voxel.residentSize().sections === 0, `group ${groups}: resident sections remain after unload`);
      assert(session.voxel.residentSize().bytes === 0, `group ${groups}: resident bytes remain after unload`);

      const elapsed = performance.now() - writeStarted;
      const rssMb = mb(process.memoryUsage().rss);
      console.error(
        `[b7] group ${groups} sections ${groupStart}-${groupEnd - 1} ` +
          `cells=${observationsWritten} elapsed=${(elapsed / 1000).toFixed(1)}s rss=${rssMb}MiB ` +
          `residentPeak=${mb(report.residency.maxObservedBytes)}MiB checkpoints=${report.checkpoints.count}`,
      );
      void groupStarted;
    }
    endPhase();
    report.phases.writeAndSaveMs = Number((performance.now() - writeStarted).toFixed(1));
    report.counts.observationsWritten = observationsWritten;
    report.counts.groups = groups;
    assert(observationsWritten === totals.cells, `wrote ${observationsWritten} observations, expected ${totals.cells}`);

    const dirtyState = session.getPersistenceState();
    const fullCounts = session.voxel.checkpointFullCounts();
    assert(dirtyState.dirty === false, 'session still dirty after all groups were checkpointed');
    assert(session.voxel.hasPendingChanges() === false, 'voxel still has pending changes after all groups');
    assert(fullCounts.sections === totals.sections, `full map has ${fullCounts.sections} Sections, expected ${totals.sections}`);
    assert(fullCounts.observedCells === totals.cells, `full map has ${fullCounts.observedCells} cells, expected ${totals.cells}`);
    report.counts.fullBeforeClose = fullCounts;
    report.counts.voxelRevisionBeforeClose = dirtyState.voxelRevision;
    report.counts.confirmedVoxelRevisionBeforeClose = dirtyState.confirmedVoxelRevision;
    report.database.sizeAfterSaveBytes = dbSizeBytes(dbInfo.dbPath);

    const firstClose = await session.close();
    session = null;
    report.counts.firstClose = summarizeClose(firstClose);
    assert(firstClose.completed === true, 'first close did not complete cleanly');
    assert(firstClose.dirty === false, 'first close reported dirty memory');
    assert(firstClose.unconfirmedRequest === false, 'first close reported an unconfirmed request');
    report.database.filesAfterSave = dbFileSizes(dbInfo.dbPath);

    // ------------------------------------------------------------------
    // Phase B: cold reopen (manual), load earliest + latest, verify facts.
    // ------------------------------------------------------------------
    beginPhase('reopenVerify');
    const reopenStarted = performance.now();
    session = await openSpatialSession(options);
    session.voxel.beginSession(WRITE_SESSION_2);

    const earliestKey = sectionKey(0);
    const lastKey = sectionKey(totals.lastSection);
    const directoryResidency = session.voxel.sectionResidency(earliestKey);
    assert(
      directoryResidency.residency === 'not_resident',
      `earliest Section should be non-resident after manual open, got ${directoryResidency.residency}`,
    );
    assert(directoryResidency.committed !== undefined, 'earliest Section is not in the committed directory');

    const loaded = await session.loadSections([earliestKey, lastKey]);
    assert(loaded.missing.length === 0, `loadSections missed ${JSON.stringify(loaded.missing)}`);
    assert(loaded.loaded.length === 2, `loadSections loaded ${loaded.loaded.length} Sections, expected 2`);
    const restoredEarliest = assertCell(
      session,
      cellPosition(0, 0),
      { state: 'minecraft:stone', properties: {}, observedAt: BASE_OBSERVED_AT },
      'reopen-earliest',
    );
    const lastPos = cellPosition(totals.lastSection, totals.lastSectionCells - 1);
    const restoredLast = assertCell(
      session,
      lastPos,
      {
        state: 'minecraft:stone',
        properties: {},
        observedAt: BASE_OBSERVED_AT + totals.cells - 1,
      },
      'reopen-last',
    );
    const reopenedCounts = session.voxel.checkpointFullCounts();
    assert(reopenedCounts.sections === totals.sections, `reopened full map has ${reopenedCounts.sections} Sections`);
    assert(reopenedCounts.observedCells === totals.cells, `reopened full map has ${reopenedCounts.observedCells} cells`);
    report.counts.reopenedFull = reopenedCounts;
    report.assertions.reopen = { earliest: restoredEarliest, latest: restoredLast };
    endPhase();
    report.phases.reopenVerifyMs = Number((performance.now() - reopenStarted).toFixed(1));

    // ------------------------------------------------------------------
    // Phase C: one incremental write + bounded save on the reopened session.
    // ------------------------------------------------------------------
    beginPhase('incrementalSave');
    const incrementalStarted = performance.now();
    const incrementalObservedAt = BASE_OBSERVED_AT + totals.cells + 1_000_000;
    const incrementalSequence = totals.cells + 1_000_000;
    const targetPos = cellPosition(0, 0);
    const beforeIncremental = session.getPersistenceState();
    session.voxel.observe({
      ...makeObservation(0, 0, DIRT, incrementalObservedAt, incrementalSequence),
      sessionId: WRITE_SESSION_2,
    });
    assert(session.getPersistenceState().dirty === true, 'incremental observation did not dirty the session');
    const incrementalCheckpoint = await checkpointOnce(session);
    const afterIncremental = session.getPersistenceState();
    assert(afterIncremental.dirty === false, 'incremental checkpoint did not confirm the change');
    assert(
      incrementalCheckpoint.voxelRevision > beforeIncremental.confirmedVoxelRevision,
      'incremental checkpoint advanced no voxel revision',
    );
    const liveAfterIncremental = session.voxel.cellAt(DIM, targetPos.x, targetPos.y, targetPos.z);
    assert(liveAfterIncremental.observed === true, 'incrementally written cell is not observed');
    assert(
      liveAfterIncremental.evidence.observation.state.name === 'minecraft:dirt',
      'incrementally written cell did not change state',
    );
    report.assertions.incremental = {
      position: targetPos,
      previousObservedAt: restoredEarliest.observedAt,
      newObservedAt: liveAfterIncremental.evidence.observation.observedAt,
      freshness: liveAfterIncremental.evidence.freshness,
      checkpointVoxelRevision: incrementalCheckpoint.voxelRevision,
    };
    const incrementalClose = await session.close();
    session = null;
    report.counts.incrementalClose = summarizeClose(incrementalClose);
    assert(incrementalClose.completed === true, 'incremental close did not complete cleanly');
    assert(incrementalClose.dirty === false, 'incremental close reported dirty memory');
    report.database.sizeAfterIncrementalBytes = dbSizeBytes(dbInfo.dbPath);
    endPhase();
    report.phases.incrementalSaveMs = Number((performance.now() - incrementalStarted).toFixed(1));

    // ------------------------------------------------------------------
    // Phase D: restart and verify the incremental write plus older cells.
    // ------------------------------------------------------------------
    beginPhase('restartVerify');
    const restartStarted = performance.now();
    session = await openSpatialSession(options);
    const restartLoaded = await session.loadSections([earliestKey, lastKey]);
    assert(restartLoaded.missing.length === 0, `restart loadSections missed ${JSON.stringify(restartLoaded.missing)}`);
    const restartedIncremental = assertCell(
      session,
      targetPos,
      { state: 'minecraft:dirt', properties: {}, observedAt: incrementalObservedAt },
      'restart-incremental-cell',
    );
    const restartedOlder = assertCell(
      session,
      cellPosition(0, 1),
      { state: 'minecraft:stone', properties: {}, observedAt: BASE_OBSERVED_AT + 1 },
      'restart-older-cell',
    );
    const restartedLast = assertCell(
      session,
      lastPos,
      {
        state: 'minecraft:stone',
        properties: {},
        observedAt: BASE_OBSERVED_AT + totals.cells - 1,
      },
      'restart-last-cell',
    );
    report.assertions.restart = {
      incremental: restartedIncremental,
      older: restartedOlder,
      last: restartedLast,
    };
    const finalClose = await session.close();
    session = null;
    report.counts.finalClose = summarizeClose(finalClose);
    assert(finalClose.completed === true, 'final close did not complete cleanly');
    assert(finalClose.dirty === false, 'final close reported dirty memory');
    endPhase();
    report.phases.restartVerifyMs = Number((performance.now() - restartStarted).toFixed(1));

    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    report.failedPhase = phase;
    endPhase();
  } finally {
    if (session !== null) {
      try {
        report.counts.errorClose = summarizeClose(await session.close());
      } catch (closeError) {
        report.closeError = closeError instanceof Error ? closeError.message : String(closeError);
      }
      session = null;
    }
    report.memory = sampler.stop();
    report.database.sizeBytes = dbSizeBytes(dbInfo.dbPath);
    report.database.files = dbFileSizes(dbInfo.dbPath);
    try {
      report.database.committed = readCommittedFacts(dbInfo.dbPath);
    } catch (readError) {
      report.database.committed = null;
      report.database.readError = readError instanceof Error ? readError.message : String(readError);
    }
    report.checkpoints.totalMs = Number(report.checkpoints.totalMs.toFixed(1));
    report.checkpoints.maxMs = Number(report.checkpoints.maxMs.toFixed(1));
    const removable = report.ok && !config.keepDb && dbInfo.createdDir;
    if (removable) {
      try {
        fs.rmSync(dbInfo.dir, { recursive: true, force: true });
      } catch (removeError) {
        report.database.removeError = removeError instanceof Error ? removeError.message : String(removeError);
      }
    }
    report.database.retained = !removable;
    report.database.path = removable ? null : dbInfo.dbPath;
  }
  return report;
}

const config = parseArgs(process.argv.slice(2));
const report = await run(config);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
