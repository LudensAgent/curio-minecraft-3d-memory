/**
 * Type-level consumer acceptance. Run by `run.mjs` with `tsc --noEmit` from the
 * consumer directory, so every import resolves through the installed package's
 * `dist/*.d.ts` (the `exports` `types` conditions), never the source tree. It
 * only needs to compile — nothing is executed.
 */

import {
  FragmentStore,
  RouteVerifier,
  VoxelMap,
  WalkRouteExecutor,
  WalkRouteSearch,
  startKnownWalkRoute,
} from 'curio-minecraft-3d-memory';
import { openSpatialSession, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  BlockState,
  BodyContext,
  CollisionShapeProvider,
  KnownWalkRouteRejectionReason,
  KnownWalkRouteRequest,
  KnownWalkRouteSnapshot,
  KnownWalkRouteStart,
  MoveExecutor,
  PathFragment,
  SectionKey,
  Vec3Like,
  WalkSearchArrival,
  WalkSearchCandidate,
  WalkSearchCounters,
  WalkSearchDiagnostic,
  WalkSearchFrontier,
  WalkSearchLimits,
  WalkSearchOptions,
  WalkSearchProblem,
  WalkSearchRequest,
  WalkSearchSnapshot,
  WalkSearchState,
  WalkSearchUnavailableEvidence,
  WalkSearchUnavailableResidency,
  WalkSearchUnavailableSection,
} from 'curio-minecraft-3d-memory';
import type {
  OpenSpatialSessionOptions,
  PrepareResult,
  SpatialCheckpointResult,
  SpatialSession,
} from 'curio-minecraft-3d-memory/storage/sqlite';

export function makeKey(): SectionKey {
  return { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 0 };
}

export function makeState(): BlockState {
  return { name: 'minecraft:stone', properties: {} };
}

export function makePos(): Vec3Like {
  return { x: 0.5, y: 0, z: 0.5 };
}

export const sessionOptions: OpenSpatialSessionOptions = {
  databasePath: '/tmp/consumer.db',
  worldId: 'world',
};

export async function useSession(s: SpatialSession): Promise<string> {
  const cp: SpatialCheckpointResult = await s.checkpoint();
  return cp.checkpointId;
}

export function makeManager(s: SpatialSession): WorkingSetManager {
  return new WorkingSetManager(s);
}

export async function prepare(manager: WorkingSetManager, key: SectionKey): Promise<PrepareResult> {
  return manager.prepare([key]);
}

export function makeVerifier(map: VoxelMap): RouteVerifier {
  return new RouteVerifier(map, { now: () => 0 });
}

export function makeExecutor(map: VoxelMap, move: MoveExecutor): WalkRouteExecutor {
  return new WalkRouteExecutor(map, move, { now: () => 0 });
}

export const provider: CollisionShapeProvider = {
  version: 'types-1',
  resolve(state: BlockState) {
    if (state.name === 'minecraft:air') return { kind: 'shape', shape: { boxes: [], supportFaces: [] } };
    return {
      kind: 'shape',
      shape: {
        boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }],
        supportFaces: [{ top: 1, minX: 0, minZ: 0, maxX: 1, maxZ: 1 }],
      },
    };
  },
};

export const body: BodyContext = {
  feet: { x: 0.5, y: 0, z: 0.5 },
  width: 0.6,
  height: 1.8,
  pose: 'standing',
};

// `openSpatialSession` is a value export from the SQLite subpath: assert its type.
export const opener: (options: OpenSpatialSessionOptions) => Promise<SpatialSession> = openSpatialSession;

// New root-entry followups: bounded read-only search and explicit historical
// route start, constructed and called through the installed dist types only.
export const legacyFragment: PathFragment = {
  id: 'types-legacy',
  worldId: 'world',
  dim: 'overworld',
  kind: 'built',
  entrances: [{ x: 0.5, y: 0, z: 0.5 }],
  polyline: [
    { x: 0.5, y: 0, z: 0.5 },
    { x: 1.5, y: 0, z: 0.5 },
  ],
  geometrySource: 'legacy',
  deepestY: 0,
  createdAt: 0,
  lastUsedAt: 0,
  uses: 1,
};

export const searchOptions: WalkSearchOptions = { now: () => 0, maxNodes: 16 };

export const searchRequest: WalkSearchRequest = {
  worldId: 'world',
  dim: 'overworld',
  sessionId: 'types',
  mode: 'walk',
  body,
  target: { x: 1.5, y: 0, z: 0.5 },
  arrival: { kind: 'exact' },
  shapeProvider: provider,
};

export const knownRequest: KnownWalkRouteRequest = {
  worldId: 'world',
  dim: 'overworld',
  sessionId: 'types',
  mode: 'walk',
  body,
  arrival: { kind: 'exact' },
  shapeProvider: provider,
  deadlineMs: 1_000,
  timeoutMs: 1_000,
  fragmentId: 'types-legacy',
  parentActionId: 'types-parent',
};

export function makeSearch(map: VoxelMap): WalkRouteSearch {
  return new WalkRouteSearch(map, searchOptions);
}

export function runSearch(search: WalkRouteSearch): WalkSearchSnapshot {
  return search.start(searchRequest);
}

export function recordFragment(history: FragmentStore): void {
  history.saveFragment(legacyFragment);
}

export function startKnownOn(history: FragmentStore, map: VoxelMap, move: MoveExecutor): KnownWalkRouteStart {
  return startKnownWalkRoute(history, new WalkRouteExecutor(map, move, { now: () => 0 }), knownRequest);
}

// Barrel regression protection: every added public type must remain re-exported
// from the package root entry.
export type {
  KnownWalkRouteRejectionReason,
  KnownWalkRouteRequest,
  KnownWalkRouteSnapshot,
  KnownWalkRouteStart,
  WalkSearchArrival,
  WalkSearchCandidate,
  WalkSearchCounters,
  WalkSearchDiagnostic,
  WalkSearchFrontier,
  WalkSearchLimits,
  WalkSearchOptions,
  WalkSearchProblem,
  WalkSearchRequest,
  WalkSearchSnapshot,
  WalkSearchState,
  WalkSearchUnavailableEvidence,
  WalkSearchUnavailableResidency,
  WalkSearchUnavailableSection,
} from 'curio-minecraft-3d-memory';

export {};
