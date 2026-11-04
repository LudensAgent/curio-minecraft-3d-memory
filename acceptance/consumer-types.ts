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
  ActionRecord,
  BlockState,
  BodyContext,
  CollisionShapeProvider,
  KnownWalkRouteRejectionReason,
  KnownWalkRouteRequest,
  KnownWalkRouteSnapshot,
  KnownWalkRouteStart,
  MoveExecutor,
  NavResult,
  Observation,
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
  JournalAcceptResult,
  JournalBatchAcceptResult,
  JournalController,
  JournalLimits,
  JournalPage,
  JournalWithdrawalResult,
  OpenSpatialSessionOptions,
  PendingJournalSnapshot,
  PrepareResult,
  SpatialCheckpointResult,
  SpatialEvent,
  SpatialPersistenceState,
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

export const journalLimits: JournalLimits = { maxBatchRecords: 1, maxPageRecords: 1 };

export const sessionOptions: OpenSpatialSessionOptions = {
  databasePath: '/tmp/consumer.db',
  worldId: 'world',
  journalLimits,
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

// Public journal types: Fake library-only fixtures and calls resolved from the
// installed root + storage/sqlite declarations (no relative src import, no `any`).
export const journalObservation: Observation = {
  pos: { x: -1, y: 0, z: 2 },
  state: { name: 'minecraft:dirt', properties: {} },
  stateComplete: true,
  evidence: 'seen',
  observedAt: 2000,
  source: 'vision',
  sessionId: 'types-journal',
  sequence: 7,
  worldId: 'world',
  dim: 'overworld',
};

export const journalNavResult: NavResult = {
  outcome: 'CANCELLED',
  message: 'types-only cancelled result with a partial effect',
  trace: [{ pos: { x: 0.5, y: 0, z: 0.5 }, ts: 2000 }],
  consumption: {
    placed: [{ pos: { x: 1, y: 0, z: 2 }, name: 'minecraft:dirt' }],
    durabilityLost: 1,
    digMs: 4,
  },
  memoryWrite: 'pending',
  lastPosition: { x: 0.5, y: 0, z: 0.5 },
  lastObservation: {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 'types-journal',
    observedAt: 2000,
    onGround: true,
    inWater: false,
  },
  confirmed: false,
  problem: { kind: 'cancelled', by: 'agent', reason: 'types-only fixture' },
};

export const journalAction: ActionRecord = {
  id: 'types-journal-action',
  ts: 2000,
  worldId: 'world',
  dim: 'overworld',
  sessionId: 'types-journal',
  delegationId: 'types-journal-delegation',
  delegation: {
    requestedTarget: 'types-only target',
    target: { x: 1, y: 0, z: 2 },
    allowedModes: ['walk'],
    arrival: { kind: 'near', radius: 1 },
    allowDigging: false,
    allowPlacing: true,
    allowTower: false,
    materials: [{ name: 'minecraft:dirt', maxCount: 1 }],
    exploration: 'known_only',
  },
  subActions: [],
  from: { x: 0.5, y: 0, z: 0.5 },
  to: { x: 1.5, y: 0, z: 0.5 },
  trace: [{ pos: { x: 0.5, y: 0, z: 0.5 }, ts: 2000 }],
  consumption: { placed: [{ pos: { x: 1, y: 0, z: 2 }, name: 'minecraft:dirt' }] },
  observedChanges: [journalObservation],
  confirmed: false,
  result: journalNavResult,
};

export const journalChangeEvent: SpatialEvent = {
  kind: 'observed_cell_change',
  id: 'types-journal-change',
  observedAt: 2000,
  worldId: 'world',
  dim: 'overworld',
  sessionId: 'types-journal',
  pos: { x: -1, y: 0, z: 2 },
  previous: {
    ...journalObservation,
    state: { name: 'minecraft:stone', properties: {} },
    sessionId: 'types-journal-earlier',
    observedAt: 500,
  },
  current: journalObservation,
};

export const journalGapEvent: SpatialEvent = {
  kind: 'observation_gap',
  id: 'types-journal-gap',
  observedAt: 2500,
  worldId: 'world',
  dim: 'overworld',
  sessionId: 'types-journal',
  reason: 'paused',
};

export function journalController(s: SpatialSession): JournalController {
  return s.journal;
}

export function recordJournalAction(journal: JournalController): JournalAcceptResult {
  return journal.recordAction(journalAction);
}

export function recordJournalEvent(journal: JournalController): JournalAcceptResult {
  return journal.recordEvent(journalChangeEvent);
}

export function recordJournalBatch(journal: JournalController): JournalBatchAcceptResult {
  return journal.recordBatch({ actions: [journalAction], events: [journalChangeEvent, journalGapEvent] });
}

export function readPendingJournal(journal: JournalController): PendingJournalSnapshot {
  return journal.readPending();
}

export function withdrawJournal(journal: JournalController): JournalWithdrawalResult {
  return journal.withdraw({ actions: [{ sessionId: 'types-journal', id: 'types-journal-action' }] });
}

export function pageJournalActions(s: SpatialSession): Promise<JournalPage<ActionRecord>> {
  return s.queryActions({ maxRecords: 1 });
}

export function pageJournalEvents(s: SpatialSession): Promise<JournalPage<SpatialEvent>> {
  return s.queryEvents({ kind: 'observed_cell_change', maxRecords: 1 });
}

export function checkpointJournal(s: SpatialSession): Promise<SpatialCheckpointResult> {
  return s.checkpoint();
}

export function journalStateFields(s: SpatialSession): {
  journalRevision: number;
  confirmedJournalRevision: number;
  journalBaselineCheckpointId: string | null;
  pendingJournalRecords: number;
  pendingJournalBytes: number;
  committedJournalRecords: number;
  committedJournalBytes: number;
  dirty: boolean;
} {
  const state: SpatialPersistenceState = s.getPersistenceState();
  return {
    journalRevision: state.journalRevision,
    confirmedJournalRevision: state.confirmedJournalRevision,
    journalBaselineCheckpointId: state.journalBaselineCheckpointId,
    pendingJournalRecords: state.pendingJournalRecords,
    pendingJournalBytes: state.pendingJournalBytes,
    committedJournalRecords: state.committedJournalRecords,
    committedJournalBytes: state.committedJournalBytes,
    dirty: state.dirty,
  };
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
