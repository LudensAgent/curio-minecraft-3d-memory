/**
 * Type-level consumer acceptance. Run by `run.mjs` with `tsc --noEmit` from the
 * consumer directory, so every import resolves through the installed package's
 * `dist/*.d.ts` (`exports` `types` conditions), never the source tree.
 * It only needs to compile — nothing is executed.
 */

import {
  CONTRACT_VERSION,
  InMemoryFactStore,
  LandRouteVerifier,
  VoxelMap,
  createVoxelFactsQueryPort,
  searchLandRoute,
  searchLandRouteAsync,
} from 'curio-minecraft-3d-memory';
import { openSpatialSession, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';
import type {
  ActionRecord,
  BlockState,
  BodyContext,
  CollisionShapeProvider,
  LandSearchKind,
  LandSearchRequest,
  LandSearchResult,
  MemoryHostCapabilities,
  NavResult,
  Observation,
  SectionKey,
  SemanticPlaceView,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  Vec3Like,
} from 'curio-minecraft-3d-memory';
import type {
  ContainerAnchorFact,
  FactCheckpointSnapshot,
  FactStore,
  PlaceFact,
  ResourceAnchorFact,
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

export const kinds: readonly LandSearchKind[] = ['walk', 'step', 'drop'];

export const searchRequest: LandSearchRequest = {
  worldId: 'world',
  dim: 'overworld',
  sessionId: 'types',
  body,
  to: { x: 1.5, y: 0, z: 0.5 },
  arrival: { kind: 'exact' },
  rules: { shapeProvider: provider },
  allowed: kinds,
  maxNodes: 16,
  maxEdges: 64,
};

export function runSearch(map: VoxelMap): LandSearchResult {
  return searchLandRoute(map, searchRequest, 0);
}

export async function runSearchAsync(map: VoxelMap): Promise<LandSearchResult> {
  return searchLandRouteAsync(map, searchRequest, 0);
}

export function makeLandVerifier(map: VoxelMap): LandRouteVerifier {
  return new LandRouteVerifier(map, { now: () => 0 });
}

// Facts + read-only query port through the installed root declarations.
export function makeFacts(): {
  store: InMemoryFactStore;
  port: SpatialQueryPort;
  request: SpatialQueryRequest;
} {
  const store = new InMemoryFactStore();
  const port = createVoxelFactsQueryPort({ worldId: 'world', voxel: new VoxelMap('world'), facts: store });
  return { store, port, request: { kind: 'places', dim: 'overworld', limit: 10 } };
}

export const placeFact: PlaceFact = {
  id: 'types-place',
  kind: 'base',
  label: 'home',
  worldId: 'world',
  dim: 'overworld',
  location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
  observedAt: 100,
  source: { source: 'agent' },
  gone: false,
};

export const resourceFact: ResourceAnchorFact = {
  id: 'types-resource',
  worldId: 'world',
  dim: 'overworld',
  label: 'minecraft:iron_ore',
  sourceCell: { x: 1, y: 60, z: 0 },
  sourceCellVersion: 2,
  observedAt: 100,
  source: { source: 'vision' },
  revoked: false,
};

export const containerFact: ContainerAnchorFact = {
  id: 'types-container',
  worldId: 'world',
  dim: 'overworld',
  pos: { x: 2, y: 64, z: 0 },
  externalRef: 'chest:types',
  observedAt: 100,
  source: { source: 'vision' },
  gone: false,
};

export function readFacts(store: FactStore): FactCheckpointSnapshot {
  return store.checkpointSnapshot();
}

export function readPlaceView(result: SpatialQueryResult): SemanticPlaceView | null {
  return result.data?.kind === 'places' ? (result.data.items[0] ?? null) : null;
}

// The capability contract has exactly three domains and contract version 2.
export function capabilityShape(cap: MemoryHostCapabilities): boolean {
  return cap.contract === CONTRACT_VERSION && !('plan' in cap) && !('execute' in cap);
}

// `openSpatialSession` is a value export from the SQLite subpath: assert its type.
export const opener: (options: OpenSpatialSessionOptions) => Promise<SpatialSession> = openSpatialSession;

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
  LandSearchKind,
  LandSearchRequest,
  LandSearchResult,
  SemanticPlaceView,
  SpatialQueryPort,
  SpatialQueryRequest,
  SpatialQueryResult,
  MemoryHostCapabilities,
} from 'curio-minecraft-3d-memory';

export {};
