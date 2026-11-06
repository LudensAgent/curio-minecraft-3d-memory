/**
 * Observation boundary validation (design §3.2 / §6.2).
 *
 * The host supplies observation batches; this is the single place where their
 * shape, scope and evidence semantics are checked. Downstream code receives a
 * typed `Observation` and must not repeat these checks.
 */

import type {
  EvidenceKind,
  Observation,
  ObservationGap,
  ObservationSource,
} from './types.js';

const EVIDENCE_KINDS: readonly EvidenceKind[] = ['seen', 'contact', 'confirmed_effect'];
const OBSERVATION_SOURCES: readonly ObservationSource[] = ['vision', 'agent_action', 'local_rescan'];
const GAP_REASONS: readonly ObservationGap['reason'][] = [
  'out_of_view',
  'occluded',
  'too_dark',
  'unloaded',
  'budget_not_scanned',
  'unknown',
];

/** Validate one observation once, at the store boundary. Throws on malformed input. */
export function validateObservation(worldId: string, observation: Observation): void {
  if (observation === null || typeof observation !== 'object') {
    throw new Error('observation must be an object');
  }
  if (observation.worldId !== worldId) {
    throw new Error(
      `observation worldId "${observation.worldId}" does not match map worldId "${worldId}"`,
    );
  }
  if (typeof observation.dim !== 'string' || observation.dim.length === 0) {
    throw new Error('observation dim must be a non-empty string');
  }
  assertIntegerCoords(observation.pos?.x, observation.pos?.y, observation.pos?.z);
  if (!Number.isFinite(observation.observedAt)) {
    throw new Error(`observation observedAt must be a finite number: ${observation.observedAt}`);
  }
  if (observation.observedWorldTick !== undefined && !Number.isFinite(observation.observedWorldTick)) {
    throw new Error(`observation observedWorldTick must be a finite number: ${observation.observedWorldTick}`);
  }
  const state = observation.state;
  if (state === null || typeof state !== 'object' || typeof state.name !== 'string' || state.name.length === 0) {
    throw new Error('observation state name must be a non-empty string');
  }
  const properties = state.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('observation state properties must be a string record');
  }
  for (const value of Object.values(properties)) {
    if (typeof value !== 'string') {
      throw new Error('observation state property values must be strings');
    }
  }
  if (typeof observation.stateComplete !== 'boolean') {
    throw new Error('observation stateComplete must be a boolean');
  }
  if (!EVIDENCE_KINDS.includes(observation.evidence)) {
    throw new Error(`observation evidence kind is not known: ${String(observation.evidence)}`);
  }
  if (!OBSERVATION_SOURCES.includes(observation.source)) {
    throw new Error(`observation source is not known: ${String(observation.source)}`);
  }
  if (typeof observation.sessionId !== 'string' || observation.sessionId.length === 0) {
    throw new Error('observation sessionId must be a non-empty string');
  }
  if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 0) {
    throw new Error(`observation sequence must be a non-negative safe integer: ${String(observation.sequence)}`);
  }
  if (observation.originObservationId !== undefined && !Number.isSafeInteger(observation.originObservationId)) {
    throw new Error('observation originObservationId must be a safe integer');
  }
  if (observation.actionId !== undefined && (typeof observation.actionId !== 'string' || observation.actionId.length === 0)) {
    throw new Error('observation actionId must be a non-empty string when present');
  }

  // Evidence semantics (design §3.2): a confirmed own-action effect must name the
  // verified action, and an agent_action observation must be such a confirmed
  // effect. Conversely, an actionId may only accompany confirmed_effect evidence —
  // temporal proximity is never enough to attribute a change to an action.
  if (observation.evidence === 'confirmed_effect' && observation.actionId === undefined) {
    throw new Error('confirmed_effect observation requires the verified actionId');
  }
  if (observation.actionId !== undefined && observation.evidence !== 'confirmed_effect') {
    throw new Error(`actionId is only valid with confirmed_effect evidence, got "${observation.evidence}"`);
  }
  if (observation.source === 'agent_action' && observation.evidence !== 'confirmed_effect') {
    throw new Error(`agent_action observation must be a confirmed_effect, got "${observation.evidence}"`);
  }
  // Contact proves contact/blockage, not the full state of an unseen block.
  // The host must acknowledge that the submitted state is incomplete.
  if (observation.evidence === 'contact' && observation.stateComplete) {
    throw new Error(
      'contact observation must be stateComplete=false: contact proves contact/blockage, not an unseen block state',
    );
  }
}

/** Validate one bounded gap. Gaps are diagnostics only — they never become cells. */
export function validateObservationGap(gap: ObservationGap): void {
  if (gap === null || typeof gap !== 'object') {
    throw new Error('observation gap must be an object');
  }
  assertIntegerCoords(gap.pos?.x, gap.pos?.y, gap.pos?.z);
  if (!GAP_REASONS.includes(gap.reason)) {
    throw new Error(`observation gap reason is not known: ${String(gap.reason)}`);
  }
}

export function assertIntegerCoords(x: number, y: number, z: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    throw new Error(`coordinates must be integer grid coordinates: (${x}, ${y}, ${z})`);
  }
}
