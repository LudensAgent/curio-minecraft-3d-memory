/**
 * Opaque JSON metadata carried on host records.
 *
 * The library never interprets these values. It only guarantees that they are
 * finite, serializable JSON, deep-copied in and out of the stores, and included
 * in the conservative checkpoint byte estimate. Hosts own the key names and
 * their meaning.
 */

import { jsonEscapedByteLength } from './bytes.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface JsonLimits {
  /** Maximum serialized (escaped UTF-8) bytes for one metadata object. */
  maxBytes: number;
  /** Maximum nesting depth, counting the root object as depth 1. */
  maxDepth: number;
  /** Maximum keys in one object. */
  maxKeys: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = {
  maxBytes: 16 * 1024,
  maxDepth: 8,
  maxKeys: 128,
};

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function snapshotValue(
  value: unknown,
  label: string,
  limits: JsonLimits,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} contains a non-JSON value (${typeof value})`);
  }
  if (depth > limits.maxDepth) {
    throw new Error(`${label} exceeds the maximum JSON depth (${limits.maxDepth})`);
  }
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    result = value.map((item, index) => snapshotValue(item, `${label}[${index}]`, limits, depth + 1, seen));
  } else {
    if (!isPlainObject(value)) {
      throw new Error(`${label} contains a non-plain object`);
    }
    const entries = Object.entries(value);
    if (entries.length > limits.maxKeys) {
      throw new Error(`${label} has ${entries.length} keys, exceeding ${limits.maxKeys}`);
    }
    const object: JsonObject = {};
    for (const [key, item] of entries) {
      object[key] = snapshotValue(item, `${label}.${key}`, limits, depth + 1, seen);
    }
    result = object;
  }
  seen.delete(value);
  return result;
}

/** Validate and deep-copy one metadata object. */
export function snapshotJsonObject(value: unknown, label: string, limits: JsonLimits = DEFAULT_JSON_LIMITS): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isPlainObject(value)) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  const snapshot = snapshotValue(value, label, limits, 1, new WeakSet()) as JsonObject;
  const bytes = jsonObjectByteLength(snapshot);
  if (bytes > limits.maxBytes) {
    throw new Error(`${label} is ${bytes} bytes, exceeding ${limits.maxBytes}`);
  }
  return snapshot;
}

/** Deep-copy an already-validated metadata object. */
export function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneValue(value) as JsonObject;
}

function cloneValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === 'object') {
    const object: JsonObject = {};
    for (const [key, item] of Object.entries(value)) object[key] = cloneValue(item);
    return object;
  }
  return value;
}

/** Conservative escaped UTF-8 size of the object's serialized JSON text. */
export function jsonObjectByteLength(value: JsonObject): number {
  return jsonEscapedByteLength(JSON.stringify(value));
}

/** Canonical JSON text with object keys sorted; used for order-independent equality. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deep equality over JSON values, independent of object key order. */
export function jsonObjectsEqual(a: JsonObject | undefined, b: JsonObject | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonical(a) === canonical(b);
}
