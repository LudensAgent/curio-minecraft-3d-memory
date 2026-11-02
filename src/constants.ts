/**
 * Single-source configuration constants.
 *
 * Design §3.1 / §4 require these thresholds to live in exactly one place —
 * history shows duplicated magic numbers (e.g. the passage-link distance)
 * drifting apart across `touchesPassage` / `bridgeNode` / `passageGraph`.
 */

/** Edge length of a voxel Section (a 16×16×16 cube). */
export const SECTION_SIZE = 16;

/** Number of cells in one Section. */
export const SECTION_CELL_COUNT = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE; // 4096

/** Palette index reserved for air; cell data must never default to it as "known air". */
export const AIR_PALETTE_INDEX = 0;

/**
 * Distance threshold (in blocks) used to associate nearby geometry as the *same*
 * path fragment. It is a candidate-matching hint only — it never fabricates a
 * traversed `links` edge between positions that were not actually walked.
 */
export const PASSAGE_LINK = 3.5;
