/**
 * Bounded observation intake queue (design §6.2 step 6 / §9.2).
 *
 * Observation batches arrive from the host's perception loop. Differencing and
 * route invalidation are synchronous and local, but the queue itself is bounded
 * in both item count and estimated bytes, and every drain is capped: a backlog
 * is reported instead of being processed in one unbounded synchronous pass.
 *
 * The queue never interprets a gap as a cell, never reads the world, and never
 * writes evidence. It only stores observations and bounded gaps until the host
 * (or the map's owning session) drains them.
 */

import { jsonEscapedByteLength } from '../bytes.js';
import { cloneObservation, cloneObservationGap } from './clone.js';
import type { Observation, ObservationBatch, ObservationGap } from './types.js';

export interface ObservationQueueOptions {
  /** Hard cap on queued items (observations + gaps together). Defaults to 4096. */
  maxItems?: number;
  /** Hard cap on estimated queued bytes. Defaults to 4 MiB. */
  maxBytes?: number;
  /**
   * Per-item byte estimate. Defaults to a conservative observation/gap estimate;
   * override when the host has a more accurate measure.
   */
  estimateBytes?: (item: Observation | ObservationGap) => number;
  /**
   * Maximum stable identifiers retained per refused batch. Defaults to 64.
   * Counts are always exact; only the identifier list is bounded.
   */
  maxRejectedIds?: number;
}

/** Explicit overflow report: what was refused because of a capacity bound. */
export interface ObservationOverflow {
  observations: number;
  gaps: number;
  bytes: number;
  reason: 'max_items' | 'max_bytes' | 'both';
  /**
   * Stable identities of the refused observations, in batch order. Bounded by
   * the queue's `maxRejectedIds`; the counterpart counts stay exact so a caller
   * can tell which cells to re-observe when identifiers were truncated.
   */
  rejectedObservations: string[];
  /** Stable identities of refused gaps, in batch order (same bound). */
  rejectedGaps: string[];
  /** True when at least one refused item has no retained identifier. */
  truncated: boolean;
}

export interface ObservationEnqueueResult {
  /** True when the whole batch was accepted; a batch is accepted atomically. */
  accepted: boolean;
  observations: number;
  gaps: number;
  bytes: number;
  /** Present only when the batch was refused. */
  overflow: ObservationOverflow | null;
}

/** Counts and bytes still waiting in the queue. */
export interface ObservationBacklog {
  observations: number;
  gaps: number;
  bytes: number;
}

export interface ObservationDrainResult {
  /** Observations to process now (at most `maxItems`), in enqueue order. */
  observations: Observation[];
  /** Gaps carried alongside them; diagnostics only. */
  gaps: ObservationGap[];
  backlog: ObservationBacklog;
  /** Overflow accumulated since the previous drain (cleared by this drain). */
  overflow: ObservationOverflow | null;
}

const DEFAULT_MAX_ITEMS = 4096;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_REJECTED_IDS = 64;
const OBSERVATION_FIXED_BYTES = 256;
const GAP_FIXED_BYTES = 48;

type QueueItem =
  | { kind: 'observation'; observation: Observation; bytes: number }
  | { kind: 'gap'; gap: ObservationGap; bytes: number };

export class ObservationQueue {
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly estimateBytes: (item: Observation | ObservationGap) => number;
  private readonly maxRejectedIds: number;
  private readonly items: QueueItem[] = [];
  private queuedBytes = 0;
  private queuedObservations = 0;
  private queuedGaps = 0;
  private pendingOverflow: ObservationOverflow | null = null;

  constructor(options: ObservationQueueOptions = {}) {
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new Error(`maxItems must be a positive safe integer: ${String(maxItems)}`);
    }
    if (!Number.isFinite(maxBytes) || maxBytes < 1) {
      throw new Error(`maxBytes must be a positive finite number: ${String(maxBytes)}`);
    }
    const maxRejectedIds = options.maxRejectedIds ?? DEFAULT_MAX_REJECTED_IDS;
    if (!Number.isSafeInteger(maxRejectedIds) || maxRejectedIds < 1) {
      throw new Error(`maxRejectedIds must be a positive safe integer: ${String(maxRejectedIds)}`);
    }
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.estimateBytes = options.estimateBytes ?? defaultEstimateBytes;
    this.maxRejectedIds = maxRejectedIds;
  }

  /** Current backlog (read-only; draining is the only way items leave). */
  backlog(): ObservationBacklog {
    return {
      observations: this.queuedObservations,
      gaps: this.queuedGaps,
      bytes: this.queuedBytes,
    };
  }

  /**
   * Enqueue one batch atomically: either every observation and gap fits, or the
   * whole batch is refused and reported. Refusing the whole batch keeps FIFO
   * order honest and avoids silently dropping only the tail of a scan.
   */
  enqueue(batch: ObservationBatch): ObservationEnqueueResult {
    const observations = batch.observations.length;
    const gaps = batch.unobserved.length;
    let bytes = 0;
    for (const observation of batch.observations) bytes += this.estimateBytes(observation);
    for (const gap of batch.unobserved) bytes += this.estimateBytes(gap);

    const overItems = this.queuedObservations + observations + this.queuedGaps + gaps > this.maxItems;
    const overBytes = this.queuedBytes + bytes > this.maxBytes;
    if (overItems || overBytes) {
      const rejectedObservations = batch.observations
        .slice(0, this.maxRejectedIds)
        .map(observationIdentity);
      const remaining = Math.max(0, this.maxRejectedIds - rejectedObservations.length);
      const rejectedGaps = batch.unobserved.slice(0, remaining).map(gapIdentity);
      const overflow: ObservationOverflow = {
        observations,
        gaps,
        bytes,
        reason: overItems && overBytes ? 'both' : overItems ? 'max_items' : 'max_bytes',
        rejectedObservations,
        rejectedGaps,
        truncated: rejectedObservations.length + rejectedGaps.length < observations + gaps,
      };
      this.pendingOverflow = mergeOverflow(this.pendingOverflow, overflow, this.maxRejectedIds);
      return { accepted: false, observations: 0, gaps: 0, bytes: 0, overflow };
    }

    for (const observation of batch.observations) {
      this.items.push({ kind: 'observation', observation: cloneObservation(observation), bytes: this.estimateBytes(observation) });
    }
    for (const gap of batch.unobserved) {
      this.items.push({ kind: 'gap', gap: cloneObservationGap(gap), bytes: this.estimateBytes(gap) });
    }
    this.queuedObservations += observations;
    this.queuedGaps += gaps;
    this.queuedBytes += bytes;
    return { accepted: true, observations, gaps, bytes, overflow: null };
  }

  /**
   * Take at most `maxItems` queued items (FIFO) for processing. `maxItems` must
   * be a positive safe integer: there is deliberately no "drain everything" mode,
   * so a large backlog cannot block one frame.
   */
  drain(maxItems: number): ObservationDrainResult {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw new Error(`drain maxItems must be a positive safe integer: ${String(maxItems)}`);
    }
    const take = Math.min(maxItems, this.items.length);
    const drained: QueueItem[] = this.items.splice(0, take);
    const observations: Observation[] = [];
    const gaps: ObservationGap[] = [];
    for (const item of drained) {
      if (item.kind === 'observation') {
        observations.push(item.observation);
        this.queuedObservations -= 1;
      } else {
        gaps.push(item.gap);
        this.queuedGaps -= 1;
      }
      this.queuedBytes -= item.bytes;
    }
    const overflow = this.pendingOverflow;
    this.pendingOverflow = null;
    return { observations, gaps, backlog: this.backlog(), overflow };
  }
}

function mergeOverflow(
  previous: ObservationOverflow | null,
  next: ObservationOverflow,
  maxRejectedIds: number,
): ObservationOverflow {
  if (previous === null) return next;
  const reason = previous.reason === next.reason ? next.reason : 'both';
  const rejectedObservations = [...previous.rejectedObservations, ...next.rejectedObservations]
    .slice(0, maxRejectedIds);
  const remaining = Math.max(0, maxRejectedIds - rejectedObservations.length);
  const rejectedGaps = [...previous.rejectedGaps, ...next.rejectedGaps].slice(0, remaining);
  return {
    observations: previous.observations + next.observations,
    gaps: previous.gaps + next.gaps,
    bytes: previous.bytes + next.bytes,
    reason,
    rejectedObservations,
    rejectedGaps,
    truncated: previous.truncated || next.truncated
      || rejectedObservations.length + rejectedGaps.length
        < previous.observations + next.observations + previous.gaps + next.gaps,
  };
}

/** Stable identity for a refused observation: scope + cell + acquisition time + sequence. */
function observationIdentity(observation: Observation): string {
  const { x, y, z } = observation.pos;
  return `${observation.worldId}/${observation.dim}/${x},${y},${z}@${observation.observedAt}#${observation.sequence}`;
}

/** Stable identity for a refused gap: cell + reason. Gaps carry no world/dim. */
function gapIdentity(gap: ObservationGap): string {
  const { x, y, z } = gap.pos;
  return `${x},${y},${z}:${gap.reason}`;
}

/**
 * Conservative default estimate. Fixed structural overhead plus escaped string
 * sizes; numbers are billed at the worst-case JSON decimal width.
 */
function defaultEstimateBytes(item: Observation | ObservationGap): number {
  if (!('state' in item)) {
    return GAP_FIXED_BYTES + jsonEscapedByteLength(item.reason);
  }
  let bytes = OBSERVATION_FIXED_BYTES + 6 * 24; // pos/observedAt/tick/sequence/etc.
  bytes += jsonEscapedByteLength(item.state.name);
  for (const [key, value] of Object.entries(item.state.properties)) {
    bytes += jsonEscapedByteLength(key) + jsonEscapedByteLength(value) + 4;
  }
  bytes += jsonEscapedByteLength(item.source);
  bytes += jsonEscapedByteLength(item.evidence);
  bytes += jsonEscapedByteLength(item.sessionId);
  bytes += jsonEscapedByteLength(item.dim);
  bytes += jsonEscapedByteLength(item.worldId);
  if (item.actionId !== undefined) bytes += jsonEscapedByteLength(item.actionId);
  return bytes;
}
