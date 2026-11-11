import type { CellEvidence } from './types.js';

/**
 * Spatial evidence does not age. A cell stops counting as current evidence only
 * when an own action's effect on it is still unconfirmed (`pending_effect`) or
 * observations contradict each other (`conflict`). Elapsed time, session changes,
 * interruptions and restores do not: a later observation simply overwrites it.
 */
export function evidenceStale(evidence: Readonly<CellEvidence>): boolean {
  return evidence.freshness === 'STALE'
    && (evidence.staleReason === 'pending_effect' || evidence.staleReason === 'conflict');
}
