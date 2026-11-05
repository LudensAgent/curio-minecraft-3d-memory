/**
 * Compatibility layer for Curio's legacy `WorldMemory` / `TravelStore` entry
 * points (design §8, §9.1).
 *
 * Implemented here:
 * - `legacy.ts`: read-only projection of a caller-validated JSON-shaped
 *   snapshot (`{"kind":"passages"}` pagination, legacy `passageRoute`, landmark
 *   and container/farm/placed/travel fields) with explicit deletion tombstones.
 * - `migration-dry-run.ts`: offline A–D rehearsal that imports the passage
 *   geometry batch into a caller-provided temporary SQLite database and checks
 *   IDs, fields, order, coordinates, original times and deletion semantics.
 *
 * Still not implemented: the live `JsonWorldMemoryBackend`, real migration
 * execution, persistence-authority switching, removal of the legacy write path,
 * and wiring new `NavResult` through the legacy `SkillResult` shell. The dry run
 * reports those as not performed and never claims real data was migrated.
 */

export * from './legacy.js';
export * from './migration-dry-run.js';
