/**
 * SQLite schema contract (design §9).
 *
 * Table names and their responsibilities are declared here as the stable
 * persistence surface. Actual DDL / migrations land in phase 5 alongside the
 * single persistence worker; the driver is `better-sqlite3` (§9.2), not wired
 * into this scaffold so the public entry stays native-free.
 */

export const TABLE_NAMES = {
  /** Sparse section recent state + evidence: palette, bit-pack, bitmaps, per-cell metadata. */
  spatialSections: 'spatial_sections',
  /** Historical path geometry (delta-encoded polylines). */
  pathFragments: 'path_fragments',
  /** Place anchors and route connections. */
  spatialNodes: 'spatial_nodes',
  spatialEdges: 'spatial_edges',
  /** Important spatial changes (block / clear / re-verify). */
  spatialEvents: 'spatial_events',
  /** Delegation, execution, result, consumption. */
  actionRecords: 'action_records',
  /** Existing placement ledger (name / LRU order / delete semantics). */
  placedBlocks: 'placed_blocks',
  /** Visit counts / novelty (not observation time). */
  chunkVisits: 'chunk_visits',
  /** Raw portal traversal evidence and out-and-back verifications. */
  portalTraversals: 'portal_traversals',
} as const;
