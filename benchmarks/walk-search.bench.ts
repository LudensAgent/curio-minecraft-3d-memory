/**
 * M8.1 — walk route search (`WalkRouteSearch`) over a populated `VoxelMap`.
 *
 * Scale (report M1 of the B18 review): the map holds **10 000 sparse Sections**
 * (one observed cell each, 100 × 100 Section-index grid starting at Section
 * cz = 100, i.e. block z >= 1600) plus a
 * standable corridor of `ROUTE_POINTS` floor cells, but only the corridor's
 * own Sections are inside the start→target reachable region. The sparse
 * Sections are constructed and resident (they affect residency/lookup
 * structures) and are **not evaluated** by the search; the table says this
 * explicitly instead of letting the count imply otherwise.
 *
 * A sparse-region-crossing route (M1 option (a)) is not reachable at the
 * requested scales: a walk route of 1024 points moves one block per step and
 * can touch at most ~1024/16 = 64 Sections on a line (≤128 counting the
 * support row); crossing 10 000 Sections needs a ≥160 000-block route, far
 * beyond `maxRoutePoints=1024` and the search `maxNodes`/`maxEdges` budgets.
 * The sparse grid also sits at z >= 1600, outside the corridor's reachable
 * region, and has only one observed stone cell per Section (all boundary
 * evidence UNKNOWN). Option (b) is therefore used: report the sparse Sections
 * honestly and add a separate start-inside-the-grid scenario.
 *
 * Scenarios (the first three share the 10 128-Section map; the control is a
 * 128-Section map):
 * - `search full 1024-edge corridor`: whole route found, budget above the
 *   corridor edges — 1023 edges, 3068 edges evaluated.
 * - `search maxNodes=64 (frontier path)`: a bounded search that stops early
 *   and does frontier/diagnostic work instead of a route.
 * - `sparse region boundary`: start next to the grid's first observed stone
 *   column (support at y = -1 observed, feet above unobserved) and target the
 *   neighbouring column. The 4 neighbour edges are UNKNOWN `unobserved`, the
 *   search reports INSUFFICIENT_EVIDENCE and evaluates 6 Sections (the start
 *   and the unobserved cells' Sections). A start placed *inside* an observed
 *   stone cell instead stops with 4 BLOCKED `collision` edges (self-collision)
 *   and 1 evaluated Section; that degenerate case is not the reported row.
 * - `corridor only (control)`: isolates the corridor cost from the resident
 *   sparse Sections.
 *
 * Setup (Section population) is timed once and reported separately; the
 * measured rounds only run the search.
 *
 * Run: `npx tsx benchmarks/walk-search.bench.ts`
 */

import { WalkRouteSearch } from '../src/index.js';
import type { Vec3Like, WalkSearchSnapshot, VoxelMap } from '../src/index.js';
import {
  benchShapeProvider,
  benchmark,
  bodyAt,
  build,
  buildCorridorMap,
  buildSparseSections,
  corridorPoints,
  DIM,
  NOW,
  observeCorridor,
  Report,
  RUNS,
  SESSION,
  WORLD,
} from './fixtures.js';

const SECTIONS = 10_000;
const ROUTE_POINTS = 1024;

const report = new Report(
  'walk search benchmark',
  'Real `WalkRouteSearch` over an in-memory `VoxelMap`; `benchShapeProvider` is a fake collision rule (NOT Minecraft 1.20.1). The 10 000 sparse Sections are resident but outside the searched corridor: `evaluatedSections` counts the Sections the corridor route actually reads.',
);

const fixture = await build('populate 10k Sections + 1024-point corridor', { sections: SECTIONS, routePoints: ROUTE_POINTS }, () => {
  const { map, plan } = buildSparseSections(SECTIONS);
  observeCorridor(map, ROUTE_POINTS, plan.observations);
  return { map, sparseSections: plan.sections, corridorCells: ROUTE_POINTS };
});
report.add(fixture.setup);
const { map, sparseSections, corridorCells } = fixture.value;

const controlFixture = await build('populate 1024-point corridor (control)', { routePoints: ROUTE_POINTS }, () =>
  buildCorridorMap(ROUTE_POINTS),
);
report.add(controlFixture.setup);
const control = controlFixture.value;

const points = corridorPoints(ROUTE_POINTS);

/**
 * Run one search to a terminal snapshot. Budget slices are how the API
 * evaluates edges incrementally; the search's own limits stop it, the loop
 * bound is only a safety stop.
 */
function searchFrom(
  map: VoxelMap,
  body: { x: number; y: number; z: number },
  goal: { x: number; y: number; z: number },
  limits: { maxNodes?: number; maxEdges?: number },
): WalkSearchSnapshot {
  const search = new WalkRouteSearch(map, { now: () => NOW, ...limits });
  search.start({
    worldId: WORLD,
    dim: DIM,
    sessionId: SESSION,
    mode: 'walk',
    body: bodyAt(body.x, body.y, body.z),
    target: { ...goal },
    arrival: { kind: 'exact' },
    shapeProvider: benchShapeProvider,
  });
  let snapshot = search.status()!;
  for (let i = 0; i < 100_000 && snapshot.state === 'PENDING'; i++) snapshot = search.advance(256);
  return snapshot;
}

/**
 * Sections the evaluator must read for this outcome: every route stance reads
 * feet/head and support cells, and every non-OPEN diagnostic names the cells it
 * could not prove. Derived from the result's own points/cells — a lower-bound
 * count of the Sections `sectionAt` touched, not an instrumented read count.
 */
function evaluatedSections(snapshot: WalkSearchSnapshot): number {
  const sections = new Set<string>();
  const add = (x: number, y: number, z: number): void => {
    sections.add(`${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`);
  };
  for (const point of snapshot.candidate?.points ?? []) {
    add(point.x, point.y, point.z);
    add(point.x, point.y - 1, point.z);
  }
  for (const diagnostic of snapshot.diagnostics) {
    add(diagnostic.stance.x, diagnostic.stance.y, diagnostic.stance.z);
    for (const cell of diagnostic.problem?.cells ?? []) {
      add(cell.x, cell.y, cell.z);
      add(cell.x, cell.y - 1, cell.z);
    }
  }
  return sections.size;
}

/**
 * A search whose start is beside the sparse grid's first observed stone column
 * (block (0, -1, 1600)): support is observed, so the start stance is measured,
 * but every neighbour cell is unobserved and the target is unreachable.
 */
function searchSparseBoundary(
  map: VoxelMap,
  limits: { maxNodes?: number; maxEdges?: number },
): WalkSearchSnapshot {
  return searchFrom(
    map,
    { x: 0.5, y: 0, z: 1600.5 },
    { x: 0.5, y: 0, z: 1601.5 },
    limits,
  );
}

/** Search along the corridor route from its first to its last point. */
function searchCorridor(map: VoxelMap, routePoints: readonly Vec3Like[], limits: { maxNodes?: number; maxEdges?: number }): WalkSearchSnapshot {
  return searchFrom(map, routePoints[0]!, routePoints[routePoints.length - 1]!, limits);
}

const fullLimits = { maxNodes: ROUTE_POINTS + 1, maxEdges: (ROUTE_POINTS + 1) * 4 };
const boundedLimits = { maxNodes: 64, maxEdges: 512 };

// Scale sanity: the reported numbers must describe a real route, not a budget stop.
const warm = searchCorridor(map, points, fullLimits);
if (warm.state !== 'FOUND' || warm.candidate === null || warm.candidate.edgeCount !== ROUTE_POINTS - 1) {
  throw new Error(`walk-search setup is wrong: state=${warm.state} edgeCount=${warm.candidate?.edgeCount ?? 'null'}`);
}
const fullEvaluated = evaluatedSections(warm);

const search = await benchmark('search full 1024-edge corridor', {
  sections: map.residentSectionKeys().length,
  sparseSections,
  corridorCells,
  routePoints: ROUTE_POINTS,
  routeEdges: warm.candidate.edgeCount,
  edgesEvaluated: warm.counters.edgesEvaluated,
  evaluatedSections: fullEvaluated,
}, () => searchCorridor(map, points, fullLimits), RUNS);

// A bounded search stops before the end: frontier/diagnostic work instead of a route.
const nearest = await benchmark('search maxNodes=64 (frontier path)', {
  sections: map.residentSectionKeys().length,
  sparseSections,
  maxNodes: 64,
  corridorCells,
  evaluatedSections: evaluatedSections(searchCorridor(map, points, boundedLimits)),
}, () => searchCorridor(map, points, boundedLimits), RUNS);

// Start beside the grid's first observed stone column: support observed, all
// neighbours unobserved, target unreachable. 6 Sections evaluated (start +
// the unobserved cells around it), 4 UNKNOWN edges.
const sparseLimits = { maxNodes: 16, maxEdges: 64 };
const sparseWarm = searchSparseBoundary(map, sparseLimits);
if (sparseWarm.state !== 'INSUFFICIENT_EVIDENCE') {
  throw new Error(`sparse-region setup is wrong: state=${sparseWarm.state}`);
}
const sparseBench = await benchmark('sparse region boundary (start beside grid column)', {
  sections: map.residentSectionKeys().length,
  sparseSections,
  maxNodes: sparseLimits.maxNodes,
  state: sparseWarm.state,
  edgesUnknown: sparseWarm.counters.edgesUnknown,
  evaluatedSections: evaluatedSections(sparseWarm),
}, () => searchSparseBoundary(map, sparseLimits), RUNS);

const controlSearch = await benchmark('corridor only (control)', {
  sections: control.map.residentSectionKeys().length,
  corridorCells: control.plan.floorCells,
  routePoints: ROUTE_POINTS,
  evaluatedSections: evaluatedSections(searchCorridor(control.map, points, fullLimits)),
}, () => searchCorridor(control.map, points, fullLimits), RUNS);

report.add(search);
report.add(nearest);
report.add(controlSearch);
report.add(sparseBench);
report.flush();
