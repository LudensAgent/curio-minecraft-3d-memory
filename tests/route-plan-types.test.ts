import { describe, expect, expectTypeOf, it } from 'vitest';

import * as navigation from '../src/navigation/index.js';
import {
  planRoute,
  ROUTE_PLAN_CAPABILITIES,
  RoutePlanRegistryImpl,
} from '../src/index.js';
import type {
  RouteBoundary,
  RouteBoundaryFact,
  RouteEvidence,
  RoutePlan,
  RoutePlanCapabilities,
  RoutePlanRequest,
  RoutePlanResult,
  RoutePlanSegment,
  RoutePlanSource,
  RouteUnsupported,
} from '../src/index.js';

describe('M3.1 route plan types', () => {
  it('exports the planning runtime entry and registry from the navigation and root entries', () => {
    expect(typeof planRoute).toBe('function');
    expect(typeof RoutePlanRegistryImpl).toBe('function');
    expect(typeof navigation.planRoute).toBe('function');
    expect(typeof navigation.RoutePlanRegistryImpl).toBe('function');
    expect(typeof navigation.createWalkRouteSearchSource).toBe('function');
  });

  it('keeps the contract field shapes', () => {
    expectTypeOf<RoutePlanSource>().toEqualTypeOf<'auto' | 'search' | 'history'>();
    expectTypeOf<RoutePlan['backend']>().toEqualTypeOf<'spatial_library'>();
    expectTypeOf<RoutePlan['source']>().toEqualTypeOf<'search' | 'history'>();
    expectTypeOf<RoutePlan['confidence']>().toEqualTypeOf<'verified' | 'candidate'>();
    expectTypeOf<RoutePlan['segments']>().toEqualTypeOf<RoutePlanSegment[]>();
    expectTypeOf<RoutePlanSegment['mode']>().toEqualTypeOf<'walk'>();
    expectTypeOf<RoutePlanRequest['arrival']['kind']>().toEqualTypeOf<'exact'>();
    expectTypeOf<RouteBoundary['kind']>().toEqualTypeOf<
      'blocked' | 'unknown' | 'stale' | 'unobserved' | 'unsupported' | 'budget'
    >();
    expectTypeOf<RouteEvidence>().toHaveProperty('validUntil');
    expectTypeOf<RouteEvidence>().toHaveProperty('ruleVersion');
    expectTypeOf<RoutePlanResult>().toHaveProperty('plan');
    expectTypeOf<RoutePlanResult>().toHaveProperty('problem');
    expectTypeOf<RouteUnsupported['kind']>().toEqualTypeOf<
      | 'unsupported_mode'
      | 'unsupported_arrival'
      | 'unsupported_constraint'
      | 'unsupported_geometry'
      | 'unobserved'
      | 'budget_exhausted'
      | 'not_authorized'
      | 'scope_mismatch'
    >();
    expectTypeOf<RoutePlanCapabilities>().toEqualTypeOf<{
      walkSearch: boolean;
      walkHistory: boolean;
      walkAuto: boolean;
      nearArrival: boolean;
      reachBlockArrival: boolean;
      digPlaceTower: boolean;
      swim: boolean;
      boat: boolean;
    }>();
    // The navigation-layer boundary type remains distinct from the topology
    // `RouteBoundaryFact` projection.
    expectTypeOf<RouteBoundary>().not.toEqualTypeOf<RouteBoundaryFact>();
  });

  it('reports implemented walk planning and unimplemented wider capabilities', () => {
    expect(ROUTE_PLAN_CAPABILITIES).toEqual({
      walkSearch: true,
      walkHistory: true,
      walkAuto: true,
      nearArrival: false,
      reachBlockArrival: false,
      digPlaceTower: false,
      swim: false,
      boat: false,
    });
  });
});
