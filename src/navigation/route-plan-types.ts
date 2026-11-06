/**
 * Optional read-only route-planning contract (contract §6, implementation plan
 * M3.1).
 *
 * A route plan is *evidence*: the ordered stance sequence a bounded search or a
 * named historical fragment currently supports, plus the facts that limit it.
 * It is never an arrival, never an authorization and never a movement request.
 * `executable` is true only for a fully re-verified, currently OPEN route whose
 * measured start and requested target both match; the volatile `routeId` is
 * issued by a bounded `RoutePlanRegistrar` and consumed by the execution layer.
 *
 * This module is part of the optional navigation layer. It does not import the
 * memory core's write path, the adapter body ports, or any movement executor.
 */

import type { BodySample } from '../execution/types.js';
import type { ObservationGap } from '../observation/types.js';
import type { PathFragment } from '../topology/path-fragment.js';
import type { FragmentStore } from '../topology/fragment-store.js';
import type { CollisionShapeProvider } from '../traversability/collision-shape.js';
import type { RouteVerifier } from '../traversability/route.js';
import type { BodyContext } from '../traversability/step.js';
import type { MoveMode, Vec3Like, WorldScope } from '../types.js';
import type { SectionKey } from '../voxel/section.js';
import type { RouteSearchSource } from './route-search.js';
import type { ArrivalSpec, NavProblem } from './types.js';

/** Which planning backend `planRoute` should use. */
export type RoutePlanSource = 'auto' | 'search' | 'history';

/** Delegation constraints accepted by planning; non-empty `avoid` is rejected in v1. */
export interface RoutePlanConstraints {
  avoid?: Vec3Like[];
  maxNodes?: number;
  maxEdges?: number;
}

/** Absolute continuous feet position the host already resolved from a name/direction. */
export interface RoutePlanRequest {
  to: Vec3Like;
  /** v1 accepts `walk` only; runtime validation rejects any other value structurally. */
  mode: 'walk';
  source: RoutePlanSource;
  /** Required by `source:'history'` and by `source:'auto'` when history should be preferred. */
  pathId?: string;
  /** v1 accepts exact foot-position completion only. */
  arrival: { kind: 'exact' };
  constraints?: RoutePlanConstraints;
  /** Absolute deadline in epoch ms; must be finite and in the future. */
  deadlineMs: number;
}

/** A plan segment (contract §6.4 `RouteSegment`); v1 walk plans use one segment. */
export interface RoutePlanSegment {
  index: number;
  mode: 'walk';
  points: Vec3Like[];
  cost: number;
}

/**
 * One factual boundary of a plan. It is not an automatic dig/place/explore
 * queue: the Agent decides whether and how to handle it.
 */
export interface RouteBoundary {
  kind: 'blocked' | 'unknown' | 'stale' | 'unobserved' | 'unsupported' | 'budget';
  status: 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED';
  stance?: Vec3Like;
  to?: Vec3Like;
  reason: string;
  /** Evidence scope/time for the boundary; absent means unknown, never fabricated. */
  evidence?: RouteEvidence;
}

/** Structured planning capability gap. Never collapsed into "no path". */
export type RouteUnsupported =
  | { kind: 'unsupported_mode'; mode: MoveMode; detail: string }
  | { kind: 'unsupported_arrival'; arrival: ArrivalSpec; detail: string }
  | { kind: 'unsupported_constraint'; constraint: string; detail: string }
  | { kind: 'unsupported_geometry'; detail: string }
  | { kind: 'unobserved'; gap: ObservationGap }
  | { kind: 'budget_exhausted'; limit: 'nodes' | 'edges' | 'points' | 'time'; detail: string }
  | { kind: 'not_authorized'; detail: string }
  | { kind: 'scope_mismatch'; detail: string };

/** Evidence scope and validity a plan rests on. */
export interface RouteEvidence {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Earliest validity of the evidence the plan used; re-check before execution. */
  validUntil: number;
  /** Collision/rule version; a change invalidates the plan. */
  ruleVersion: string;
  /** Section versions the verification read (diagnostic/invalidation aid). */
  dependencies?: { key: SectionKey; revision: number }[];
}

/** A currently supported route plus its limits. `executable` is not authorization. */
export interface RoutePlan {
  /** Volatile handle issued by the plan registry; never persisted or self-issued by a host. */
  routeId: string;
  backend: 'spatial_library';
  source: 'search' | 'history';
  /** Historical fragment kind when `source:'history'`; never a movement mode. */
  kind?: PathFragment['kind'];
  points: Vec3Like[];
  segments: RoutePlanSegment[];
  cost: number;
  confidence: 'verified' | 'candidate';
  /** True only for a fully verified plan; a `candidate` is never executable. */
  executable: boolean;
  boundaries: RouteBoundary[];
  unsupported?: RouteUnsupported;
  evidence: RouteEvidence;
  expiresAt: number;
  pathId?: string;
  verdict?: 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE';
  requestedTarget: Vec3Like;
  resolvedTarget: Vec3Like;
  /** Measured feet position at planning time; the execution layer must re-check it. */
  start: Vec3Like;
}

/** The registry-issued part of a plan is added by the registrar. */
export type RoutePlanDraft = Omit<RoutePlan, 'routeId'>;

/** Narrow issuance seam so planning does not depend on registry storage details. */
export interface RoutePlanRegistrar {
  /** Issue a volatile `routeId` and retain the plan under it. */
  register(plan: RoutePlanDraft): RoutePlan;
}

export interface RoutePlanResult {
  plan?: RoutePlan;
  problem?: NavProblem | RouteUnsupported;
  /** Human-readable counterpart to `problem`; never a world-fact claim. */
  message?: string;
}

/** Caller-supplied environment; the library holds no bot, map or registry singleton. */
export interface RoutePlanEnvironment {
  worldId: string;
  dim: string;
  sessionId: string;
  /** Body dimensions/pose; `feet` is replaced by the measured sample. */
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  /** Latest measured body sample for this world/dim/session; `null` fails planning. */
  sample(): BodySample | null;
  /** Known-space search source; required by `source:'search'` and `source:'auto'`. */
  search?: RouteSearchSource;
  /** History source; required by `source:'history'` and by `auto` with `pathId`. */
  history?: FragmentStore;
  /**
   * Dedicated read-only verifier bound to the same map. Planning never searches
   * or writes through it; the caller should not share the execution verifier.
   */
  verifier: RouteVerifier;
  /** Issues the volatile route handle. */
  registry: RoutePlanRegistrar;
  /** Clock for evidence expiry/deadline; defaults to `Date.now`. */
  now?: () => number;
  /** Maximum edge evaluations in one slice; defaults to 256. */
  budgetPerSlice?: number;
  /** Plan lifetime cap in ms from the planning clock; defaults to 30 000. */
  planTtlMs?: number;
  /** Maximum ordered points a plan may carry; defaults to 1024. */
  maxRoutePoints?: number;
  /** Cooperative yield between slices; defaults to a macrotask. */
  wait?: () => Promise<void>;
  signal?: AbortSignal;
  cancellationOrigin?: CancellationOrigin;
}

/** Provenance of a caller-initiated stop; never guessed from timing. */
export type CancellationOrigin = 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';

/** Route binding checked by the registry before consumption. */
export interface RoutePlanScope extends WorldScope {
  /** The planning session is always part of the route binding. */
  sessionId: string;
}
