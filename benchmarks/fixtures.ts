/**
 * Deterministic, seeded fixtures shared by the M8.1 benchmarks. Not a test suite.
 *
 * Every generator is a pure function of its scale arguments plus a single
 * `mulberry32(seed)` stream, so two runs in the same environment build the same
 * data: same ids, same coordinates, same insertion order. Nothing reads
 * `Date.now()`, `Math.random()`, a real server, or mineflayer.
 *
 * The scale counts are returned as data (`plan`/`actual`) so each benchmark
 * reports the size it actually built instead of asserting one.
 */

import { writeSync } from 'node:fs';
import { FragmentStore, serializeBlockState, TopologyStore, VoxelMap } from '../src/index.js';
import type {
  BodyContext,
  BodySample,
  CollisionShape,
  CollisionShapeProvider,
  Observation,
  PathFragment,
  SpatialNode,
  TopologyCheckpointSnapshot,
  TraversalEvidence,
  Vec3Like,
} from '../src/index.js';

export const WORLD = 'bench-world';
export const DIM = 'overworld';
export const SESSION = 'bench-session';
/** Fixed clock for evidence times; all fixture observations are FRESH relative to NOW. */
export const NOW = 100_000;

/** Small, fast PRNG; returns [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fake collision rules — NOT Minecraft 1.20.1 collision rules. `bench:air`
 * blocks nothing; `bench:stone` is a full cube with a full top face. An
 * unknown name resolves to an explicit `unsupported_shape`, never a guess.
 */
const EMPTY_SHAPE: CollisionShape = { boxes: [], supportFaces: [] };
const FULL_CUBE: CollisionShape = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};

export const benchShapeProvider: CollisionShapeProvider = {
  version: 'bench-fake-1',
  resolve(state) {
    if (state.name === 'bench:air') return { kind: 'shape', shape: EMPTY_SHAPE };
    if (state.name === 'bench:stone') return { kind: 'shape', shape: FULL_CUBE };
    return { kind: 'unsupported_shape', block: serializeBlockState(state), detail: 'bench fixture has no shape rule' };
  },
};

const AIR_STATE = { name: 'bench:air', properties: {} };
const STONE_STATE = { name: 'bench:stone', properties: {} };

export function bodyAt(x: number, y: number, z: number): BodyContext {
  return { feet: { x, y, z }, width: 0.6, height: 1.8, pose: 'standing' };
}

/** Deterministic measured body sample for planning/execution loops. */
export function sampleAt(
  pos: Vec3Like,
  executionId: string,
  sequence: number,
  observedAt = NOW,
): BodySample {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    executionId,
    sequence,
    pos: { ...pos },
    observedAt,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
  };
}

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

// ---------------------------------------------------------------------------
// Voxel map fixtures
// ---------------------------------------------------------------------------

/**
 * One Section-occupied cell per Section, in a `sectionsPerRow`-wide grid far
 * from the local corridor. Cost is one observation per Section, not 4096.
 * `sections` is a requested ceiling; the returned plan reports the live count.
 */
export function buildSparseSections(sections: number, sectionsPerRow = 100): {
  map: VoxelMap;
  observations: Observation[];
  plan: { sections: number; observations: number; sectionsPerRow: number };
} {
  const map = new VoxelMap(WORLD, { now: () => NOW });
  map.beginSession(SESSION);
  const observations: Observation[] = [];
  // `cx`/`cz` are Section indices; block coordinates are cx*16 / cz*16. The
  // grid starts at Section cz = 100 (block z = 1600), far from the corridor at
  // z = 0, so the two fixtures never observe the same cell.
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

/** A standable same-height corridor along +X: stone at y = -1, air at y = 0/1. */
export function observeCorridor(map: VoxelMap, length: number, sequenceStart = 0): number {
  let sequence = sequenceStart;
  for (let x = 0; x < length; x++) {
    map.observe(cellObservation(STONE_STATE, x, -1, 0, sequence++));
    map.observe(cellObservation(AIR_STATE, x, 0, 0, sequence++));
    map.observe(cellObservation(AIR_STATE, x, 1, 0, sequence++));
  }
  return sequence;
}

/** Continuous feet points along the corridor at z = 0.5. */
export function corridorPoints(length: number): Vec3Like[] {
  return Array.from({ length }, (_, x) => ({ x: x + 0.5, y: 0, z: 0.5 }));
}

interface CorridorPlan {
  points: number;
  floorCells: number;
  /** Sections the corridor actually created (feet + support rows). */
  sections: number;
}

/** A fresh map containing only the corridor. */
export function buildCorridorMap(length: number): { map: VoxelMap; plan: CorridorPlan } {
  const map = new VoxelMap(WORLD, { now: () => NOW });
  map.beginSession(SESSION);
  observeCorridor(map, length);
  return {
    map,
    plan: { points: length, floorCells: length, sections: map.residentSectionKeys().length },
  };
}

// ---------------------------------------------------------------------------
// History fixtures: fragments + traversal evidence
// ---------------------------------------------------------------------------

/**
 * `count` deterministic two-point fragments laid out on a 4-block lattice at
 * y = 64. Each fragment owns one short polyline and no cross-fragment links.
 */
export function buildFragments(history: FragmentStore, count: number): { fragments: number; points: number } {
  for (let i = 0; i < count; i++) {
    const x = (i % 1000) * 4 + 0.5;
    const z = Math.floor(i / 1000) * 4 + 0.5;
    const fragment: PathFragment = {
      id: `bench:fragment:${String(i).padStart(4, '0')}`,
      worldId: WORLD,
      dim: DIM,
      kind: 'walked',
      entrances: [{ x, y: 64, z }],
      polyline: [
        { x, y: 64, z },
        { x: x + 1, y: 64, z },
      ],
      geometrySource: 'traversal',
      deepestY: 64,
      createdAt: 1000,
      lastUsedAt: 1000,
      uses: 1,
    };
    history.saveFragment(fragment);
  }
  return { fragments: count, points: count * 2 };
}

/** Stable fragment id used for traversals, spread across the `fragmentCount` fragments. */
function fragmentIdFor(index: number, fragmentCount: number): string {
  return `bench:fragment:${String(index % fragmentCount).padStart(4, '0')}`;
}

/**
 * A straight 1024-point historical fragment at feet y = 0, z = 0.5 (x + 0.5),
 * owned by the history store. `history` must be empty or already contain it
 * idempotently.
 */
export function buildStraightFragment(history: FragmentStore, points: number): { fragmentId: string; points: number } {
  const id = 'bench:fragment:straight';
  history.saveFragment({
    id,
    worldId: WORLD,
    dim: DIM,
    kind: 'walked',
    entrances: [{ x: 0.5, y: 0, z: 0.5 }],
    polyline: corridorPoints(points),
    geometrySource: 'traversal',
    deepestY: 0,
    createdAt: 1000,
    lastUsedAt: 1000,
    uses: 1,
  });
  return { fragmentId: id, points };
}

/**
 * `count` deterministic traversal records, spread across `fragmentCount`
 * fragments. Each record is one unit-length hop at a seeded position, so the
 * history has many distinct links; the returned `components`/`points` rows
 * report the connectivity the union-find actually found.
 */
export function buildTraversalLinks(
  history: FragmentStore,
  count: number,
  fragmentCount: number,
  seed = 4242,
): { traversals: number; fragments: number } {
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const from = { x: Math.floor(rng() * 10_000) + 0.5, y: 64, z: 0.5 };
    const to = { x: from.x + 1, y: 64, z: 0.5 };
    history.addTraversal({
      id: `bench:traversal:${String(i).padStart(5, '0')}`,
      fragmentId: fragmentIdFor(i, fragmentCount),
      from,
      to,
      worldId: WORLD,
      dim: DIM,
      sessionId: SESSION,
      observedAt: NOW - 1000,
      source: 'confirmed_walk',
      mode: 'walk',
    });
  }
  return { traversals: count, fragments: fragmentCount };
}

// ---------------------------------------------------------------------------
// Topology fixtures: nodes + evidence-backed edges
// ---------------------------------------------------------------------------

export interface TopologyPlan {
  nodes: number;
  edges: number;
  /** Nodes on one straight y = 0 spine (integer x, z = 0), used as route landmarks. */
  spineNodes: number;
  fragments: number;
}

export function topologyPlan(nodes: number, edges: number, spineNodes: number, fragments: number): TopologyPlan {
  return { nodes, edges, spineNodes, fragments };
}

function spineNodeId(index: number): string {
  return `bench:node:spine:${String(index).padStart(5, '0')}`;
}

function treeNodeId(index: number): string {
  return `bench:node:tree:${String(index).padStart(5, '0')}`;
}

/** Integer location of spine node `index` (continuous feet are x + 0.5, unused here). */
function spinePos(index: number): Vec3Like {
  return { x: index, y: 0, z: 0 };
}

/** Deterministic tree-node position: unique across indices, at y = -2. */
function treeNodePos(index: number): Vec3Like {
  return { x: (index % 512) * 2, y: -2, z: Math.floor(index / 512) * 2 };
}

function nodeSourceFor(index: number, nodes: number): 'program' | 'agent' {
  // Program and agent node quotas are independent (10 000 each by default).
  // Split by insertion index so neither quota is ever evicted: an evicted node
  // would leave later edges pointing at a missing id.
  return index < Math.floor(nodes / 2) ? 'program' : 'agent';
}

/**
 * Write `plan.nodes` nodes, `plan.edges` traversal-evidence-backed edges and
 * the traversals they cite. The `history` store must already hold the
 * `plan.fragments` fragments the traversals reference.
 *
 * Every edge is `basis: 'traversed'` with exactly one real traversal whose
 * endpoints equal the two endpoint node locations. Tree node `i > 0` connects
 * to a seeded earlier tree node; leftover edge capacity fills the straight
 * spine (spine i → spine i + 1). All coordinates are distinct, so repeated
 * builds produce identical stores.
 */
function buildTopology(
  history: FragmentStore,
  topology: TopologyStore,
  plan: TopologyPlan,
  seed = 1281,
): { nodes: number; edges: number; traversals: number } {
  if (plan.spineNodes > plan.nodes) throw new Error('spineNodes cannot exceed nodes');
  if (plan.fragments < 1) throw new Error('fragments must be at least 1');
  const rng = mulberry32(seed);
  let traversalCount = 0;

  const addEdge = (from: string, fromPos: Vec3Like, to: string, toPos: Vec3Like): void => {
    const evidenceId = `bench:traversal:${String(traversalCount).padStart(5, '0')}`;
    const evidence: TraversalEvidence = {
      id: evidenceId,
      fragmentId: fragmentIdFor(traversalCount, plan.fragments),
      from: { ...fromPos },
      to: { ...toPos },
      worldId: WORLD,
      dim: DIM,
      sessionId: SESSION,
      observedAt: NOW - 1000,
      source: 'confirmed_walk',
      mode: 'walk',
    };
    history.addTraversal(evidence);
    topology.saveEdge({
      id: `bench:edge:${String(traversalCount).padStart(5, '0')}`,
      from,
      to,
      type: fromPos.y === toPos.y ? 'HORIZONTAL' : 'STAIRCASE',
      basis: 'traversed',
      evidenceIds: [evidenceId],
    });
    traversalCount += 1;
  };

  const saveNode = (index: number, pos: Vec3Like): void => {
    const node: SpatialNode = {
      id: index < plan.spineNodes ? spineNodeId(index) : treeNodeId(index - plan.spineNodes),
      kind: 'place',
      source: nodeSourceFor(index, plan.nodes),
      worldId: WORLD,
      dim: DIM,
      location: { kind: 'exact', pos: { ...pos } },
    };
    topology.saveNode(node);
  };

  // Nodes first: edges reference existing node ids, and node capacity is
  // independent of edge capacity.
  for (let i = 0; i < plan.nodes; i++) {
    saveNode(i, i < plan.spineNodes ? spinePos(i) : treeNodePos(i - plan.spineNodes));
  }

  // Tree edges: each non-spine tree node i connects to a seeded earlier node.
  const treeCount = plan.nodes - plan.spineNodes;
  for (let i = 0; i < treeCount && traversalCount < plan.edges; i++) {
    const parent = i === 0 ? null : Math.floor(rng() * i);
    if (parent === null) continue;
    addEdge(
      treeNodeId(parent),
      treeNodePos(parent),
      treeNodeId(i),
      treeNodePos(i),
    );
  }
  // Remaining capacity: straight spine row.
  for (let i = 0; traversalCount < plan.edges && i < plan.spineNodes - 1; i++) {
    addEdge(spineNodeId(i), spinePos(i), spineNodeId(i + 1), spinePos(i + 1));
  }
  // Still short: extra evidence-backed edges between already-recorded tree
  // nodes. They reuse node positions but carry their own traversal id, so the
  // graph is bigger without inventing nodes or unbacked edges.
  for (let i = 0; traversalCount < plan.edges && treeCount > 1; i = (i + 1) % (treeCount - 1)) {
    addEdge(treeNodeId(i), treeNodePos(i), treeNodeId(i + 1), treeNodePos(i + 1));
  }

  const snapshot = topology.checkpointSnapshot();
  return { nodes: snapshot.nodes.length, edges: snapshot.edges.length, traversals: traversalCount };
}

/**
 * The shared 20k-scale topology fixture: fragments, nodes, edges and the
 * traversal evidence they cite, plus the checkpoint snapshots a persistence
 * session can restore. `buildTopology`'s cap is `maxTraversals`; the caller
 * must construct the `FragmentStore` with that cap (default is 10 000).
 */
export interface TopologyFixture {
  history: FragmentStore;
  topology: TopologyStore;
  written: { nodes: number; edges: number; traversals: number };
  fragments: PathFragment[];
  traversals: TraversalEvidence[];
  topologySnapshot: TopologyCheckpointSnapshot;
  /** The topology store's conservative pre-flight byte estimate. */
  measureBytes: number;
}

export function buildTopologyFixture(plan: TopologyPlan, seed = 1281): TopologyFixture {
  const history = new FragmentStore(WORLD, { maxTraversals: plan.edges });
  const topology = new TopologyStore(history, { now: () => NOW });
  buildFragments(history, plan.fragments);
  const written = buildTopology(history, topology, plan, seed);
  if (written.nodes !== plan.nodes || written.edges !== plan.edges) {
    throw new Error(`topology fixture wrote ${written.nodes} nodes / ${written.edges} edges, expected ${plan.nodes}/${plan.edges}`);
  }
  const historySnapshot = history.checkpointSnapshot();
  return {
    history,
    topology,
    written,
    fragments: historySnapshot.fragments,
    traversals: historySnapshot.traversals,
    topologySnapshot: topology.checkpointSnapshot(),
    measureBytes: topology.checkpointMeasure().bytes,
  };
}

// ---------------------------------------------------------------------------
// Wall-clock + memory harness (moved here because M8.1 only allows the
// benchmark scripts plus this shared fixtures file)
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
/** Wall time of one round beyond which the harness warns the scale is too big for a quick baseline. */
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

/** Run one round and return its wall time plus the peak memory sampled during it. */
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

/**
 * Time one named scenario: 1 warm-up round (result discarded) then `runs`
 * recorded rounds. `run` must be side-effect free across rounds or return to
 * the same starting state, so recorded rounds measure the same work.
 */
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

/**
 * Build and time a fixture constructor once. Returns the built value plus the
 * construction cost so the setup cost is visible, never hidden in the reported
 * operation time. Memory sampled during construction is reported as `setup`.
 */
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

/**
 * Prepare → time → clean up, once per round. `prepare` runs **outside** the
 * measured window (e.g. opening a session and populating it); `run` is the
 * measured operation; `cleanup` always runs after the round, measured or not.
 */
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
