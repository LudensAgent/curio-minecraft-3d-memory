/**
 * Query capability and snapshot handlers (contract §2.3).
 *
 * The capability report describes exactly the callable voxel + facts surface.
 * Retired fragment/topology/route entries are absent, not reported as `false`
 * compatibility placeholders, and no capability block is composed from a
 * legacy store even when one happens to exist in the process.
 */

import type { MemoryHostCapabilities } from '../memory/capabilities.js';
import { CONTRACT_VERSION } from '../memory/capabilities.js';
import { makeQueryResult, unsupportedQueryResult } from './envelope.js';
import type { SpatialQueryContext, SpatialQueryResult } from './types.js';

export function buildMemoryHostCapabilities(
  context: SpatialQueryContext,
): MemoryHostCapabilities {
  const memory = context.sources.memoryCapabilities?.() ?? {
    observeBatch: false,
    beginSession: false,
    markStale: false,
    markTraversed: false,
    markModified: false,
    checkpoint: false,
    flush: false,
    close: false,
  };
  const facts = context.sources.facts !== undefined;
  return {
    contract: CONTRACT_VERSION,
    memory,
    query: {
      cells: true,
      nodes: facts,
      places: facts,
      resourceAnchors: facts,
      containerAnchors: facts,
      containerContents: false,
      snapshot: context.sources.snapshot !== undefined,
      capabilities: true,
    },
    persistence: {
      sqlite: false,
      manualResidency: false,
      workingSet: false,
      migrationAuthoritySwitch: false,
    },
  };
}

export function querySnapshot(context: SpatialQueryContext): SpatialQueryResult {
  const snapshot = context.sources.snapshot;
  if (snapshot === undefined) {
    return unsupportedQueryResult(
      context,
      'snapshot',
      'this query composition does not expose a runtime snapshot',
    );
  }
  return makeQueryResult(context, {
    status: 'ok',
    data: { kind: 'snapshot', snapshot: snapshot() },
  });
}

export function queryCapabilities(context: SpatialQueryContext): SpatialQueryResult {
  return makeQueryResult(context, {
    status: 'ok',
    data: { kind: 'capabilities', capabilities: buildMemoryHostCapabilities(context) },
  });
}
