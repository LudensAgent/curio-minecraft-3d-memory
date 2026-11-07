/**
 * M8.1 — controlled walk-route execution (`WalkRouteExecutor`) over 1024 points.
 *
 * IMPORTANT: this uses a **Scripted `WalkBodyPort`-/`MoveExecutor`-style fake**
 * that resolves every single-step move immediately at the requested point. It is
 * **NOT a real Minecraft server and NOT mineflayer**; it measures the executor +
 * verifier loop, not network, physics, or world I/O. The fixture map is likewise
 * an in-memory `VoxelMap` with fake collision rules (`benchShapeProvider`).
 *
 * Each round starts a fresh delegation, confirms the measured start, then drives
 * one `advance()` + one scripted move per route step until ARRIVED.
 * `await null` after each advance lets the scripted promise's `.then` handler run.
 *
 * Run: `npx tsx benchmarks/route-execution.bench.ts`
 */

import { WalkRouteExecutor } from '../src/index.js';
import type { ExecutableMove, ExecutableMoveResult, MoveExecutor, WalkRouteRequest } from '../src/index.js';
import { benchShapeProvider, bodyAt, buildCorridorMap, corridorPoints, sampleAt, NOW, WORLD, DIM, SESSION, benchmark, build, Report, RUNS } from './fixtures.js';

const ROUTE_POINTS = 1024;
const DEADLINE = NOW + 1_000_000;

const report = new Report(
  'route execution benchmark',
  'Real `WalkRouteExecutor` + `RouteVerifier`; **scripted fake `MoveExecutor` (NOT a real server / NOT mineflayer)** and fake collision rules.',
);

const corridor = await build('populate 1024-point route corridor', { routePoints: ROUTE_POINTS }, () => buildCorridorMap(ROUTE_POINTS));
report.add(corridor.setup);
const { map } = corridor.value;
const points = corridorPoints(ROUTE_POINTS);

/** Immediate single-step fake: the "body" is always exactly at the requested point. */
class ScriptedMoveExecutor implements MoveExecutor {
  private sequence = 1;
  moves = 0;

  move(request: ExecutableMove): Promise<ExecutableMoveResult> {
    this.moves += 1;
    const sample = sampleAt(request.to, request.executionId, ++this.sequence, NOW + 100);
    return Promise.resolve({ sample });
  }

  stop(): void {}
}

function request(): WalkRouteRequest {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    mode: 'walk',
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    points: points.map((point) => ({ ...point })),
    arrival: { kind: 'exact' },
    shapeProvider: benchShapeProvider,
    deadlineMs: DEADLINE,
    timeoutMs: 60_000,
  };
}

const execution = await benchmark('execute 1023 steps of a 1024-point route', {
  routePoints: ROUTE_POINTS,
  steps: ROUTE_POINTS - 1,
}, async () => {
  const executor = new ScriptedMoveExecutor();
  const loop = new WalkRouteExecutor(map, executor, { now: () => NOW, maxRouteLength: ROUTE_POINTS });
  const started = loop.start(request());
  // Confirmed measured start (the body must be at the first route point).
  loop.onSample(sampleAt(points[0]!, started.delegationId, 1));
  const budgetPerAdvance = 256;
  for (let i = 0; i < ROUTE_POINTS * 4; i++) {
    const status = loop.advance(budgetPerAdvance);
    await null;
    if (status.result !== null) {
      if (status.result.outcome !== 'ARRIVED') {
        throw new Error(`execution ended ${status.result.outcome}: ${status.result.message}`);
      }
      return status;
    }
  }
  throw new Error(`execution did not finish after ${ROUTE_POINTS * 4} advances`);
}, RUNS);

report.add(execution);
report.flush();
