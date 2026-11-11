export const REGION_LIMITS = {
  standard: { maxRadius: 96, maxSections: 512, maxPayloadBytes: 64 * 1024 * 1024, maxObservedCells: 200_000 },
  expanded: { maxRadius: 512, maxSections: 3_072, maxPayloadBytes: 384 * 1024 * 1024, maxObservedCells: 1_200_000 },
} as const;

export type RegionLimitPreset = keyof typeof REGION_LIMITS;
export const DEFAULT_REGION_LIMIT_PRESET: RegionLimitPreset = 'expanded';
