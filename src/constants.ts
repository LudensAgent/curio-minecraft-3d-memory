/**
 * Single-source configuration constants.
 *
 * Design §3.1 / §4 require these thresholds to live in exactly one place.
 */

/** Edge length of a voxel Section (a 16×16×16 cube). */
export const SECTION_SIZE = 16;

/** Number of cells in one Section. */
export const SECTION_CELL_COUNT = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE; // 4096

/** Palette index reserved for air; cell data must never default to it as "known air". */
export const AIR_PALETTE_INDEX = 0;

/**
 * Version of the persisted voxel-section payload (design §4 / §9).
 *
 * - v1 (previous): per-cell evidence embedded a full blockstate, no history bitmaps.
 * - v2: palette + packed cells + history/risk bitmaps + compact per-cell metadata;
 *   the blockstate is reconstructed from the palette on restore.
 */
export const VOXEL_SECTION_PAYLOAD_VERSION = 2;

/**
 * Version of the in-memory checkpoint snapshot emitted by `VoxelMap`. v1 snapshots
 * (and payloads decoded from them) are still accepted by the restore path; fields
 * introduced in v2 (`traversed` / `modified` / `risk` bitmaps) default to empty.
 */
export const VOXEL_SNAPSHOT_SCHEMA_VERSION = 2;
