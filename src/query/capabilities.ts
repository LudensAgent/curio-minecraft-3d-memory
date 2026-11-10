/**
 * Query capability and snapshot handlers (contract §2.3, plan M2.6).
 *
 * The capability report is derived from what the current in-memory store can
 * actually do. Domains that are not implemented stay `false`; they are not
 * optimistic placeholders.
 */

import type { MemoryHostCapabilities, RoutePlanCapabilities } from '../memory/capabilities.js';
import {
  CONTRACT_VERSION,
  ROUTE_PLAN_CAPABILITIES,
} from '../memory/capabilities.js';
import { makeQueryResult, unsupportedQueryResult } from './envelope.js';
import { SPATIAL_MEMORY_CAPABILITY_NAMES } from './types.js';
import type { SpatialMemoryCapabilities, SpatialQueryContext, SpatialQueryResult } from './types.js';

/**
 * Planning/route history is a capability of a composition that actually
 * carries the legacy route stores. A voxel+facts production composition reports
 * the retired route entries as false instead of advertising the package's
 * compatibility surface.
 */
const NO_ROUTE_PLAN_CAPABILITIES: RoutePlanCapabilities = Object.freeze({
  walkSearch: false,
  walkHistory: false,
  walkAuto: false,
  nearArrival: false,
  reachBlockArrival: false,
  digPlaceTower: false,
  swim: false,
  boat: false,
});

export function buildMemoryHostCapabilities(
  context: SpatialQueryContext,
): MemoryHostCapabilities {
  const memory = context.sources.memoryCapabilities?.() ?? (Object.fromEntries(
    SPATIAL_MEMORY_CAPABILITY_NAMES.map((name) => [name, { available: false }]),
  ) as SpatialMemoryCapabilities);
  const available = (name: keyof typeof memory): boolean => memory[name].available;
  const facts = context.sources.facts !== undefined;
  const topology = context.sources.topology !== undefined;
  const fragments = context.sources.fragments !== undefined;
  const history = context.sources.history !== undefined;
  const routeMemory = fragments && topology && history;
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
      fragments: routeMemory,
      traversals: routeMemory,
      nodes: facts || topology,
      edges: routeMemory,
      historyRoute: routeMemory,
      anchors: routeMemory,
      components: routeMemory,
      segments: routeMemory,
      portals: routeMemory,
      resourceAnchors: facts || topology,
      containerAnchors: facts || context.isContainer !== undefined,
      // Available only when the host injected the caller-supplied snapshot
      // source; the library never starts a search of its own.
      frontiers: context.sources.frontiers !== undefined,
      containerContents: false,
    },
    // M3 planning is present in this package. Reference the single source in
    // `src/memory/capabilities.ts` directly (D-010) so the report and the
    // constant cannot drift; the constant is frozen against host mutation.
    // The route-plan block only applies when the route stores are composed.
    plan: routeMemory ? ROUTE_PLAN_CAPABILITIES : NO_ROUTE_PLAN_CAPABILITIES,
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
