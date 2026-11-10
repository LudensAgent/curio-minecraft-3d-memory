/**
 * Deterministic fixtures shared by the voxel + facts benchmarks. Not a test suite.
 *
 * Nothing reads `Date.now()`, `Math.random()`, a real server, or mineflayer.
 * Scale counts are returned as data so each benchmark reports the size it
 * actually built.
 */

import { writeSync } from 'node:fs';
import { InMemoryFactStore, VoxelMap } from '../src/index.js';
import type { Observation } from '../src/index.js';

export const WORLD = 'bench-world';
export const DIM = 'overworld';
export const SESSION = 'bench-session';
/** Fixed clock for evidence times. */
export const NOW = 100_000;

const STONE_STATE = { name: 'bench:stone', properties: {} };

/** One observed cell, stamped at `NOW` with a caller-controlled sequence. */
function cellObservation(
  state: { name: string; properties: Record<string, string> },
  x: number,
  y: number,
  z: number,
  sequence: number,
): Observation {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    observedAt: NOW,
    sequence,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state,
    pos: { x, y, z },
  };
}

/**
 * One Section-occupied cell per Section in a wide grid. Cost is one observation
 * per Section, not 4096.
 */
export function buildSparseSections(sections: number, sectionsPerRow = 100): {
  map: VoxelMap;
  observations: Observation[];
  plan: { sections: number; observations: number; sectionsPerRow: number };
} {
  const map = new VoxelMap(WORLD, { now: () => NOW });
  map.beginSession(SESSION);
  const observations: Observation[] = [];
  for (let i = 0; i < sections; i++) {
    const cx = i % sectionsPerRow;
    const cz = 100 + Math.floor(i / sectionsPerRow);
    const observation = cellObservation(STONE_STATE, cx * 16, -1, cz * 16, i);
    observations.push(observation);
    map.observe(observation);
  }
  return {
    map,
    observations,
    plan: { sections: map.residentSectionKeys().length, observations: observations.length, sectionsPerRow },
  };
}

/**
 * Deterministic places, resource anchors and container anchors in one in-memory
 * facts store. Ids sort in insertion order and every coordinate is unique.
 */
export function buildFacts(count: number): {
  store: InMemoryFactStore;
  plan: { places: number; resources: number; containers: number };
} {
  const store = new InMemoryFactStore();
  for (let i = 0; i < count; i++) {
    const id = String(i).padStart(6, '0');
    store.upsertPlace({
      id: `bench:place:${id}`,
      kind: 'place',
      label: `place ${id}`,
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { x: i, y: 64, z: 0 } },
      observedAt: NOW,
      source: { source: 'agent' },
      gone: false,
    });
    store.upsertResource({
      id: `bench:resource:${id}`,
      worldId: WORLD,
      dim: DIM,
      label: 'bench:stone',
      sourceCell: { x: i, y: 0, z: 64 },
      observedAt: NOW,
      source: { source: 'vision' },
      revoked: false,
    });
    store.upsertContainer({
      id: `bench:container:${id}`,
      worldId: WORLD,
      dim: DIM,
      pos: { x: i, y: 64, z: 64 },
      externalRef: `bench:chest:${id}`,
      observedAt: NOW,
      source: { source: 'vision' },
      gone: false,
    });
  }
  return { store, plan: { places: count, resources: count, containers: count } };
}

// ---------------------------------------------------------------------------
// Wall-clock + memory harness
// ---------------------------------------------------------------------------

/** Peak `memoryUsage()` sampled during one function call (process-wide). */
export interface MemoryPeak {
  rssPeakBytes: number;
  heapUsedPeakBytes: number;
}

export interface Stats {
  medianMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  rounds: number;
}

export interface BenchResult {
  name: string;
  /** Rows that make up the recorded data set (scale evidence, never decoration). */
  rows: Record<string, string | number>;
  stats: Stats;
  memory: MemoryPeak;
}

export const RUNS = 5;
const SLOW_ROUND_MS = 60_000;

function roundMs(rounds: number[]): Stats {
  const sorted = [...rounds].sort((a, b) => a - b);
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
  return {
    medianMs: Number(pick(0.5).toFixed(3)),
    minMs: Number(sorted[0]!.toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(3)),
    p95Ms: Number(pick(0.95).toFixed(3)),
    rounds: sorted.length,
  };
}

function sampleMemory(): MemoryPeak {
  const usage = process.memoryUsage();
  return { rssPeakBytes: usage.rss, heapUsedPeakBytes: usage.heapUsed };
}

async function measure<T>(run: () => T | Promise<T>): Promise<{ elapsedMs: number; memory: MemoryPeak; value: T }> {
  let peak = sampleMemory();
  const timer = setInterval(() => {
    const now = sampleMemory();
    if (now.rssPeakBytes > peak.rssPeakBytes) peak = { ...peak, rssPeakBytes: now.rssPeakBytes };
    if (now.heapUsedPeakBytes > peak.heapUsedPeakBytes) peak = { ...peak, heapUsedPeakBytes: now.heapUsedPeakBytes };
  }, 5);
  timer.unref();
  const started = process.hrtime.bigint();
  try {
    const value = await run();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const after = sampleMemory();
    peak = {
      rssPeakBytes: Math.max(peak.rssPeakBytes, after.rssPeakBytes),
      heapUsedPeakBytes: Math.max(peak.heapUsedPeakBytes, after.heapUsedPeakBytes),
    };
    return { elapsedMs, memory: peak, value };
  } finally {
    clearInterval(timer);
  }
}

export async function benchmark<T>(
  name: string,
  rows: Record<string, string | number>,
  run: () => T | Promise<T>,
  runs = RUNS,
): Promise<BenchResult> {
  await run(); // warm-up
  const elapsed: number[] = [];
  let memory = sampleMemory();
  for (let i = 0; i < runs; i++) {
    const round = await measure(run);
    elapsed.push(round.elapsedMs);
    if (round.memory.rssPeakBytes > memory.rssPeakBytes) memory.rssPeakBytes = round.memory.rssPeakBytes;
    if (round.memory.heapUsedPeakBytes > memory.heapUsedPeakBytes) memory.heapUsedPeakBytes = round.memory.heapUsedPeakBytes;
    if (round.elapsedMs > SLOW_ROUND_MS) {
      process.stderr.write(`warning: ${name} round ${i + 1} took ${round.elapsedMs.toFixed(0)} ms (> ${SLOW_ROUND_MS} ms)\n`);
    }
  }
  return { name, rows, stats: roundMs(elapsed), memory };
}

/** Build and time a fixture constructor once. */
export async function build<T>(name: string, rows: Record<string, string | number>, make: () => T | Promise<T>): Promise<{
  value: T;
  setup: BenchResult;
}> {
  const round = await measure(make);
  return {
    value: round.value,
    setup: { name, rows, stats: roundMs([round.elapsedMs]), memory: round.memory },
  };
}

/** Prepare → time → clean up, once per round; prepare/cleanup are unmeasured. */
export async function benchmarkStaged<T>(
  name: string,
  rows: Record<string, string | number>,
  prepare: () => T | Promise<T>,
  run: (prepared: T) => void | Promise<void>,
  cleanup: (prepared: T) => void | Promise<void>,
  runs = RUNS,
): Promise<BenchResult> {
  const warm = await prepare();
  await run(warm);
  await cleanup(warm);

  const elapsed: number[] = [];
  let memory = sampleMemory();
  for (let i = 0; i < runs; i++) {
    const prepared = await prepare();
    try {
      const round = await measure(() => run(prepared));
      elapsed.push(round.elapsedMs);
      if (round.memory.rssPeakBytes > memory.rssPeakBytes) memory.rssPeakBytes = round.memory.rssPeakBytes;
      if (round.memory.heapUsedPeakBytes > memory.heapUsedPeakBytes) memory.heapUsedPeakBytes = round.memory.heapUsedPeakBytes;
    } finally {
      await cleanup(prepared);
    }
  }
  return { name, rows, stats: roundMs(elapsed), memory };
}

function mib(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

/** One benchmark file's report: markdown table rows built from measured data. */
export class Report {
  private readonly title: string;
  private readonly scope: string;
  private readonly results: BenchResult[] = [];

  constructor(title: string, scope: string) {
    this.title = title;
    this.scope = scope;
  }

  add(result: BenchResult): void {
    this.results.push(result);
  }

  /** Print the markdown report synchronously so `| head` never truncates it. */
  flush(): void {
    const lines = [`# ${this.title}`, '', this.scope, '', '| scenario | scale | median ms | min ms | p95 ms | RSS peak MiB | heapUsed peak MiB |', '|---|---|---:|---:|---:|---:|---:|'];
    for (const result of this.results) {
      const scale = Object.entries(result.rows)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      lines.push(
        `| ${result.name} | ${scale} | ${result.stats.medianMs} | ${result.stats.minMs} | ${result.stats.p95Ms} | ${mib(result.memory.rssPeakBytes)} | ${mib(result.memory.heapUsedPeakBytes)} |`,
      );
    }
    lines.push('');
    writeSync(1, `${lines.join('\n')}\n`);
  }
}
