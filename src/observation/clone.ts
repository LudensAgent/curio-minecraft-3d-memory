/**
 * Deep-copy helpers for observations and evidence.
 *
 * Observations cross the perception boundary and are stored by value; callers
 * must never be able to mutate a queued or stored fact through the object they
 * handed in.
 */

import type { CellEvidence, Observation, ObservationGap } from './types.js';

/** Deep-copy an observation so a snapshot never aliases caller/store objects. */
export function cloneObservation(observation: Observation): Observation {
  return {
    ...observation,
    pos: { x: observation.pos.x, y: observation.pos.y, z: observation.pos.z },
    state: { name: observation.state.name, properties: { ...observation.state.properties } },
  };
}

/** Deep-copy cell evidence. */
export function cloneCellEvidence(evidence: CellEvidence): CellEvidence {
  return { ...evidence, observation: cloneObservation(evidence.observation) };
}

/** Clone a gap so callers can never mutate a stored report. */
export function cloneObservationGap(gap: ObservationGap): ObservationGap {
  return { pos: { x: gap.pos.x, y: gap.pos.y, z: gap.pos.z }, reason: gap.reason };
}
