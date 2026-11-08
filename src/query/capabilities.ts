/**
 * Query capability and snapshot handlers (contract §2.3, plan M2.6).
 *
 * The capability report is derived from what the current in-memory store can
 * actually do. Domains that are not implemented stay `false`; they are not
 * optimistic placeholders.
 */

import type { MemoryHostCapabilities } from '../memory/capabilities.js';
import {
  CONTRACT_VERSION,
  ROUTE_PLAN_CAPABILITIES,
} from '../memory/capabilities.js';
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
    // M3 planning is present in this package. Reference the single source in
    // `src/memory/capabilities.ts` directly (D-010) so the report and the
    // constant cannot drift; the constant is frozen against host mutation.
    plan: ROUTE_PLAN_CAPABILITIES,
    // These four entries have real runtime implementations in this package:
    // WalkRouteExecutor + walkPath (walk), measured grounded arrival,
    // ChangeReport-driven current-segment invalidation, and delegation-scoped
    // cancellation. Reporting `true` is a library fact; the host must still
    // intersect it with its own wiring via `composeCapabilities`. Swim/boat
    // execution remain false (geometry validation only).
    execute: {
      walk: true,
      groundedArrival: true,
      invalidation: true,
      cancellation: true,
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
