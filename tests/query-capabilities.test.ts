import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION } from '../src/memory/capabilities.js';
import type { MemoryHostCapabilities } from '../src/memory/capabilities.js';
import type { SpatialQueryResult } from '../src/query/types.js';
import { runSpatialQuery } from '../src/query/index.js';
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
    expect(capabilities.contract).toBe('memory-host-contract/2');
    expect(capabilities.memory).toEqual({
      observeBatch: true,
      beginSession: true,
      markStale: true,
      markTraversed: true,
      markModified: true,
      checkpoint: false,
      flush: false,
      close: false,
    });
  });

  it('advertises only the voxel + facts query surface', () => {
    const parts = makeQueryParts();
    const capabilities = capabilitiesOf(runQuery(parts, { kind: 'capabilities' }));

    expect(capabilities.query).toEqual({
      cells: true,
      nodes: true,
      places: true,
      resourceAnchors: true,
      containerAnchors: true,
      containerContents: false,
      snapshot: false,
      capabilities: true,
    });
    expect(capabilities).not.toHaveProperty('plan');
  });

  it('reports no semantic kinds when facts are absent', () => {
    const parts = makeQueryParts();
    const sources = {
      worldId: 'world',
      currentSessionId: () => null,
      cellAt: parts.map.cellAt.bind(parts.map),
      residencyAt: () => 'no_record' as const,
    };
    const result = runSpatialQuery(sources, { kind: 'capabilities' });
    const capabilities = capabilitiesOf(result);
    expect(capabilities.query.nodes).toBe(false);
    expect(capabilities.query.places).toBe(false);
    expect(capabilities.query.containerContents).toBe(false);
  });

  it('does not change state when reporting capabilities twice', () => {
    const parts = makeQueryParts();
    const before = captureStoreState(parts);
    runQuery(parts, { kind: 'capabilities' });
    runQuery(parts, { kind: 'capabilities' });
    expect(captureStoreState(parts)).toEqual(before);
  });
});
