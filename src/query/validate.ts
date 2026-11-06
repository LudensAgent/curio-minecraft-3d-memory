/**
 * Strict runtime validation for `SpatialQueryRequest` (contract §2.1/§5.6).
 *
 * TypeScript types are erased; a host or tool can still send an unknown field,
 * a non-integer cell, an over-limit page, or an unknown query kind. This module
 * is the single boundary that turns those into a structured `invalid_request`
 * detail before any store method is called. Handlers therefore receive an
 * already-validated request and do not repeat these checks.
 *
 * Field specs are declared per kind in request order: the first invalid field
 * still wins and the allowed-field set is derived from the same table, so the
 * validator, the accepted shape, and the unknown-field check cannot drift.
 */

import { MAX_QUERY_LIMIT } from './paging.js';
import type { SpatialQueryKind, SpatialQueryRequest } from './types.js';
import type { Vec3Like } from '../types.js';

export const MAX_CELL_POSITIONS = 4096;

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

export type RequestValidation =
  | { ok: true; request: SpatialQueryRequest }
  | { ok: false; detail: string };

type FieldResult = { ok: true; value: unknown } | { ok: false; detail: string };

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Field names that exist on at least one `SpatialQueryRequest` variant. */
type RequestFieldKey = Exclude<KeysOfUnion<SpatialQueryRequest>, 'kind'>;

/** One request field's validator; `what` is the `"kind.field"` error prefix. */
interface FieldSpec {
  key: RequestFieldKey;
  validate(value: unknown, what: string): FieldResult;
}

function fail(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

function accept(value: unknown): FieldResult {
  return { ok: true, value };
}

function ok(request: SpatialQueryRequest): { ok: true; request: SpatialQueryRequest } {
  return { ok: true, request };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(key: RequestFieldKey, required: boolean): FieldSpec {
  return {
    key,
    validate: (value, what) => {
      if (value === undefined && !required) return accept(undefined);
      if (typeof value !== 'string' || value.length === 0) {
        return fail(
          required
            ? `${what} must be a non-empty string`
            : `${what} must be a non-empty string when present`,
        );
      }
      return accept(value);
    },
  };
}

function enumField(
  key: RequestFieldKey,
  allowed: readonly string[],
  required: boolean,
): FieldSpec {
  return {
    key,
    validate: (value, what) => {
      if (value === undefined) {
        return required
          ? fail(`${what} is required and must be one of: ${allowed.join(', ')}`)
          : accept(undefined);
      }
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return fail(`${what} must be one of: ${allowed.join(', ')}`);
      }
      return accept(value);
    },
  };
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

function pointField(key: RequestFieldKey, integer: boolean): FieldSpec {
  return {
    key,
    validate: (value, what) => {
      if (!isPoint(value, integer)) {
        return fail(
          integer
            ? `${what} must have finite integer x, y, z and no other fields`
            : `${what} must have finite x, y, z and no other fields`,
        );
      }
      return accept({ x: value.x, y: value.y, z: value.z });
    },
  };
}

const LIMIT_FIELD: FieldSpec = {
  key: 'limit',
  validate: (value) => {
    if (value === undefined) return accept(undefined);
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_QUERY_LIMIT
    ) {
      return fail(`limit must be an integer in [1, ${MAX_QUERY_LIMIT}]`);
    }
    return accept(value);
  },
};

const NEAR_FIELD: FieldSpec = {
  key: 'near',
  validate: (value) => {
    if (value === undefined) return accept(undefined);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fail('near must be a finite non-negative number');
    }
    return accept(value);
  },
};

const POSITIONS_FIELD: FieldSpec = {
  key: 'positions',
  validate: (value, what) => {
    if (!Array.isArray(value)) {
      return fail(`${what} must be an array of block positions`);
    }
    if (value.length > MAX_CELL_POSITIONS) {
      return fail(`${what} must contain at most ${MAX_CELL_POSITIONS} positions`);
    }
    const points: Vec3Like[] = [];
    for (let index = 0; index < value.length; index++) {
      const point = value[index];
      if (!isPoint(point, true)) {
        return fail(`${what}[${index}] must have finite integer x, y, z and no other fields`);
      }
      points.push({ x: point.x, y: point.y, z: point.z });
    }
    return accept(points);
  },
};

const FIELD_SPECS: Record<SpatialQueryKind, readonly FieldSpec[]> = {
  cells: [stringField('dim', true), POSITIONS_FIELD],
  fragments: [
    stringField('dim', false),
    enumField('fragmentKind', FRAGMENT_KINDS, false),
    enumField('geometrySource', GEOMETRY_SOURCES, false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  traversals: [
    stringField('dim', false),
    stringField('fragmentId', false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  nodes: [
    stringField('dim', false),
    enumField('tag', LANDMARK_TAGS, false),
    stringField('label', false),
    enumField('source', NODE_SOURCES, false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  edges: [
    stringField('dim', false),
    stringField('from', false),
    stringField('to', false),
    enumField('type', CONNECTION_TYPES, false),
    enumField('basis', EDGE_BASES, false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  historyRoute: [
    stringField('dim', true),
    pointField('from', false),
    pointField('to', false),
    NEAR_FIELD,
  ],
  anchor: [
    stringField('dim', true),
    pointField('here', false),
    enumField('order', ANCHOR_ORDERS, true),
    NEAR_FIELD,
  ],
  components: [stringField('dim', true)],
  segments: [stringField('fragmentId', true)],
  portals: [stringField('after', false), LIMIT_FIELD],
  resourceAnchors: [
    stringField('dim', false),
    enumField('tag', LANDMARK_TAGS, false),
    stringField('label', false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  containerAnchors: [stringField('dim', false), stringField('after', false), LIMIT_FIELD],
  containerContents: [stringField('dim', false), stringField('nodeId', false)],
  snapshot: [],
  capabilities: [],
};

function unknownFieldError(
  object: Record<string, unknown>,
  kind: SpatialQueryKind,
): string | null {
  const allowed = ['kind', ...FIELD_SPECS[kind].map((field) => field.key)];
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      return `unknown field "${key}" for query kind "${kind}"`;
    }
  }
  return null;
}

export function validateSpatialQueryRequest(raw: unknown): RequestValidation {
  if (!isPlainObject(raw)) {
    return fail('query request must be an object');
  }
  const kindValue = raw.kind;
  if (typeof kindValue !== 'string' || !Object.hasOwn(FIELD_SPECS, kindValue)) {
    return fail(`unknown query kind "${String(kindValue)}"`);
  }
  const kind = kindValue as SpatialQueryKind;
  const unknown = unknownFieldError(raw, kind);
  if (unknown !== null) return fail(unknown);

  const request: Record<string, unknown> = { kind };
  for (const field of FIELD_SPECS[kind]) {
    const result = field.validate(raw[field.key], `${kind}.${field.key}`);
    if (!result.ok) return result;
    if (result.value !== undefined) request[field.key] = result.value;
  }
  return ok(request as SpatialQueryRequest);
}
