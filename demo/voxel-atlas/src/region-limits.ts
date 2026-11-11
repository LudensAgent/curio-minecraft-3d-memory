export const REGION_LIMITS = {
  standard: { maxRadius: 96, maxSections: 512, maxPayloadBytes: 64 * 1024 * 1024, maxObservedCells: 200_000 },
  expanded: { maxRadius: 128, maxSections: 768, maxPayloadBytes: 96 * 1024 * 1024, maxObservedCells: 300_000 },
} as const;

export type RegionLimitPreset = keyof typeof REGION_LIMITS;
export const DEFAULT_REGION_LIMIT_PRESET: RegionLimitPreset = 'expanded';
