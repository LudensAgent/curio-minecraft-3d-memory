/**
 * Pure memory-core exports.
 *
 * This barrel must stay free of navigation, execution and adapter-body ports.
 * The package-level `./memory` entry is added in a later milestone (M5); this
 * module exists now so the write/change ports have a navigation-free home.
 */

export { CONTRACT_VERSION } from './capabilities.js';
export type {
  ContractVersion,
  MemoryHostCapabilities,
} from './capabilities.js';
export type {
  ChangeReportErrorHandler,
  ChangeReportSink,
  ChangeReportSource,
  ChangeReportSubscriptionOptions,
} from './change-reports.js';
export type { MemoryIngest, SpatialEdgeRecord } from './ingest.js';
