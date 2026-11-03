/**
 * Runnable Fake example for the controlled walk-route execution loop.
 *
 * Demonstrates the full closed loop on an in-memory map and a Fake executor:
 *   submit observations → verify → single-step execute → mid-route invalidation
 *   → stop + structured feedback.
 *
 * Run with: `npx tsx examples/walk-route-execution.ts`
 */

import { VoxelMap, WalkRouteExecutor } from '../src/index.js';
import type {
  BodySample,
  CollisionShapeProvider,
  ExecutableMove,
  ExecutableMoveResult,
  MoveExecutor,
  Observation,
  Vec3Like,
  WalkRouteRequest,
} from '../src/index.js';

const SCOPE = { worldId: 'world', dim: 'overworld', sessionId: 's1' };

// --- Minimal Fake collision rules (not Minecraft 1.20.1). ---
const EMPTY = { boxes: [], supportFaces: [] };
const FULL = {
  boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
  supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
};
const provider: CollisionShapeProvider = {
  version: 'example-1',
  resolve(state) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: EMPTY };
    if (state.name === 'minecraft:stone') return { kind: 'shape', shape: FULL };
    return { kind: 'unsupported_shape', block: state.name, detail: `no example rule for ${state.name}` };
  },
};

function obs(state: { name: string; properties: Record<string, string> }, pos: Vec3Like, observedAt: number): Observation {
  return {
    worldId: SCOPE.worldId,
    dim: SCOPE.dim,
    sessionId: SCOPE.sessionId,
    observedAt,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state,
    pos: { ...pos },
  };
}

let sampleSeq = 0;

function sampleAt(req: { worldId: string; dim: string; sessionId: string; executionId: string }, pos: Vec3Like): BodySample {
  return {
    worldId: req.worldId,
    dim: req.dim,
    sessionId: req.sessionId,
    executionId: req.executionId,
    sequence: ++sampleSeq,
    pos: { ...pos },
    observedAt: now,
    alive: true,
    connected: true,
    observationReady: true,
    onGround: true,
    inWater: false,
  };
}

/** A Fake body that moves only when the host resolves its pending promise. */
class DeferredExecutor implements MoveExecutor {
  private resolve: ((r: ExecutableMoveResult) => void) | null = null;
  private last: ExecutableMove | null = null;

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.last = request;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  confirm(target: Vec3Like): void {
    if (this.last === null || this.resolve === null) return;
    const request = this.last;
    this.last = null;
    this.resolve({ sample: sampleAt(request, target) });
    this.resolve = null;
  }

  stop(executionId: string): void {
    console.log(`  [executor] stop ${executionId}`);
  }
}

let now = 2000;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function main(): Promise<void> {
  const map = new VoxelMap('world', { now: () => now });
  const points: Vec3Like[] = [
    { x: 0.5, y: 0, z: 0.5 },
    { x: 1.5, y: 0, z: 0.5 },
    { x: 2.5, y: 0, z: 0.5 },
  ];
  for (let k = 0; k <= 3; k++) map.observe(obs({ name: 'minecraft:stone', properties: {} }, { x: k, y: -1, z: 0 }, 1000));
  for (let k = 0; k <= 3; k++) {
    map.observe(obs({ name: 'minecraft:air', properties: {} }, { x: k, y: 0, z: 0 }, 1000));
    map.observe(obs({ name: 'minecraft:air', properties: {} }, { x: k, y: 1, z: 0 }, 1000));
  }

  const executor = new DeferredExecutor();
  const loop = new WalkRouteExecutor(map, executor, { now: () => now });
  const request: WalkRouteRequest = {
    ...SCOPE,
    mode: 'walk',
    body: { feet: { ...points[0]! }, width: 0.6, height: 1.8, pose: 'standing' },
    points,
    arrival: { kind: 'exact' },
    shapeProvider: provider,
    deadlineMs: 100_000,
    timeoutMs: 10_000,
  };

  console.log('=== start ===');
  const initial = loop.start(request);
  console.log(`  route verdict: ${initial.route.verdict}`);

  // Confirm the body is measured at the route start before the first step.
  loop.onSample(sampleAt({ ...SCOPE, executionId: initial.delegationId }, points[0]!));

  // Step 0: verify + start, then the body confirms arrival at points[1].
  loop.advance(10);
  console.log(`  step 0 started (active=${loop.status()!.activeStepIndex})`);
  executor.confirm(points[1]!);
  await tick();
  console.log(`  step 0 confirmed (nextPointIndex=${loop.status()!.nextPointIndex})`);

  // Step 1: verify + start. Before the body confirms, a wall appears mid-route.
  loop.advance(10);
  console.log(`  step 1 started (active=${loop.status()!.activeStepIndex})`);
  now = 3000;
  const report = map.observe(obs({ name: 'minecraft:stone', properties: {} }, { x: 2, y: 0, z: 0 }, 3000));
  const stopped = loop.observe(report, 10);

  console.log('=== stopped by mid-route invalidation ===');
  console.log(`  outcome: ${stopped.result!.outcome}`);
  console.log(`  message: ${stopped.result!.message}`);
  console.log(`  problem: ${JSON.stringify(stopped.result!.problem)}`);
  console.log(`  lastPosition: ${JSON.stringify(stopped.result!.lastPosition ?? null)}`);
}

void main();
