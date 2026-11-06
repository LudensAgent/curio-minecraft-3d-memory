/**
 * Query capability and snapshot handlers (contract §2.3, plan M2.6).
 *
 * The capability report is derived from what the current in-memory store can
 * actually do. Domains that are not implemented stay `false`; they are not
 * optimistic placeholders.
 */

import type { MemoryHostCapabilities } from '../memory/capabilities.js';
import { CONTRACT_VERSION } from '../memory/capabilities.js';
import { makeQueryResult } from './envelope.js';
import type { SpatialQueryContext, SpatialQueryResult } from './types.js';

export function buildMemoryHostCapabilities(
  context: SpatialQueryContext,
): MemoryHostCapabilities {
  const memory = context.sources.memoryCapabilities();
  const available = (name: keyof typeof memory): boolean => memory[name].available;
  return {
    contract: CONTRACT_VERSION,
    memory: {
      observeBatch: available('observeBatch'),
      beginSession: available('beginSession'),
      markStale: available('markStale'),
      markTraversed: available('markTraversed'),
      markModified: available('markModified'),
      saveFragment: available('saveFragment'),
      addTraversal: available('addTraversal'),
      recordNode: available('recordNode'),
      upsertEdge: available('upsertEdge'),
      savePortalEdge: available('savePortalEdge'),
      // The in-memory store has no persistence lifecycle methods.
      checkpoint: false,
      flush: false,
      close: false,
    },
    query: {
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
      containerAnchors: context.isContainer !== undefined,
      containerContents: false,
    },
    // M3 planning is present in this package. These are static capability
    // facts, not optimistic placeholders; the wider planning modes remain false.
    plan: {
      walkSearch: true,
      walkHistory: true,
      walkAuto: true,
      nearArrival: false,
      reachBlockArrival: false,
      digPlaceTower: false,
      swim: false,
      boat: false,
    },
    execute: {
      walk: false,
      groundedArrival: false,
      invalidation: false,
      cancellation: false,
      swim: false,
      boat: false,
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
  return makeQueryResult(context, {
    status: 'ok',
    data: { kind: 'snapshot', snapshot: context.sources.snapshot() },
  });
}

export function queryCapabilities(context: SpatialQueryContext): SpatialQueryResult {
  return makeQueryResult(context, {
    status: 'ok',
    data: { kind: 'capabilities', capabilities: buildMemoryHostCapabilities(context) },
  });
}
