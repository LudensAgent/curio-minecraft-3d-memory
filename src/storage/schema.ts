/**
 * SQLite schema contract (design §9).
 *
 * Table names and their responsibilities are declared here as the stable
 * persistence surface. The concrete DDL, forward migrations and the ledger
 * codecs live in `sqlite/worker.ts` (schema v5) behind the single persistence
 * worker; the driver is `better-sqlite3` (§9.2), so the root public entry stays
 * native-free.
 */

export const TABLE_NAMES = {
  /** Format/schema metadata (single authority for the database schema version). */
  schemaMeta: 'schema_meta',
  /** Per-world checkpoint metadata (checkpoint id, world, captured revisions, order). */
  checkpoints: 'checkpoints',
  /** Sparse section recent state + evidence: palette, bit-pack, bitmaps, per-cell metadata. */
  spatialSections: 'spatial_sections',
  /** Historical path geometry (delta-encoded polylines). */
  pathFragments: 'path_fragments',
  /** Confirmed traversal evidence records (phase 5A; a separate table, not stored as evidence ids only). */
  traversalEvidence: 'traversal_evidence',
  /** Place anchors and route connections. */
  spatialNodes: 'spatial_nodes',
  spatialEdges: 'spatial_edges',
  /** Append-only spatial evidence events (observed cell change / observation gap). */
  spatialEvents: 'spatial_events',
  /** Append-only delegated action records, including the original NavResult when supplied. */
  actionRecords: 'action_records',
  /** Existing placement ledger (name / LRU order / delete semantics). */
  placedBlocks: 'placed_blocks',
  /** Visit counts / novelty (not observation time). */
  chunkVisits: 'chunk_visits',
  /** Raw portal traversal evidence and out-and-back verifications. */
  portalTraversals: 'portal_traversals',
} as const;
