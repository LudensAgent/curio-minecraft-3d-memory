/**
 * `frontiers` query kind (contract §5 additive kind, D-V4-017).
 *
 * All snapshots here are caller-supplied fixtures: the library is only allowed
 * to project them. The suite checks bounds, scope, evidence facts, read-only
 * behavior, and that a never-observed boundary is never reported as passable.
 */

import { describe, expect, it } from 'vitest';

import {
  FragmentStore,
  SpatialMemoryStoreImpl,
  TopologyStore,
  VoxelMap,
} from '../src/index.js';
import type {
  Observation,
  SpatialQueryRequest,
  SpatialQueryResult,
  Vec3Like,
  WalkSearchDiagnostic,
  WalkSearchSnapshot,
  WalkSearchState,
  WalkSearchUnavailableEvidence,
} from '../src/index.js';

const WORLD = 'world';
const DIM = 'overworld';
const NOW = 2000;

interface CandidateSpec {
  stance: Vec3Like;
  to: Vec3Like;
  gap?: Vec3Like[];
  reason?: string;
  computedAt?: number;
  validUntil?: number;
}

function observation(pos: Vec3Like, sessionId: string): Observation {
  return {
    pos: { ...pos },
    state: { name: 'air', properties: {} },
    stateComplete: true,
    evidence: 'seen',
    observedAt: 900,
    source: 'vision',
    sessionId,
    sequence: 1,
    dim: DIM,
    worldId: WORLD,
  };
}

function makeSnapshot(
  overrides: {
    worldId?: string;
    dim?: string;
    sessionId?: string;
    state?: WalkSearchState;
    candidates?: readonly CandidateSpec[];
    frontierLimitReached?: boolean;
    diagnostics?: WalkSearchDiagnostic[];
    diagnosticsTruncated?: boolean;
    unavailableHistorical?: WalkSearchUnavailableEvidence[];
    unavailableHistoricalCount?: number;
    unavailableHistoricalTruncated?: boolean;
  } = {},
): WalkSearchSnapshot {
  const worldId = overrides.worldId ?? WORLD;
  const dim = overrides.dim ?? DIM;
  const sessionId = overrides.sessionId ?? 'session-1';
  const specs = overrides.candidates ?? [];
  const diagnostics = overrides.diagnostics ?? [];
  const unavailableHistorical = overrides.unavailableHistorical ?? [];
  const unavailableHistoricalCount =
    overrides.unavailableHistoricalCount ?? unavailableHistorical.length;
  return {
    state: overrides.state ?? 'INSUFFICIENT_EVIDENCE',
    worldId,
    dim,
    sessionId,
    mode: 'walk',
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    from: { x: 0.5, y: 0, z: 0.5 },
    target: { x: 3.5, y: 0, z: 0.5 },
    arrival: { kind: 'exact' },
    ruleVersion: '1.20.1/1',
    limits: { maxNodes: 2048, maxEdges: 8192, maxFrontiers: 64, maxDiagnostics: 64 },
    candidate: null,
    frontiers: specs.map((spec) => ({
      stance: { ...spec.stance },
      to: { ...spec.to },
      gap: (spec.gap ?? [{ ...spec.to }]).map((cell) => ({ ...cell })),
      reachability: 'OPEN',
      basis: [observation(spec.stance, sessionId)],
      reason: spec.reason ?? 'never observed',
      computedAt: spec.computedAt ?? 1000,
      validUntil: spec.validUntil ?? 9000,
    })),
    unavailableHistorical,
    diagnostics,
    counters: {
      nodesReached: 1,
      nodesExpanded: 0,
      edgesEvaluated: 0,
      edgesOpen: 0,
      edgesBlocked: 0,
      edgesUnknown: 0,
      edgesStale: 0,
      edgesUnsupported: 0,
      edgesSkippedReached: 0,
      frontierCandidates: specs.length,
      frontiersReported: specs.length,
      frontierLimitReached: overrides.frontierLimitReached ?? false,
      unavailableHistoricalCandidates: 0,
      unavailableHistoricalReported: unavailableHistoricalCount,
      unavailableHistoricalLimitReached: overrides.unavailableHistoricalTruncated ?? false,
      diagnosticsReported: diagnostics.length,
      diagnosticsTruncated: overrides.diagnosticsTruncated ?? false,
      hasMoreWork: false,
    },
    reason: 'frontier projection fixture',
    computedAt: 1000,
    validUntil: 9000,
  };
}

function makeStore(
  provider: ((dim: string, here: Vec3Like) => WalkSearchSnapshot | null) | null,
) {
  const now = () => NOW;
  const map = new VoxelMap(WORLD, { now });
  const fragments = new FragmentStore(WORLD);
  const topology = new TopologyStore(fragments, { now });
  const store = new SpatialMemoryStoreImpl({
    worldId: WORLD,
    map,
    fragments,
    topology,
    ...(provider === null ? {} : { frontierSource: provider }),
    query: { now },
  });
  return { store, map, fragments, topology };
}

function dataOf(result: SpatialQueryResult) {
  expect(result.status).toBe('ok');
  if (result.data?.kind !== 'frontiers') throw new Error('expected frontiers data');
  return result.data;
}

const CANDIDATES: CandidateSpec[] = [
  { stance: { x: 0.5, y: 0, z: 0.5 }, to: { x: 1.5, y: 0, z: 0.5 }, gap: [{ x: 1.5, y: 0, z: 0.5 }] },
  { stance: { x: 0.5, y: 0, z: 0.5 }, to: { x: 0.5, y: 0, z: 1.5 }, gap: [{ x: 0.5, y: 0, z: 1.5 }] },
  { stance: { x: 1.5, y: 0, z: 0.5 }, to: { x: 2.5, y: 0, z: 0.5 }, reason: 'wall face' },
];

describe('frontiers query — projection facts', () => {
  it('projects candidates in snapshot order without selecting or claiming the boundary reachable', () => {
    const snapshot = makeSnapshot({ candidates: CANDIDATES });
    let providerCalls = 0;
    const { store } = makeStore(() => {
      providerCalls += 1;
      return snapshot;
    });

    const result = store.query({
      kind: 'frontiers',
      dim: DIM,
      here: { x: 0.5, y: 0, z: 0.5 },
    });
    const data = dataOf(result);

    expect(result.readOnly).toBe(true);
    expect(result.executable).toBe(false);
    expect(result.worldId).toBe(WORLD);
    expect(result.dim).toBe(DIM);
    expect(result.total).toBe(3);
    expect(result.nextAfter).toBeUndefined();
    expect(providerCalls).toBe(1);

    expect(data.source).toBe('walk_search_snapshot');
    expect(data.scope).toEqual({ worldId: WORLD, dim: DIM, sessionId: 'session-1' });
    expect(data.snapshotState).toBe('INSUFFICIENT_EVIDENCE');
    expect(data.items.map((item) => item.pos)).toEqual(CANDIDATES.map((spec) => spec.to));
    expect(data.total).toBe(3);
    expect(data.truncated).toBe(false);
    expect(data.snapshotTruncated).toBe(false);
    expect(data.unavailableHistoricalCount).toBe(0);
    expect(data.unavailableHistoricalTruncated).toBe(false);

    const [first, second, third] = data.items;
    expect(first?.id).toBe('frontier:overworld:1.5,0,0.5');
    expect(first?.stance).toEqual({ x: 0.5, y: 0, z: 0.5 });
    expect(first?.direction).toEqual({ axis: 'x', sign: 1 });
    expect(second?.direction).toEqual({ axis: 'z', sign: 1 });
    expect(third?.direction).toEqual({ axis: 'x', sign: 1 });
    expect(first?.gap).toEqual([{ x: 1.5, y: 0, z: 0.5 }]);
    expect(first?.gapCount).toBe(1);
    // Only the stance is OPEN-validated; the adjacent boundary cell is not.
    expect(first?.reachability).toBe('OPEN');
    expect(first?.boundaryReachability).toBe('unknown');
    expect(first?.historicalConnection).toBe('unknown');
    expect(first?.basis).toHaveLength(1);
    expect(first?.basis[0]?.state.name).toBe('air');
    expect(first?.computedAt).toBe(1000);
    expect(first?.validUntil).toBe(9000);
    expect(first?.ageMs).toBe(NOW - 1000);
    expect(third?.reason).toBe('wall face');
    // Unknown is represented by absence of a state, never by "air".
    expect('state' in (first ?? {})).toBe(false);
  });

  it('keeps ids stable across repeated queries and snapshots', () => {
    const first = dataOf(
      makeStore(() => makeSnapshot({ candidates: CANDIDATES })).store.query({
        kind: 'frontiers',
        dim: DIM,
        here: { x: 0.5, y: 0, z: 0.5 },
      }),
    );
    const later = dataOf(
      makeStore(() =>
        makeSnapshot({
          candidates: [...CANDIDATES].reverse(),
          state: 'BUDGET_EXHAUSTED',
        }),
      ).store.query({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5 } }),
    );

    const ids = new Map(first.items.map((item) => [JSON.stringify(item.pos), item.id]));
    for (const item of later.items) {
      expect(item.id).toBe(ids.get(JSON.stringify(item.pos)));
    }
  });

  it('distinguishes unavailable historical evidence from never-observed frontiers', () => {
    const snapshot = makeSnapshot({
      candidates: [],
      frontierLimitReached: true,
      unavailableHistoricalCount: 2,
      unavailableHistoricalTruncated: true,
    });
    const data = dataOf(
      makeStore(() => snapshot).store.query({
        kind: 'frontiers',
        dim: DIM,
        here: { x: 0.5, y: 0, z: 0.5 },
      }),
    );

    // No never-observed candidates does not mean "no unknown boundaries":
    // stale/unavailable saved-section evidence is reported separately.
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.snapshotTruncated).toBe(true);
    expect(data.staleCount).toBe(0);
    expect(data.diagnosticsTruncated).toBe(false);
    expect(data.unavailableHistoricalCount).toBe(2);
    expect(data.unavailableHistoricalTruncated).toBe(true);
    expect(data.unavailableHistoricalResidency).toEqual({
      not_resident: 0,
      loading: 0,
      load_failed: 0,
    });
  });

  it('summarizes STALE diagnostics and unavailable residency without mixing them into items', () => {
    const stale: WalkSearchDiagnostic = {
      stance: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 0.5, y: 0, z: -0.5 },
      status: 'STALE',
      reason: 'saved evidence stale',
      computedAt: 1000,
    };
    const blocked: WalkSearchDiagnostic = {
      ...stale,
      to: { x: -0.5, y: 0, z: 0.5 },
      status: 'BLOCKED',
    };
    const unavailable = (
      residencies: Array<'not_resident' | 'loading' | 'load_failed'>,
    ): WalkSearchUnavailableEvidence => ({
      stance: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 0, z: 0.5 },
      gap: [{ x: 1.5, y: 0, z: 0.5 }],
      sections: residencies.map((residency, index) => ({
        key: { worldId: WORLD, dim: DIM, cx: index, cz: 0, sy: 4 },
        residency,
      })),
      basis: [],
      reason: 'saved section unavailable',
      computedAt: 1000,
      validUntil: 9000,
    });
    const snapshot = makeSnapshot({
      candidates: [CANDIDATES[0]!],
      diagnostics: [stale, blocked],
      diagnosticsTruncated: true,
      unavailableHistorical: [
        unavailable(['not_resident']),
        unavailable(['loading', 'load_failed']),
      ],
    });

    const data = dataOf(
      makeStore(() => snapshot).store.query({
        kind: 'frontiers',
        dim: DIM,
        here: { x: 0.5, y: 0, z: 0.5 },
      }),
    );

    // `items` is never-observed candidates only; stale/blocked/unavailable
    // evidence is summarized, never promoted into candidates or into air.
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.staleCount).toBe(1);
    expect(data.diagnosticsTruncated).toBe(true);
    expect(data.unavailableHistoricalCount).toBe(2);
    expect(data.unavailableHistoricalResidency).toEqual({
      not_resident: 1,
      loading: 1,
      load_failed: 1,
    });
  });
});

describe('frontiers query — bounds and scope', () => {
  it('bounds the window by limit without reordering and reports total/truncated', () => {
    const snapshot = makeSnapshot({ candidates: CANDIDATES });
    const { store } = makeStore(() => snapshot);

    const limited = dataOf(
      store.query({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5 }, limit: 2 }),
    );
    expect(limited.items.map((item) => item.pos)).toEqual(CANDIDATES.slice(0, 2).map((spec) => spec.to));
    expect(limited.total).toBe(3);
    expect(limited.truncated).toBe(true);
    expect(limited.snapshotTruncated).toBe(false);

    const full = dataOf(
      store.query({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5 }, limit: 1000 }),
    );
    expect(full.items).toHaveLength(3);
    expect(full.truncated).toBe(false);
  });

  it('rejects out-of-range and non-integer limits', () => {
    const { store } = makeStore(() => makeSnapshot({ candidates: CANDIDATES }));
    for (const limit of [0, 1001, 1.5, Number.NaN, '2'] as unknown[]) {
      const request: unknown = {
        kind: 'frontiers',
        dim: DIM,
        here: { x: 0.5, y: 0, z: 0.5 },
        limit,
      };
      const result = store.query(request as SpatialQueryRequest);
      expect(result.status).toBe('invalid_request');
      expect(result.problem?.kind).toBe('invalid_request');
      expect(result.data).toBeUndefined();
    }
  });

  it('returns unsupported when no snapshot source or snapshot exists', () => {
    const withoutSource = makeStore(null).store.query({
      kind: 'frontiers',
      dim: DIM,
      here: { x: 0.5, y: 0, z: 0.5 },
    });
    expect(withoutSource.status).toBe('unsupported');
    expect(withoutSource.problem).toMatchObject({ kind: 'unsupported', query: 'frontiers' });
    expect(withoutSource.data).toBeUndefined();

    const withoutSnapshot = makeStore(() => null).store.query({
      kind: 'frontiers',
      dim: DIM,
      here: { x: 0.5, y: 0, z: 0.5 },
    });
    expect(withoutSnapshot.status).toBe('unsupported');
    expect(withoutSnapshot.problem?.kind).toBe('unsupported');
    expect(withoutSnapshot.data).toBeUndefined();
  });

  it('reports scope_mismatch for a snapshot from another world or dimension', () => {
    const otherWorld = makeStore(() => makeSnapshot({ worldId: 'other' })).store.query({
      kind: 'frontiers',
      dim: DIM,
      here: { x: 0.5, y: 0, z: 0.5 },
    });
    expect(otherWorld.status).toBe('scope_mismatch');
    expect(otherWorld.problem).toEqual({
      kind: 'scope_mismatch',
      expected: { worldId: WORLD, dim: DIM },
      actual: { worldId: 'other', dim: DIM },
    });
    expect(otherWorld.data).toBeUndefined();

    const otherDim = makeStore(() => makeSnapshot({ dim: 'the_nether' })).store.query({
      kind: 'frontiers',
      dim: DIM,
      here: { x: 0.5, y: 0, z: 0.5 },
    });
    expect(otherDim.status).toBe('scope_mismatch');
    expect(otherDim.problem).toMatchObject({
      kind: 'scope_mismatch',
      actual: { worldId: WORLD, dim: 'the_nether' },
    });
  });

  it('validates dim, here and rejects unknown fields', () => {
    const { store } = makeStore(() => makeSnapshot({ candidates: CANDIDATES }));
    const invalid = (request: unknown) => {
      const result = store.query(request as SpatialQueryRequest);
      expect(result.status).toBe('invalid_request');
      expect(result.problem?.kind).toBe('invalid_request');
    };

    invalid({ kind: 'frontiers', here: { x: 0.5, y: 0, z: 0.5 } });
    invalid({ kind: 'frontiers', dim: '', here: { x: 0.5, y: 0, z: 0.5 } });
    invalid({ kind: 'frontiers', dim: DIM });
    invalid({ kind: 'frontiers', dim: DIM, here: { x: Number.NaN, y: 0, z: 0.5 } });
    invalid({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5, w: 1 } });
    // No page cursor: the candidate set is bounded by the snapshot itself.
    invalid({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5 }, after: 'x' });

    const continuous = store.query({
      kind: 'frontiers',
      dim: DIM,
      here: { x: 0.25, y: 0.5, z: -0.75 },
    });
    expect(continuous.status).toBe('ok');
  });
});

describe('frontiers query — read-only and capability negotiation', () => {
  it('leaves map revisions, pins and residency unchanged and never runs a search', () => {
    const snapshot = makeSnapshot({ candidates: CANDIDATES });
    let providerCalls = 0;
    const { store, map } = makeStore((dim, here) => {
      providerCalls += 1;
      expect(dim).toBe(DIM);
      expect(here).toEqual({ x: 0.5, y: 0, z: 0.5 });
      return snapshot;
    });
    const capture = () => ({
      saveRevision: map.saveRevision,
      pins: map.pinState(),
      residency: map.residentSize(),
      cell: map.cellAt(DIM, 0, 0, 0),
      section: map.sectionAt(DIM, 0, 0, 0),
    });
    const before = capture();

    store.query({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5 } });
    store.query({ kind: 'frontiers', dim: DIM, here: { x: 0.5, y: 0, z: 0.5 } });

    expect(capture()).toEqual(before);
    // One projection per query; nothing is started or advanced.
    expect(providerCalls).toBe(2);
  });

  it('reports query.frontiers only when the snapshot source is wired', () => {
    const without = makeStore(null).store.query({ kind: 'capabilities' });
    if (without.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    expect(without.data.capabilities.query.frontiers).toBe(false);

    const withSource = makeStore(() => makeSnapshot({ candidates: CANDIDATES })).store.query({
      kind: 'capabilities',
    });
    if (withSource.data?.kind !== 'capabilities') throw new Error('expected capabilities');
    expect(withSource.data.capabilities.query.frontiers).toBe(true);
  });
});
