/**
 * M8.1 — route planning (`planRoute`) + full route re-verification, 1024 points.
 *
 * Two backends are measured over the same 1024-point corridor:
 * - `source: 'search'`: `WalkRouteSearch` inside `planRoute`, then the planner's
 *   own bounded re-verification of the returned candidate.
 * - `source: 'history'`: one recorded 1024-point fragment, re-verified point by
 *   point through `RouteVerifier`.
 *
 * Run: `npx tsx benchmarks/route-plan.bench.ts`
 */

import {
  FragmentStore,
  planRoute,
  RoutePlanRegistryImpl,
  RouteVerifier,
  createWalkRouteSearchSource,
  WalkRouteSearch,
} from '../src/index.js';
import type { RoutePlanEnvironment, RoutePlanRequest } from '../src/index.js';
import { benchShapeProvider, bodyAt, buildCorridorMap, buildStraightFragment, corridorPoints, sampleAt, NOW, WORLD, DIM, SESSION, benchmark, build, Report, RUNS } from './fixtures.js';

const ROUTE_POINTS = 1024;
const DEADLINE = NOW + 1_000_000;

const report = new Report(
  'route plan benchmark',
  'Real `planRoute` + `RouteVerifier` over an in-memory `VoxelMap`/`FragmentStore`; `benchShapeProvider` is a fake collision rule (NOT Minecraft 1.20.1).',
);

const corridor = await build('populate 1024-point corridor', { routePoints: ROUTE_POINTS }, () => buildCorridorMap(ROUTE_POINTS));
report.add(corridor.setup);
const { map } = corridor.value;
const points = corridorPoints(ROUTE_POINTS);

function planEnvironment(verifier: RouteVerifier, search?: ReturnType<typeof createWalkRouteSearchSource>): RoutePlanEnvironment {
  return {
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    shapeProvider: benchShapeProvider,
    sample: () => sampleAt(points[0]!, 'bench-plan', 1, NOW - 100),
    ...(search === undefined ? {} : { search }),
    verifier,
    registry: new RoutePlanRegistryImpl({ now: () => NOW }),
    now: () => NOW,
    budgetPerSlice: 256,
    planTtlMs: 60_000,
    maxRoutePoints: ROUTE_POINTS,
    wait: async () => {},
  };
}

function request(overrides: Partial<RoutePlanRequest>): RoutePlanRequest {
  return {
    to: { ...points[points.length - 1]! },
    mode: 'walk',
    source: 'search',
    arrival: { kind: 'exact' },
    deadlineMs: DEADLINE,
    ...overrides,
  };
}

const searchPlan = await benchmark('planRoute search backend, 1024 points', {
  routePoints: ROUTE_POINTS,
  corridorSections: map.residentSectionKeys().length,
}, async () => {
  const verifier = new RouteVerifier(map, { now: () => NOW });
  const search = createWalkRouteSearchSource(new WalkRouteSearch(map, { now: () => NOW }));
  const result = await planRoute(request({ source: 'search' }), planEnvironment(verifier, search));
  if (result.problem !== undefined || result.plan === undefined) {
    throw new Error(`search plan failed: ${JSON.stringify(result.problem ?? null)} ${result.message}`);
  }
  if (result.plan.points.length !== ROUTE_POINTS) {
    throw new Error(`search plan returned ${result.plan.points.length} points, expected ${ROUTE_POINTS}`);
  }
  return result.plan;
}, RUNS);

const historyStore = new FragmentStore(WORLD);
const straight = buildStraightFragment(historyStore, ROUTE_POINTS);

const historyPlan = await benchmark('planRoute history backend, 1024 points', {
  routePoints: straight.points,
}, async () => {
  const verifier = new RouteVerifier(map, { now: () => NOW });
  const result = await planRoute(
    request({ source: 'history', pathId: straight.fragmentId }),
    { ...planEnvironment(verifier), history: historyStore },
  );
  if (result.problem !== undefined || result.plan === undefined) {
    throw new Error(`history plan failed: ${JSON.stringify(result.problem ?? null)} ${result.message}`);
  }
  return result.plan;
}, RUNS);

// Direct full-route re-verification, measured without planning's envelope.
const verify = await benchmark('RouteVerifier full 1024-point route', {
  routePoints: ROUTE_POINTS,
}, () => {
  const verifier = new RouteVerifier(map, { now: () => NOW });
  verifier.register({
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    mode: 'walk',
    body: bodyAt(points[0]!.x, points[0]!.y, points[0]!.z),
    points: points.map((point) => ({ ...point })),
    shapeProvider: benchShapeProvider,
  });
  let status = verifier.advance(256);
  for (let i = 0; i < 100_000 && status.verdict === 'INCOMPLETE'; i++) status = verifier.advance(256);
  if (status.verdict !== 'OPEN' || !status.complete) throw new Error(`route verification finished ${status.verdict} (complete=${status.complete})`);
  return status;
}, RUNS);

report.add(searchPlan);
report.add(historyPlan);
report.add(verify);
report.flush();
