import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION } from '../src/memory/capabilities.js';
import type { MemoryHostCapabilities } from '../src/memory/capabilities.js';
import type { SpatialQueryResult } from '../src/query/types.js';
import { captureStoreState, makeQueryParts, runQuery } from './query-fixtures.js';

function capabilitiesOf(result: SpatialQueryResult): MemoryHostCapabilities {
  expect(result.status).toBe('ok');
  expect(result.data?.kind).toBe('capabilities');
  if (result.data?.kind !== 'capabilities') throw new Error('expected capabilities data');
  return result.data.capabilities;
}

describe('query capabilities', () => {
  it('reports the contract version and honest memory write capabilities', () => {
    const parts = makeQueryParts();
    const capabilities = capabilitiesOf(runQuery(parts, { kind: 'capabilities' }));

    expect(capabilities.contract).toBe(CONTRACT_VERSION);
    expect(capabilities.contract).toBe('memory-host-contract/1');
    expect(capabilities.memory).toEqual({
      observeBatch: true,
      beginSession: true,
      markStale: true,
      markTraversed: true,
      markModified: true,
      saveFragment: true,
      addTraversal: true,
      recordNode: true,
      upsertEdge: true,
      savePortalEdge: true,
      checkpoint: false,
      flush: false,
      close: false,
    });
  });

  it('reports implemented query kinds and the container boundary', () => {
    const parts = makeQueryParts();
    const capabilities = capabilitiesOf(runQuery(parts, { kind: 'capabilities' }));

    expect(capabilities.query).toEqual({
      cells: true,
      fragments: true,
      traversals: true,
      nodes: true,
      edges: true,
      historyRoute: true,
      anchors: true,
      components: true,
      segments: true,
      portals: true,
      resourceAnchors: true,
      containerAnchors: false,
      containerContents: false,
    });
  });

  it('enables containerAnchors only when the host injects a classifier', () => {
    const parts = makeQueryParts();
    const withClassifier = capabilitiesOf(
      runQuery(parts, { kind: 'capabilities' }, { isContainer: () => true }),
    );
    expect(withClassifier.query.containerAnchors).toBe(true);
    // Contents stay host-owned regardless of classification.
    expect(withClassifier.query.containerContents).toBe(false);
  });

  it('keeps unimplemented plan, execute, and persistence domains false', () => {
    const parts = makeQueryParts();
    const capabilities = capabilitiesOf(runQuery(parts, { kind: 'capabilities' }));

    expect(Object.values(capabilities.plan).some(Boolean)).toBe(false);
    expect(Object.values(capabilities.execute).some(Boolean)).toBe(false);
    expect(Object.values(capabilities.persistence).some(Boolean)).toBe(false);
  });

  it('returns a read-only snapshot with the same capability report', () => {
    const parts = makeQueryParts();
    const before = captureStoreState(parts);
    const result = runQuery(parts, { kind: 'snapshot' });

    expect(result.status).toBe('ok');
    expect(result.readOnly).toBe(true);
    expect(result.executable).toBe(false);
    if (result.data?.kind !== 'snapshot') throw new Error('expected snapshot data');
    expect(result.data.snapshot.worldId).toBe('world');
    expect(result.data.snapshot.voxel.saveRevision).toBe(parts.map.saveRevision);
    expect(result.data.snapshot.fragments).toEqual({ revision: 0, total: 0 });
    expect(result.data.snapshot.topology).toEqual({ revision: 0, nodes: 0, edges: 0 });
    expect(captureStoreState(parts)).toEqual(before);
  });

  it('does not change state when reporting capabilities twice', () => {
    const parts = makeQueryParts();
    const before = captureStoreState(parts);
    runQuery(parts, { kind: 'capabilities' });
    runQuery(parts, { kind: 'capabilities' }, { isContainer: () => true });
    expect(captureStoreState(parts)).toEqual(before);
  });
});
