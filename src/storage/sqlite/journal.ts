/**
 * Pure pending journal (actions + typed spatial events) for the SQLite
 * persistence session.
 *
 * Everything here is synchronous and bounded: it validates one record at a time,
 * canonicalizes it (object keys sorted recursively, array order preserved),
 * deep-copies it so later caller mutation cannot change an accepted record, and
 * enforces the configured pending capacities. Acceptance is *not* a save; only an
 * explicit checkpoint sends a captured batch to the single worker.
 */

import type { ActionRecord } from '../../navigation/types.js';
import {
  PersistenceError,
  type JournalAcceptResult,
  type JournalBatchAcceptResult,
  type JournalBatchInput,
  type JournalWithdrawalResult,
  type JournalWithdrawalSelector,
  type PendingJournalSnapshot,
  type ResolvedJournalLimits,
  type SpatialEvent,
} from './types.js';

/** A replay reused a scoped id with different canonical content. */
export class JournalConflictError extends PersistenceError {
  constructor(message: string) {
    super('conflict', message);
    this.name = 'JournalConflictError';
  }
}

interface CanonicalRecord<T> {
  record: T;
  json: string;
  bytes: number;
}

interface CanonicalizeState {
  readonly limits: ResolvedJournalLimits;
  readonly seen: Set<object>;
  bytes: number;
}

const INVALID_RECORD = 'journal record';

/**
 * Stable scoped identity for one record: `(kind, worldId, sessionId, id)`.
 * Actions and events are separate namespaces, matching the separate pending maps
 * and the separate SQL tables; the same id may therefore exist once as an action
 * and once as an event in the same world/session. `taskId` is never an identity.
 */
export function journalScopeKey(
  kind: 'action' | 'event',
  worldId: string,
  sessionId: string,
  id: string,
): string {
  return JSON.stringify([kind, worldId, sessionId, id]);
}

function overLimit(name: string, value: number, limit: number): PersistenceError {
  return new PersistenceError('capacity', `journal exceeds ${name} (${value} > ${limit})`);
}

function invalid(message: string): PersistenceError {
  return new PersistenceError('invalid_argument', message);
}

/**
 * Canonicalize one JSON-safe record:
 * - recursively sorts object keys, preserving array order;
 * - rejects cycles, non-plain objects, non-finite numbers, bigint/symbol/function
 *   values and undefined array elements;
 * - omits object properties whose value is `undefined` (absence is absence);
 * - enforces depth, collection-length and canonical-byte limits *during* the
 *   traversal, so an oversized record is rejected before a full clone/stringify.
 */
export function canonicalizeJournalRecord<T>(value: T, limits: ResolvedJournalLimits): CanonicalRecord<T> {
  if (value === null || typeof value !== 'object') {
    throw invalid(`${INVALID_RECORD} must be an object`);
  }
  const state: CanonicalizeState = { limits, seen: new Set(), bytes: 0 };
  const record = canonicalizeValue(value, 0, state) as T;
  const json = JSON.stringify(record);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > limits.maxRecordBytes) {
    throw overLimit('maxRecordBytes', bytes, limits.maxRecordBytes);
  }
  return { record, json, bytes };
}

function addBytes(state: CanonicalizeState, amount: number): void {
  state.bytes += amount;
  if (state.bytes > state.limits.maxRecordBytes) {
    throw overLimit('maxRecordBytes', state.bytes, state.limits.maxRecordBytes);
  }
}

function jsonStringBytes(state: CanonicalizeState, value: string, what: string): number {
  // Every UTF-16 code unit emits at least one UTF-8 byte, so this cheap check
  // rejects an oversized string before escaping/encoding it.
  if (value.length > state.limits.maxRecordBytes) {
    throw overLimit('maxRecordBytes', value.length, state.limits.maxRecordBytes);
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw invalid(`${what} could not be encoded as JSON`);
  addBytes(state, Buffer.byteLength(encoded, 'utf8'));
  return encoded.length;
}

function canonicalizeValue(value: unknown, depth: number, state: CanonicalizeState): unknown {
  if (value === null) {
    addBytes(state, 4);
    return null;
  }
  switch (typeof value) {
    case 'string':
      jsonStringBytes(state, value, 'journal string');
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw invalid('journal numbers must be finite');
      addBytes(state, String(value).length);
      return value;
    case 'boolean':
      addBytes(state, value ? 4 : 5);
      return value;
    case 'undefined':
      throw invalid('undefined is not allowed as a journal value');
    case 'bigint':
    case 'symbol':
    case 'function':
      throw invalid(`${typeof value} is not a valid journal value`);
    default:
      break;
  }

  const object = value as object;
  if (depth >= state.limits.maxRecordDepth) {
    throw overLimit('maxRecordDepth', depth + 1, state.limits.maxRecordDepth);
  }
  if (state.seen.has(object)) throw invalid('journal record must not contain cycles');
  state.seen.add(object);
  try {
    if (Array.isArray(object)) {
      if (object.length > state.limits.maxRecordArrayLength) {
        throw overLimit('maxRecordArrayLength', object.length, state.limits.maxRecordArrayLength);
      }
      addBytes(state, 2 + Math.max(0, object.length - 1));
      const out: unknown[] = [];
      for (const item of object) {
        if (item === undefined) throw invalid('undefined is not allowed in a journal array');
        out.push(canonicalizeValue(item, depth + 1, state));
      }
      return out;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid('journal records must contain only plain objects and arrays');
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw invalid('journal records must not use symbol keys');
    }
    const source = object as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length > state.limits.maxRecordArrayLength) {
      throw overLimit('maxRecordArrayLength', keys.length, state.limits.maxRecordArrayLength);
    }
    keys.sort();
    addBytes(state, 2 + Math.max(0, keys.length - 1));
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const item = source[key];
      // `undefined` object properties are treated as absent (as JSON would);
      // they never become a fake observation or a fake timestamp.
      if (item === undefined) continue;
      addBytes(state, 1); // ':'
      jsonStringBytes(state, key, 'journal key');
      out[key] = canonicalizeValue(item, depth + 1, state);
    }
    return out;
  } finally {
    state.seen.delete(object);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${what} must be a non-empty string`);
  return value;
}

function requireTime(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${what} must be a finite number`);
  return value;
}

function samePos(a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return false;
  return a['x'] === b['x'] && a['y'] === b['y'] && a['z'] === b['z'];
}

function validateObservationScope(
  observation: unknown,
  scope: { worldId: string; dim: string; pos: unknown },
  what: string,
): void {
  if (!isRecord(observation)) throw invalid(`${what} must be an observation object`);
  requireString(observation['sessionId'], `${what}.sessionId`);
  if (observation['worldId'] !== scope.worldId) {
    throw invalid(`${what}.worldId does not match the journal worldId`);
  }
  if (observation['dim'] !== scope.dim) throw invalid(`${what}.dim does not match the event dim`);
  if (!samePos(observation['pos'], scope.pos)) throw invalid(`${what}.pos does not match the event pos`);
}

function validateAction(record: ActionRecord, worldId: string): void {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw invalid('action record must be an object');
  }
  requireString(record.id, 'action.id');
  requireString(record.sessionId, 'action.sessionId');
  requireString(record.dim, 'action.dim');
  requireTime(record.ts, 'action.ts');
  if (record.worldId !== worldId) {
    throw invalid(`action.worldId "${String(record.worldId)}" does not match session worldId "${worldId}"`);
  }
}

const EVENT_REASONS = new Set([
  'out_of_view',
  'occluded',
  'too_dark',
  'unloaded',
  'budget_not_scanned',
  'unknown',
  'disconnected',
  'paused',
  'scope_changed',
  'not_ready',
]);

function validateEvent(event: SpatialEvent, worldId: string): void {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw invalid('spatial event must be an object');
  }
  requireString(event.id, 'event.id');
  requireString(event.sessionId, 'event.sessionId');
  const dim = requireString(event.dim, 'event.dim');
  requireTime(event.observedAt, 'event.observedAt');
  if (event.worldId !== worldId) {
    throw invalid(`event.worldId "${String(event.worldId)}" does not match session worldId "${worldId}"`);
  }
  if (event.kind === 'observed_cell_change') {
    if (!isRecord(event.pos)) throw invalid('observed_cell_change.pos must be a position object');
    validateObservationScope(event.current, { worldId, dim, pos: event.pos }, 'observed_cell_change.current');
    if (event.previous !== undefined) {
      // The previous observation may belong to an older session; its original
      // sessionId/evidence/time are preserved. Its scope and cell must still match.
      validateObservationScope(event.previous, { worldId, dim, pos: event.pos }, 'observed_cell_change.previous');
    }
    if (event.actionId !== undefined) requireString(event.actionId, 'observed_cell_change.actionId');
    return;
  }
  if (event.kind === 'observation_gap') {
    if (!EVENT_REASONS.has(event.reason)) {
      throw invalid(`observation_gap.reason is not supported: ${String(event.reason)}`);
    }
    if (event.pos !== undefined && !isRecord(event.pos)) {
      throw invalid('observation_gap.pos must be a position object when present');
    }
    return;
  }
  throw invalid(`unsupported spatial event kind: ${String((event as { kind?: unknown }).kind)}`);
}

interface JournalEntry {
  kind: 'action' | 'event';
  sessionId: string;
  id: string;
  /** Local acceptance order across actions and events. */
  order: number;
  /** Local journal revision assigned when this entry was accepted. */
  revision: number;
  json: string;
  bytes: number;
  record: ActionRecord | SpatialEvent;
}

interface CandidateEntry {
  kind: 'action' | 'event';
  sessionId: string;
  id: string;
  key: string;
  json: string;
  bytes: number;
  record: ActionRecord | SpatialEvent;
}

/** A bounded, local capture ready to be written by one checkpoint transaction. */
export interface JournalCapture {
  actions: ActionRecord[];
  events: SpatialEvent[];
  /** Exact captured entries, used to clear only these on ACK. */
  keys: { kind: 'action' | 'event'; key: string; revision: number }[];
  bytes: number;
  /** Revision this capture covers (may trail the local revision when truncated). */
  revision: number;
}

/**
 * In-memory pending journal. One instance belongs to one session world. It keeps
 * no committed records and no second persistence queue; entries leave only by an
 * explicit ACK-confirmed checkpoint or an explicit caller withdrawal.
 */
export class JournalQueue {
  private readonly worldId: string;
  private readonly limits: ResolvedJournalLimits;
  private readonly actions = new Map<string, JournalEntry>();
  private readonly events = new Map<string, JournalEntry>();
  private revisionField: number;
  private order = 0;
  private bytes = 0;

  constructor(worldId: string, limits: ResolvedJournalLimits, initialRevision = 0) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw invalid('initial journal revision must be a non-negative safe integer');
    }
    this.worldId = worldId;
    this.limits = limits;
    this.revisionField = initialRevision;
  }

  get revision(): number {
    return this.revisionField;
  }

  /**
   * Align an empty queue with the restored committed baseline revision. Only
   * valid before any record is accepted; the session calls it during open.
   */
  resetRevisionForRestore(revision: number): void {
    if (this.pendingRecords > 0) {
      throw invalid('cannot reset the journal revision while pending records exist');
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw invalid('restored journal revision must be a non-negative safe integer');
    }
    this.revisionField = revision;
  }

  get pendingRecords(): number {
    return this.actions.size + this.events.size;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  recordAction(record: ActionRecord): JournalAcceptResult {
    const result = this.acceptBatch({ actions: [record] });
    return {
      accepted: true,
      duplicate: result.accepted === 0 && result.duplicates > 0,
      revision: result.revision,
      pendingRecords: result.pendingRecords,
      pendingBytes: result.pendingBytes,
    };
  }

  recordEvent(event: SpatialEvent): JournalAcceptResult {
    const result = this.acceptBatch({ events: [event] });
    return {
      accepted: true,
      duplicate: result.accepted === 0 && result.duplicates > 0,
      revision: result.revision,
      pendingRecords: result.pendingRecords,
      pendingBytes: result.pendingBytes,
    };
  }

  /** Atomically validate, deduplicate and accept a batch; any failure changes nothing. */
  acceptBatch(input: JournalBatchInput): JournalBatchAcceptResult {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw invalid('journal batch must be an object');
    }
    const rawActions: readonly ActionRecord[] = input.actions ?? [];
    const rawEvents: readonly SpatialEvent[] = input.events ?? [];
    if (!Array.isArray(rawActions) || !Array.isArray(rawEvents)) {
      throw invalid('journal batch actions/events must be arrays');
    }
    const total = rawActions.length + rawEvents.length;
    if (total === 0) {
      return {
        accepted: 0,
        duplicates: 0,
        revision: this.revisionField,
        pendingRecords: this.pendingRecords,
        pendingBytes: this.bytes,
      };
    }
    if (total > this.limits.maxPendingRecords) {
      throw overLimit('maxPendingRecords', total, this.limits.maxPendingRecords);
    }

    // Stage one candidate at a time. Only fresh candidates are retained, and the
    // cumulative fresh count/bytes are checked *before* retaining each one. A
    // pending duplicate is compared against the already-retained canonical payload
    // without keeping a second canonical copy. Nothing mutates the live queue until
    // the whole batch has validated.
    const inBatch = new Map<string, string>();
    let duplicates = 0;
    let finalRecords = this.pendingRecords;
    let finalBytes = this.bytes;
    const fresh: CandidateEntry[] = [];

    const stage = (kind: 'action' | 'event', record: ActionRecord | SpatialEvent): void => {
      const sessionId = record.sessionId;
      const id = record.id;
      const key = journalScopeKey(kind, this.worldId, sessionId, id);
      const canonical = canonicalizeJournalRecord(record, this.limits);

      const priorJson = inBatch.get(key);
      if (priorJson !== undefined) {
        if (priorJson !== canonical.json) {
          throw new JournalConflictError(
            `journal ${kind} conflict for session "${sessionId}" id "${id}": replay content differs`,
          );
        }
        duplicates += 1;
        return;
      }

      const map = kind === 'action' ? this.actions : this.events;
      const existing = map.get(key);
      if (existing !== undefined) {
        if (existing.json !== canonical.json) {
          throw new JournalConflictError(
            `journal ${kind} conflict for session "${sessionId}" id "${id}": pending content differs`,
          );
        }
        // Reference the pending payload, not a canonical copy of the input.
        inBatch.set(key, existing.json);
        duplicates += 1;
        return;
      }

      // Enforce cumulative capacity immediately before retaining this fresh record.
      finalRecords += 1;
      finalBytes += canonical.bytes;
      if (finalRecords > this.limits.maxPendingRecords) {
        throw overLimit('maxPendingRecords', finalRecords, this.limits.maxPendingRecords);
      }
      if (finalBytes > this.limits.maxPendingBytes) {
        throw overLimit('maxPendingBytes', finalBytes, this.limits.maxPendingBytes);
      }

      const candidate: CandidateEntry = {
        kind,
        sessionId,
        id,
        key,
        json: canonical.json,
        bytes: canonical.bytes,
        record: canonical.record,
      };
      inBatch.set(key, candidate.json);
      fresh.push(candidate);
    };

    for (const action of rawActions) {
      validateAction(action, this.worldId);
      stage('action', action);
    }
    for (const event of rawEvents) {
      validateEvent(event, this.worldId);
      stage('event', event);
    }

    for (const candidate of fresh) {
      const entry: JournalEntry = {
        kind: candidate.kind,
        sessionId: candidate.sessionId,
        id: candidate.id,
        order: ++this.order,
        revision: ++this.revisionField,
        json: candidate.json,
        bytes: candidate.bytes,
        record: candidate.record,
      };
      if (candidate.kind === 'action') this.actions.set(candidate.key, entry);
      else this.events.set(candidate.key, entry);
      this.bytes += candidate.bytes;
    }

    return {
      accepted: fresh.length,
      duplicates,
      revision: this.revisionField,
      pendingRecords: this.pendingRecords,
      pendingBytes: this.bytes,
    };
  }

  /** Fresh isolated copies of every pending record, in acceptance order per kind. */
  readPending(): PendingJournalSnapshot {
    const ordered = [...this.actions.values(), ...this.events.values()].sort((a, b) => a.order - b.order);
    const actions: ActionRecord[] = [];
    const events: SpatialEvent[] = [];
    for (const entry of ordered) {
      if (entry.kind === 'action') actions.push(JSON.parse(entry.json) as ActionRecord);
      else events.push(JSON.parse(entry.json) as SpatialEvent);
    }
    return { revision: this.revisionField, actions, events, bytes: this.bytes };
  }

  /**
   * Capture a bounded batch in acceptance order. When the batch is truncated,
   * the returned revision stops at the last captured entry so an older ACK can
   * never confirm newer pending records.
   */
  capture(maxRecords: number, maxBytes: number): JournalCapture {
    const ordered = [...this.actions.values(), ...this.events.values()].sort((a, b) => a.order - b.order);
    if (ordered.length === 0) {
      return { actions: [], events: [], keys: [], bytes: 0, revision: this.revisionField };
    }
    const selected: JournalEntry[] = [];
    let bytes = 0;
    let truncated = false;
    for (const entry of ordered) {
      if (selected.length >= maxRecords) {
        truncated = true;
        break;
      }
      if (bytes + entry.bytes > maxBytes) {
        if (selected.length === 0) {
          throw overLimit('maxBatchBytes', entry.bytes, maxBytes);
        }
        truncated = true;
        break;
      }
      selected.push(entry);
      bytes += entry.bytes;
    }
    const actions: ActionRecord[] = [];
    const events: SpatialEvent[] = [];
    const keys: JournalCapture['keys'] = [];
    for (const entry of selected) {
      if (entry.kind === 'action') actions.push(entry.record as ActionRecord);
      else events.push(entry.record as SpatialEvent);
      keys.push({
        kind: entry.kind,
        key: journalScopeKey(entry.kind, this.worldId, entry.sessionId, entry.id),
        revision: entry.revision,
      });
    }
    const last = selected[selected.length - 1]!;
    return {
      actions,
      events,
      keys,
      bytes,
      revision: truncated ? last.revision : this.revisionField,
    };
  }

  /** Clear only the captured entries (revision-checked); newer/other pending stays. */
  confirm(keys: JournalCapture['keys'], capturedRevision: number): void {
    for (const { kind, key, revision } of keys) {
      if (revision > capturedRevision) continue;
      const map = kind === 'action' ? this.actions : this.events;
      const entry = map.get(key);
      if (entry === undefined || entry.revision > capturedRevision) continue;
      map.delete(key);
      this.bytes -= entry.bytes;
    }
  }

  /**
   * Deliberately withdraw exact pending ids. Never touches committed rows and
   * never infers which records to drop. An actual withdrawal advances the local
   * journal revision so an empty checkpoint can confirm it.
   */
  withdraw(selector: JournalWithdrawalSelector): JournalWithdrawalResult {
    if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) {
      throw invalid('journal withdrawal must be an object');
    }
    const actionSelectors = selector.actions ?? [];
    const eventSelectors = selector.events ?? [];
    if (!Array.isArray(actionSelectors) || !Array.isArray(eventSelectors)) {
      throw invalid('journal withdrawal actions/events must be arrays');
    }
    const total = actionSelectors.length + eventSelectors.length;
    if (total > this.limits.maxPendingRecords) {
      throw overLimit('maxPendingRecords', total, this.limits.maxPendingRecords);
    }
    // Validate, bound and deduplicate the complete selector before mutating any
    // pending entry, so a malformed later selector cannot strand an earlier
    // withdrawal without a returned fact or revision advance.
    const seen = new Set<string>();
    const ops: { kind: 'action' | 'event'; sessionId: string; id: string; key: string }[] = [];
    const plan = (kind: 'action' | 'event', ref: { sessionId: string; id: string }): void => {
      if (!isRecord(ref)) throw invalid('journal withdrawal ids must be objects');
      const sessionId = requireString(ref.sessionId, 'withdrawal.sessionId');
      const id = requireString(ref.id, 'withdrawal.id');
      const key = journalScopeKey(kind, this.worldId, sessionId, id);
      if (seen.has(key)) return;
      seen.add(key);
      ops.push({ kind, sessionId, id, key });
    };

    for (const ref of actionSelectors) plan('action', ref);
    for (const ref of eventSelectors) plan('event', ref);

    const withdrawn: JournalWithdrawalResult['withdrawn'] = { actions: [], events: [] };
    const missing: JournalWithdrawalResult['missing'] = [];
    let removed = 0;
    for (const { kind, sessionId, id, key } of ops) {
      const map = kind === 'action' ? this.actions : this.events;
      const entry = map.get(key);
      if (entry === undefined) {
        missing.push({ kind, sessionId, id });
        continue;
      }
      map.delete(key);
      this.bytes -= entry.bytes;
      removed += 1;
      if (kind === 'action') withdrawn.actions.push(JSON.parse(entry.json) as ActionRecord);
      else withdrawn.events.push(JSON.parse(entry.json) as SpatialEvent);
    }
    if (removed > 0) this.revisionField += 1;
    return {
      withdrawn,
      missing,
      revision: this.revisionField,
      pendingRecords: this.pendingRecords,
      pendingBytes: this.bytes,
    };
  }
}
