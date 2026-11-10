/**
 * Dense-section observation probe for the v0.11.0 upgrade plan.
 * Build current sources first: npm run build
 * Run: node benchmarks/observation-ingest.bench.mjs
 *
 * No database or game. Setup is excluded. Each timed round applies 256
 * observations in one resident Section: same-cell refresh, multiple-cell refresh,
 * or actual state changes. Values are round durations, not individual-call
 * percentiles or measurements of a real host's event-loop delay.
 */
import { performance } from 'node:perf_hooks';
import { VoxelMap } from '../dist/voxel/voxel-map.js';

const SIZES = [128, 512, 2048, 4096];
const UPDATES = 256;
const ROUNDS = 5;
const WORLD = 'observation-ingest-probe';
const WORKLOADS = ['same-cell-refresh', 'multi-cell-refresh', 'multi-cell-state-change'];

function observation(index, time) {
  return {
    worldId: WORLD,
    dim: 'overworld',
    sessionId: 'probe-session',
    pos: { x: index % 16, y: 64 + Math.floor(index / 256), z: Math.floor(index / 16) % 16 },
    state: { name: 'minecraft:stone', properties: {} },
    stateComplete: true,
    evidence: 'seen',
    source: 'vision',
    observedAt: time,
    sequence: time,
  };
}

function probe(cells, manualResidency, delivery, workload) {
  const map = new VoxelMap(WORLD, { manualResidency });
  if (manualResidency) map.installDirectory([]);
  map.observeBatch({ observations: Array.from({ length: cells }, (_, i) => observation(i, i + 1)), unobserved: [] });
  let time = cells + 1;
  let round = 0;
  const run = () => {
    // Build input outside the measured region. Change rounds alternate two real
    // block states, so each cell's first update in a round changes stored content.
    round += 1;
    const observations = Array.from({ length: UPDATES }, (_, index) => {
      const value = observation(workload === 'same-cell-refresh' ? 0 : index % cells, time++);
      if (workload === 'multi-cell-state-change' && round % 2 === 1) {
        value.state = { name: 'minecraft:dirt', properties: {} };
      }
      return value;
    });
    const start = performance.now();
    if (delivery === 'batch') {
      map.observeBatch({ observations, unobserved: [] });
    } else {
      observations.forEach((value) => map.observe(value));
    }
    return performance.now() - start;
  };
  run();
  run();
  const elapsed = Array.from({ length: ROUNDS }, run).sort((a, b) => a - b);
  if (map.checkpointCounts().observedCells !== cells) {
    throw new Error('probe unexpectedly changed the distinct observed-cell count');
  }
  const median = elapsed[Math.floor(elapsed.length / 2)];
  return {
    workload,
    cells,
    mode: manualResidency ? 'manual' : 'eager',
    delivery,
    medianRoundMs: Number(median.toFixed(3)),
    maxRoundMs: Number(elapsed[elapsed.length - 1].toFixed(3)),
    medianMsPerObservation: Number((median / UPDATES).toFixed(5)),
  };
}

const rows = WORKLOADS.flatMap((workload) => SIZES.flatMap((cells) =>
  [false, true].flatMap((manual) => ['single', 'batch'].map((delivery) => probe(cells, manual, delivery, workload))),
),
);
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  workloads: WORKLOADS,
  updatesPerRound: UPDATES,
  warmupRounds: 2,
  measuredRounds: ROUNDS,
  rows,
}, null, 2));
