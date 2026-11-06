/**
 * Strict runtime validation for `SpatialQueryRequest` (contract §2.1/§5.6).
 *
 * TypeScript types are erased; a host or tool can still send an unknown field,
 * a non-integer cell, an over-limit page, or an unknown query kind. This module
 * is the single boundary that turns those into a structured `invalid_request`
 * detail before any store method is called. Handlers therefore receive an
 * already-validated request and do not repeat these checks.
 */

import { MAX_QUERY_LIMIT } from './paging.js';
import type { SpatialQueryKind, SpatialQueryRequest } from './types.js';
import type { Vec3Like } from '../types.js';

export const MAX_CELL_POSITIONS = 4096;

const QUERY_KINDS: readonly SpatialQueryKind[] = [
  'cells',
  'fragments',
  'traversals',
  'nodes',
  'edges',
  'historyRoute',
  'anchor',
  'components',
  'segments',
  'portals',
  'resourceAnchors',
  'containerAnchors',
  'containerContents',
  'snapshot',
  'capabilities',
];

const FRAGMENT_KINDS = ['dug', 'walked', 'bridge', 'built'] as const;
const GEOMETRY_SOURCES = ['traversal', 'observed_structure', 'legacy'] as const;
const LANDMARK_TAGS = [
  'base',
  'resource',
  'danger',
  'discovery',
  'death',
  'waypoint',
  'herd',
  'portal',
] as const;
const NODE_SOURCES = ['agent', 'program'] as const;
const CONNECTION_TYPES = [
  'HORIZONTAL',
  'STAIRCASE',
  'VERTICAL_SHAFT',
  'LADDER',
  'BRIDGE',
  'DROP',
  'CLIMB',
  'SWIM',
  'CAVE_PASSAGE',
  'PORTAL',
] as const;
const EDGE_BASES = ['candidate', 'traversed'] as const;
const ANCHOR_ORDERS = ['surface', 'deepest'] as const;

const ALLOWED_FIELDS: Record<SpatialQueryKind, readonly string[]> = {
  cells: ['kind', 'dim', 'positions'],
  fragments: ['kind', 'dim', 'fragmentKind', 'geometrySource', 'after', 'limit'],
  traversals: ['kind', 'dim', 'fragmentId', 'after', 'limit'],
  nodes: ['kind', 'dim', 'tag', 'label', 'source', 'after', 'limit'],
  edges: ['kind', 'dim', 'from', 'to', 'type', 'basis', 'after', 'limit'],
  historyRoute: ['kind', 'dim', 'from', 'to', 'near'],
  anchor: ['kind', 'dim', 'here', 'order', 'near'],
  components: ['kind', 'dim'],
  segments: ['kind', 'fragmentId'],
  portals: ['kind', 'after', 'limit'],
  resourceAnchors: ['kind', 'dim', 'tag', 'label', 'after', 'limit'],
  containerAnchors: ['kind', 'dim', 'after', 'limit'],
  containerContents: ['kind', 'dim', 'nodeId'],
  snapshot: ['kind'],
  capabilities: ['kind'],
};

export type RequestValidation =
  | { ok: true; request: SpatialQueryRequest }
  | { ok: false; detail: string };

type Field<T> = { ok: true; value: T | undefined } | { ok: false; detail: string };

function fail(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

function ok(request: SpatialQueryRequest): { ok: true; request: SpatialQueryRequest } {
  return { ok: true, request };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownFieldError(
  object: Record<string, unknown>,
  kind: SpatialQueryKind,
): string | null {
  const allowed = ALLOWED_FIELDS[kind];
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      return `unknown field "${key}" for query kind "${kind}"`;
    }
  }
  return null;
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  what: string,
): { ok: true; value: string } | { ok: false; detail: string } {
  const value = object[key];
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${what} must be a non-empty string`);
  }
  return { ok: true, value };
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  what: string,
): Field<string> {
  const value = object[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${what} must be a non-empty string when present`);
  }
  return { ok: true, value };
}

function optionalEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  what: string,
): Field<T> {
  const value = object[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return fail(`${what} must be one of: ${allowed.join(', ')}`);
  }
  return { ok: true, value: value as T };
}

function requiredEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  what: string,
): { ok: true; value: T } | { ok: false; detail: string } {
  const result = optionalEnum(object, key, allowed, what);
  if (!result.ok) return result;
  if (result.value === undefined) {
    return fail(`${what} is required and must be one of: ${allowed.join(', ')}`);
  }
  return { ok: true, value: result.value };
}

function optionalLimit(object: Record<string, unknown>): Field<number> {
  const value = object.limit;
  if (value === undefined) return { ok: true, value: undefined };
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_QUERY_LIMIT
  ) {
    return fail(`limit must be an integer in [1, ${MAX_QUERY_LIMIT}]`);
  }
  return { ok: true, value };
}

function optionalNear(object: Record<string, unknown>): Field<number> {
  const value = object.near;
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fail('near must be a finite non-negative number');
  }
  return { ok: true, value };
}

function isPoint(value: unknown, integer: boolean): value is Vec3Like {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'x' && key !== 'y' && key !== 'z')) return false;
  const x = value.x;
  const y = value.y;
  const z = value.z;
  const valid = (component: unknown): component is number =>
    typeof component === 'number' &&
    Number.isFinite(component) &&
    (!integer || Number.isInteger(component));
  return valid(x) && valid(y) && valid(z);
}

function requiredPoint(
  object: Record<string, unknown>,
  key: string,
  what: string,
  integer: boolean,
): { ok: true; value: Vec3Like } | { ok: false; detail: string } {
  const value = object[key];
  if (!isPoint(value, integer)) {
    return fail(
      integer
        ? `${what} must have finite integer x, y, z and no other fields`
        : `${what} must have finite x, y, z and no other fields`,
    );
  }
  return { ok: true, value: { x: value.x, y: value.y, z: value.z } };
}

function validateCells(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = requiredString(object, 'dim', 'cells.dim');
  if (!dim.ok) return dim;
  const positions = object.positions;
  if (!Array.isArray(positions)) {
    return fail('cells.positions must be an array of block positions');
  }
  if (positions.length > MAX_CELL_POSITIONS) {
    return fail(`cells.positions must contain at most ${MAX_CELL_POSITIONS} positions`);
  }
  const points: Vec3Like[] = [];
  for (let index = 0; index < positions.length; index++) {
    const point = requiredPoint({ pos: positions[index] }, 'pos', `cells.positions[${index}]`, true);
    if (!point.ok) return point;
    points.push(point.value);
  }
  return ok({ kind: 'cells', dim: dim.value, positions: points });
}

function validateFragments(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'fragments.dim');
  if (!dim.ok) return dim;
  const fragmentKind = optionalEnum(object, 'fragmentKind', FRAGMENT_KINDS, 'fragments.fragmentKind');
  if (!fragmentKind.ok) return fragmentKind;
  const geometrySource = optionalEnum(
    object,
    'geometrySource',
    GEOMETRY_SOURCES,
    'fragments.geometrySource',
  );
  if (!geometrySource.ok) return geometrySource;
  const after = optionalString(object, 'after', 'fragments.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'fragments',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(fragmentKind.value === undefined ? {} : { fragmentKind: fragmentKind.value }),
    ...(geometrySource.value === undefined ? {} : { geometrySource: geometrySource.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateTraversals(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'traversals.dim');
  if (!dim.ok) return dim;
  const fragmentId = optionalString(object, 'fragmentId', 'traversals.fragmentId');
  if (!fragmentId.ok) return fragmentId;
  const after = optionalString(object, 'after', 'traversals.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'traversals',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(fragmentId.value === undefined ? {} : { fragmentId: fragmentId.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateNodes(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'nodes.dim');
  if (!dim.ok) return dim;
  const tag = optionalEnum(object, 'tag', LANDMARK_TAGS, 'nodes.tag');
  if (!tag.ok) return tag;
  const label = optionalString(object, 'label', 'nodes.label');
  if (!label.ok) return label;
  const source = optionalEnum(object, 'source', NODE_SOURCES, 'nodes.source');
  if (!source.ok) return source;
  const after = optionalString(object, 'after', 'nodes.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'nodes',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(tag.value === undefined ? {} : { tag: tag.value }),
    ...(label.value === undefined ? {} : { label: label.value }),
    ...(source.value === undefined ? {} : { source: source.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateEdges(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'edges.dim');
  if (!dim.ok) return dim;
  const from = optionalString(object, 'from', 'edges.from');
  if (!from.ok) return from;
  const to = optionalString(object, 'to', 'edges.to');
  if (!to.ok) return to;
  const type = optionalEnum(object, 'type', CONNECTION_TYPES, 'edges.type');
  if (!type.ok) return type;
  const basis = optionalEnum(object, 'basis', EDGE_BASES, 'edges.basis');
  if (!basis.ok) return basis;
  const after = optionalString(object, 'after', 'edges.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'edges',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(from.value === undefined ? {} : { from: from.value }),
    ...(to.value === undefined ? {} : { to: to.value }),
    ...(type.value === undefined ? {} : { type: type.value }),
    ...(basis.value === undefined ? {} : { basis: basis.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateHistoryRoute(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = requiredString(object, 'dim', 'historyRoute.dim');
  if (!dim.ok) return dim;
  const from = requiredPoint(object, 'from', 'historyRoute.from', false);
  if (!from.ok) return from;
  const to = requiredPoint(object, 'to', 'historyRoute.to', false);
  if (!to.ok) return to;
  const near = optionalNear(object);
  if (!near.ok) return near;
  return ok({
    kind: 'historyRoute',
    dim: dim.value,
    from: from.value,
    to: to.value,
    ...(near.value === undefined ? {} : { near: near.value }),
  });
}

function validateAnchor(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = requiredString(object, 'dim', 'anchor.dim');
  if (!dim.ok) return dim;
  const here = requiredPoint(object, 'here', 'anchor.here', false);
  if (!here.ok) return here;
  const order = requiredEnum(object, 'order', ANCHOR_ORDERS, 'anchor.order');
  if (!order.ok) return order;
  const near = optionalNear(object);
  if (!near.ok) return near;
  return ok({
    kind: 'anchor',
    dim: dim.value,
    here: here.value,
    order: order.value,
    ...(near.value === undefined ? {} : { near: near.value }),
  });
}

function validateComponents(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = requiredString(object, 'dim', 'components.dim');
  if (!dim.ok) return dim;
  return ok({ kind: 'components', dim: dim.value });
}

function validateSegments(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const fragmentId = requiredString(object, 'fragmentId', 'segments.fragmentId');
  if (!fragmentId.ok) return fragmentId;
  return ok({ kind: 'segments', fragmentId: fragmentId.value });
}

function validatePortals(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const after = optionalString(object, 'after', 'portals.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'portals',
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateResourceAnchors(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'resourceAnchors.dim');
  if (!dim.ok) return dim;
  const tag = optionalEnum(object, 'tag', LANDMARK_TAGS, 'resourceAnchors.tag');
  if (!tag.ok) return tag;
  const label = optionalString(object, 'label', 'resourceAnchors.label');
  if (!label.ok) return label;
  const after = optionalString(object, 'after', 'resourceAnchors.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'resourceAnchors',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(tag.value === undefined ? {} : { tag: tag.value }),
    ...(label.value === undefined ? {} : { label: label.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateContainerAnchors(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'containerAnchors.dim');
  if (!dim.ok) return dim;
  const after = optionalString(object, 'after', 'containerAnchors.after');
  if (!after.ok) return after;
  const limit = optionalLimit(object);
  if (!limit.ok) return limit;
  return ok({
    kind: 'containerAnchors',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(after.value === undefined ? {} : { after: after.value }),
    ...(limit.value === undefined ? {} : { limit: limit.value }),
  });
}

function validateContainerContents(
  object: Record<string, unknown>,
): { ok: true; request: SpatialQueryRequest } | { ok: false; detail: string } {
  const dim = optionalString(object, 'dim', 'containerContents.dim');
  if (!dim.ok) return dim;
  const nodeId = optionalString(object, 'nodeId', 'containerContents.nodeId');
  if (!nodeId.ok) return nodeId;
  return ok({
    kind: 'containerContents',
    ...(dim.value === undefined ? {} : { dim: dim.value }),
    ...(nodeId.value === undefined ? {} : { nodeId: nodeId.value }),
  });
}

export function validateSpatialQueryRequest(raw: unknown): RequestValidation {
  if (!isPlainObject(raw)) {
    return fail('query request must be an object');
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(QUERY_KINDS as readonly string[]).includes(kind)) {
    return fail(`unknown query kind "${String(kind)}"`);
  }
  const queryKind = kind as SpatialQueryKind;
  const unknown = unknownFieldError(raw, queryKind);
  if (unknown !== null) return fail(unknown);

  switch (queryKind) {
    case 'cells':
      return validateCells(raw);
    case 'fragments':
      return validateFragments(raw);
    case 'traversals':
      return validateTraversals(raw);
    case 'nodes':
      return validateNodes(raw);
    case 'edges':
      return validateEdges(raw);
    case 'historyRoute':
      return validateHistoryRoute(raw);
    case 'anchor':
      return validateAnchor(raw);
    case 'components':
      return validateComponents(raw);
    case 'segments':
      return validateSegments(raw);
    case 'portals':
      return validatePortals(raw);
    case 'resourceAnchors':
      return validateResourceAnchors(raw);
    case 'containerAnchors':
      return validateContainerAnchors(raw);
    case 'containerContents':
      return validateContainerContents(raw);
    case 'snapshot':
      return ok({ kind: 'snapshot' });
    case 'capabilities':
      return ok({ kind: 'capabilities' });
  }
}
