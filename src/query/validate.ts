/**
 * Strict runtime validation for `SpatialQueryRequest` (contract §2.1/§5.6).
 *
 * TypeScript types are erased; a host or tool can still send an unknown field,
 * a non-integer cell, an over-limit page, or a retired query kind. This module
 * is the single boundary that turns those into a structured `invalid_request`
 * detail before any store method is called. Handlers therefore receive an
 * already-validated request and do not repeat these checks.
 */

import { MAX_QUERY_LIMIT } from './paging.js';
import type { SpatialQueryKind, SpatialQueryRequest } from './types.js';
import type { Vec3Like } from '../types.js';

export const MAX_CELL_POSITIONS = 4096;

const PLACE_TAGS = ['base', 'resource', 'danger', 'discovery', 'death', 'portal'] as const;
const PLACE_SOURCES = ['agent', 'program'] as const;

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

function booleanField(key: RequestFieldKey, required: boolean): FieldSpec {
  return {
    key,
    validate: (value, what) => {
      if (value === undefined && !required) return accept(undefined);
      if (typeof value !== 'boolean') {
        return fail(required ? `${what} is required and must be a boolean` : `${what} must be a boolean when present`);
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
  nodes: [
    stringField('dim', false),
    enumField('tag', PLACE_TAGS, false),
    stringField('label', false),
    enumField('source', PLACE_SOURCES, false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  places: [
    stringField('dim', false),
    enumField('tag', PLACE_TAGS, false),
    stringField('label', false),
    enumField('source', PLACE_SOURCES, false),
    booleanField('includeGone', false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  resourceAnchors: [
    stringField('dim', false),
    enumField('tag', PLACE_TAGS, false),
    stringField('label', false),
    booleanField('includeGone', false),
    stringField('after', false),
    LIMIT_FIELD,
  ],
  containerAnchors: [stringField('dim', false), stringField('after', false), LIMIT_FIELD],
  containerContents: [stringField('dim', false)],
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
