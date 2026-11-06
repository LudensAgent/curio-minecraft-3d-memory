/**
 * Change-report forwarding (implementation plan M1.6, contract §8.1).
 *
 * Every accepted observation or lifecycle change produces a localized
 * `ChangeReport`. The host must hand that report to the active verifier/executor
 * before the next control step; this module defines the narrow port used to do
 * so without importing the navigation or execution layers.
 */

import type {
  ChangeReportListener,
  ChangeReportSubscriptionOptions,
} from '../voxel/voxel-map.js';

export type {
  ChangeReportErrorHandler,
  ChangeReportSubscriptionOptions,
} from '../voxel/voxel-map.js';

/**
 * Synchronous consumer of accepted-change reports.
 *
 * Delivery happens after the local evidence and revision are updated but before
 * the write call returns. Implementations must be fast and must not perform
 * hidden world reads; a report is an invalidation notice, not a world fact.
 *
 * The alias keeps the write-port vocabulary from the implementation plan while
 * `VoxelMap` and its options use the same underlying function type.
 */
export type ChangeReportSink = ChangeReportListener;

/** Source of accepted-change reports. */
export interface ChangeReportSource {
  /**
   * Register a sink for accepted-change reports. Empty reports are not
   * delivered. The returned function unsubscribes and is safe to call twice.
   */
  subscribeChanges(
    sink: ChangeReportSink,
    options?: ChangeReportSubscriptionOptions,
  ): () => void;
}
