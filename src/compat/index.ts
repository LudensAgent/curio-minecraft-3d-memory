/**
 * Compatibility layer for Curio's legacy `WorldMemory` / `TravelStore` entry
 * points (design §8, §9.1).
 *
 * Responsibilities once implemented:
 * - `JsonWorldMemoryBackend` so old queries (`{"kind":"passages"}` pagination,
 *   `findLandmark`, `recallChests`, `hazardAt`, …) keep byte-identical output.
 * - Keep legacy pure functions in `src/memory/passages.ts`
 *   (`passageRoute` / `passageSurfaceAnchor` / `passageDeepestAnchor` /
 *   `passageFragmentation`) as shims over the new store.
 * - Preserve stable IDs (passage `psg_…`, landmark id, chest key
 *   `worldId:dim:x,y,z`, portal endpoint id) and coordinate/scope semantics.
 * - Route new `NavResult` through the legacy `SkillResult` shell
 *   (`data.nav`), without redefining existing action completion conditions.
 *
 * No implementation is present yet; this module is the documented seam.
 */
